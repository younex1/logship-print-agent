/**
 * Job pipeline.
 *
 *   long-poll /jobs/next  →  per-queue workers (strict id order per queue, queues in parallel)
 *        → file inline or prefetched (4 parallel downloads) → `lp` → ack 'spooled'
 *        → CompletionTracker watches lpstat every 2 s → ack 'completed' | 'failed'
 *
 * Idempotency: every job handed to lp is recorded in the Ledger (job id → CUPS job id). A job the
 * server re-sends (claimed but never acked, e.g. after a crash) is acked from the ledger and never
 * printed twice.
 */
import { writeFile, unlink } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import { Api, ApiError, type AgentJob, type AckMsg } from './api.ts'
import { type AgentConfig, isEnrolled } from './config.ts'
import { Ledger } from './ledger.ts'
import { submit, pendingJobIds, completedJobIds } from './cups.ts'
import { buildHeartbeat } from './heartbeat.ts'
import { handleCommand } from './commands.ts'
import { scheduleBackups } from './backup.ts'
import { startSetupServer, type AgentState } from './setup-server.ts'
import { log, sleep } from './log.ts'

const SAFE_OPTION = /^[A-Za-z0-9=_.,:+\-]{1,80}$/

/** Same whitelist as the server's printDispatch — defence in depth on the device. */
export const tokenizeOptions = (options: string): string[] => {
  const out: string[] = []
  const t = String(options || '').trim().split(/\s+/).filter(Boolean)
  for (let i = 0; i < t.length; i++) {
    if (/^-(o|n|t|H|P|q)$/.test(t[i]) && t[i + 1] && SAFE_OPTION.test(t[i + 1])) { out.push(t[i], t[i + 1]); i++; continue }
    throw new Error(`unsafe print option: ${t[i]}`)
  }
  return out
}

class Downloader {
  private active = 0
  private waiting: (() => void)[] = []
  private api: Api
  private limit: number
  constructor(api: Api, limit = 4) { this.api = api; this.limit = limit }
  async fetch(job: AgentJob): Promise<Buffer> {
    if (job.content) return Buffer.from(job.content, 'base64')
    if (this.active >= this.limit) await new Promise<void>(r => this.waiting.push(r))
    this.active++
    try { return await this.api.file(job.id) } finally { this.active--; this.waiting.shift()?.() }
  }
}

interface Ctx { cfg: AgentConfig; api: Api; ledger: Ledger; dl: Downloader; tracker: CompletionTracker; state: AgentState; ack: (a: AckMsg) => void }

class QueueWorker {
  private pending: { job: AgentJob; file: Promise<Buffer> }[] = []
  private running = false
  private queue: string
  private ctx: Ctx
  constructor(queue: string, ctx: Ctx) { this.queue = queue; this.ctx = ctx }

  push(job: AgentJob) {
    if (this.pending.some(p => p.job.id === job.id)) return
    const file = this.ctx.dl.fetch(job)
    file.catch(() => { /* handled in loop */ })
    this.pending.push({ job, file })
    this.pending.sort((a, b) => a.job.id - b.job.id)
    if (!this.running) { this.running = true; this.loop().finally(() => { this.running = false }) }
  }

  private async loop() {
    while (this.pending.length) {
      const { job, file } = this.pending.shift()!
      await this.handle(job, file)
    }
  }

  private async handle(job: AgentJob, file: Promise<Buffer>) {
    const { cfg, ledger, tracker, state, ack } = this.ctx
    const known = ledger.get(job.id)
    if (known) {
      log.info(`job ${job.id} already spooled as ${known.cupsJobId} — ack only (resend)`)
      ack({ id: job.id, status: 'spooled', cupsJobId: known.cupsJobId, output: 'already spooled (idempotent resend)' })
      return
    }
    const target = path.join(cfg.spoolDir, `${job.id}-${job.fileName.replace(/[^A-Za-z0-9_.-]/g, '_')}`)
    try {
      const buf = await file
      await writeFile(target, buf)
      const tokens = tokenizeOptions(job.options)
      // Backpressure: never keep more than maxActivePerQueue jobs open in CUPS for this queue —
      // a burst of 800 labels is fed to the printer in slices, order preserved, CUPS limits never hit.
      let waited = 0
      while (tracker.outstandingFor(this.queue) >= cfg.maxActivePerQueue) {
        if (waited === 0) log.info(`${this.queue}: ${tracker.outstandingFor(this.queue)} jobs open in CUPS — waiting before job ${job.id}`)
        await sleep(500); waited += 500
      }
      let r = await submit(this.queue, tokens, target)
      // CUPS "Too many active jobs" / busy is transient: wait for completions and retry (up to 30 min)
      for (let attempt = 0; !r.ok && /too many active jobs|server-error-busy|temporarily/i.test(r.stderr || '') && attempt < 360; attempt++) {
        if (attempt === 0) log.warn(`${this.queue}: CUPS busy ("${(r.stderr || '').trim()}") — retrying job ${job.id} until the queue drains`)
        await sleep(5000)
        r = await submit(this.queue, tokens, target)
      }
      if (!r.ok) {
        const err = (r.stderr || r.stdout || 'lp failed').trim()
        log.warn(`job ${job.id} → ${this.queue}: lp FAILED: ${err}`)
        ack({ id: job.id, status: 'failed', output: r.stdout, error: err })
        state.recent(job, 'failed', err)
        await unlink(target).catch(() => {})
        return
      }
      ledger.add(job.id, r.requestId, this.queue, target)
      log.info(`job ${job.id} → ${this.queue} spooled as ${r.requestId} (${buf.length} B, ${job.options || 'no options'})`)
      ack({ id: job.id, status: 'spooled', cupsJobId: r.requestId, output: r.stdout.trim() })
      state.recent(job, 'spooled')
      tracker.track(job.id, r.requestId!, this.queue, target, job)
    } catch (e: any) {
      const err = e?.message || String(e)
      log.warn(`job ${job.id} → ${this.queue}: ${err}`)
      ack({ id: job.id, status: 'failed', error: err })
      state.recent(job, 'failed', err)
      await unlink(target).catch(() => {})
    }
  }
}

class CompletionTracker {
  private tracked = new Map<number, { cupsJobId: string; queue: string; file: string; since: number; job: AgentJob; missingSince?: number }>()
  private ack: (a: AckMsg) => void
  private state: AgentState
  private ledger: Ledger
  constructor(cfg: AgentConfig, ack: (a: AckMsg) => void, state: AgentState, ledger: Ledger) {
    this.ack = ack
    this.state = state
    this.ledger = ledger
    // Survive restarts: everything the ledger still has open goes straight back under observation.
    for (const { jobId, entry } of ledger.open()) {
      if (!entry.cupsJobId) { ledger.finish(jobId); continue }
      const job = { id: jobId, queue: entry.queue, fileName: path.basename(entry.file || ''), batchId: null, options: '', fileSize: 0, source: '', createdAt: '', attempt: 1, content: null, fileUrl: null }
      this.tracked.set(jobId, { cupsJobId: entry.cupsJobId, queue: entry.queue, file: entry.file || '', since: entry.ts, job })
    }
    if (this.tracked.size) log.info(`restored ${this.tracked.size} spooled job(s) from the ledger for completion tracking`)
    setInterval(() => this.tick().catch(e => log.warn('completion tick failed:', e?.message || e)), cfg.completionPollMs).unref()
  }
  track(jobId: number, cupsJobId: string, queue: string, file: string, job: AgentJob) {
    this.tracked.set(jobId, { cupsJobId, queue, file, since: Date.now(), job })
  }
  get outstanding() { return this.tracked.size }
  outstandingFor(queue: string) { let n = 0; for (const t of this.tracked.values()) if (t.queue === queue) n++; return n }
  private async tick() {
    if (!this.tracked.size) return
    const [pending, completed] = await Promise.all([pendingJobIds(), completedJobIds()])
    for (const [jobId, t] of this.tracked) {
      if (pending.has(t.cupsJobId)) { t.missingSince = undefined; continue }
      if (completed.has(t.cupsJobId)) {
        this.tracked.delete(jobId)
        this.ledger.finish(jobId)
        this.ack({ id: jobId, status: 'completed', cupsJobId: t.cupsJobId })
        this.state.recent(t.job, 'completed')
        if (t.file) unlink(t.file).catch(() => {})
        continue
      }
      // neither pending nor in the completed history: aborted/cancelled on the device (grace 10 s)
      t.missingSince = t.missingSince || Date.now()
      if (Date.now() - t.missingSince > 10_000) {
        this.tracked.delete(jobId)
        this.ledger.finish(jobId)
        const err = 'CUPS job vanished (cancelled or aborted on the device — printer offline / paper out?)'
        this.ack({ id: jobId, status: 'failed', cupsJobId: t.cupsJobId, error: err })
        this.state.recent(t.job, 'failed', err)
        if (t.file) unlink(t.file).catch(() => {})
      }
    }
  }
}

/** Collects acks for ~300 ms and sends them in one request (800-label batches = few calls). */
class AckBatcher {
  private buf: AckMsg[] = []
  private timer: NodeJS.Timeout | null = null
  private api: Api
  constructor(api: Api) { this.api = api }
  push(a: AckMsg) {
    this.buf.push(a)
    if (!this.timer) this.timer = setTimeout(() => this.flush(), 300)
  }
  async flush() {
    this.timer = null
    const batch = this.buf.splice(0, 500)
    if (!batch.length) return
    try { await this.api.ack(batch) } catch (e: any) {
      log.warn(`ack of ${batch.length} job(s) failed, retrying: ${e?.message || e}`)
      this.buf.unshift(...batch)
      this.timer = setTimeout(() => this.flush(), 3000)
    }
    if (this.buf.length && !this.timer) this.timer = setTimeout(() => this.flush(), 300)
  }
}

export const runService = async (cfg: AgentConfig) => {
  const state: AgentState = {
    cfg, version: undefined, enrolled: isEnrolled(cfg), connected: false, lastPoll: 0, lastHeartbeat: 0, lastError: '', queuedOnServer: 0,
    printers: [], recentJobs: [],
    recent(job, status, error) {
      this.recentJobs.unshift({ id: job.id, queue: job.queue, fileName: job.fileName, status, error, ts: Date.now() })
      if (this.recentJobs.length > 50) this.recentJobs.length = 50
    }
  }
  startSetupServer(state)

  if (!isEnrolled(cfg)) {
    log.warn(`not enrolled — open http://${os.hostname()}.local:${cfg.setupPort} (or run: logship-print-agent enroll --url … --code …)`)
    // stay alive so the setup page works; the enrol step restarts the service
    for (;;) await sleep(60_000)
  }

  const api = new Api(cfg.url, cfg.token)
  const ledger = new Ledger(cfg.stateDir)
  const acks = new AckBatcher(api)
  const ack = (a: AckMsg) => acks.push(a)
  const tracker = new CompletionTracker(cfg, ack, state, ledger)
  const ctx: Ctx = { cfg, api, ledger, dl: new Downloader(api, 4), tracker, state, ack }
  const workers = new Map<string, QueueWorker>()
  const worker = (q: string) => { let w = workers.get(q); if (!w) { w = new QueueWorker(q, ctx); workers.set(q, w) } return w }

  // heartbeat loop (also pushed immediately after a remote printer change)
  const cmdCtx = { refreshInventory: async () => { await heartbeat() } }
  const heartbeat = async () => {
    try {
      const body = await buildHeartbeat(cfg)
      state.printers = body.printers
      const res = await api.heartbeat(body)
      state.lastHeartbeat = Date.now()
      state.queuedOnServer = res.queued
      for (const c of res.commands || []) handleCommand(cfg, api, c, cmdCtx)
    } catch (e: any) {
      state.lastError = e?.message || String(e)
      log.warn('heartbeat failed:', state.lastError)
    }
  }
  heartbeat()
  setInterval(heartbeat, cfg.heartbeatSeconds * 1000).unref()
  if (cfg.backupEnabled) scheduleBackups(api)

  log.info(`LogShip Print Agent "${cfg.name}" connected to ${cfg.url} — long-poll ${cfg.pollWait}s / ${cfg.pollMax} jobs, heartbeat ${cfg.heartbeatSeconds}s`)
  let backoff = 1000
  for (;;) {
    try {
      const res = await api.next(cfg.pollWait, cfg.pollMax)
      state.connected = true
      state.lastPoll = Date.now()
      state.lastError = ''
      backoff = 1000
      for (const c of res.commands || []) handleCommand(cfg, api, c, cmdCtx)
      for (const j of res.jobs || []) worker(j.queue).push(j)
    } catch (e: any) {
      state.connected = false
      state.lastError = e?.message || String(e)
      if (e instanceof ApiError && e.unauthorized) {
        log.error(`instance rejected our token (${e.status}) — agent revoked? Re-enrol with a new code. Retrying in 60 s.`)
        await sleep(60_000)
        continue
      }
      log.warn(`poll failed (${state.lastError}), retry in ${Math.round(backoff / 1000)} s`)
      await sleep(backoff)
      backoff = Math.min(backoff * 2, 60_000)
    }
  }
}

/**
 * CUPS access — the agent runs the same `lp -d <queue> <options> <file>` the LogShip server used
 * to run locally. Everything else here is read-only inventory (lpstat / PPD) plus the optional
 * USB auto-provisioning (lpadmin) for label printers.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'

export interface RunResult { code: number; stdout: string; stderr: string }

export const run = (cmd: string, args: string[], timeoutMs = 15_000): Promise<RunResult> =>
  new Promise((resolve) => {
    execFile(cmd, args, { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8' }, (err: any, stdout: string, stderr: string) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || ''), stderr: String(stderr || err?.message || '') })
    })
  })

// ── media (copied from the ERP's server/utils/cupsMedia.ts) ─────────────────
export interface MediaMm { w: number; h: number }
const PT_TO_MM = 25.4 / 72
const NAMED: Record<string, MediaMm> = {
  a3: { w: 297, h: 420 }, a4: { w: 210, h: 297 }, a5: { w: 148, h: 210 }, a6: { w: 105, h: 148 }, a7: { w: 74, h: 105 }, a8: { w: 52, h: 74 },
  letter: { w: 215.9, h: 279.4 }, legal: { w: 215.9, h: 355.6 }
}
const r1 = (n: number) => Math.round(n * 10) / 10

export const parsePageSizeToken = (token: string): MediaMm | null => {
  const t = String(token || '').trim()
  if (!t) return null
  let m = /^Custom\.(\d+(?:\.\d+)?)x(\d+(?:\.\d+)?)(mm|cm|in|pt|m)?$/i.exec(t)
  if (m) {
    const unit = (m[3] || 'pt').toLowerCase()
    const f = unit === 'mm' ? 1 : unit === 'cm' ? 10 : unit === 'in' ? 25.4 : unit === 'm' ? 1000 : PT_TO_MM
    const w = r1(Number(m[1]) * f), h = r1(Number(m[2]) * f)
    return w > 0 && h > 0 ? { w, h } : null
  }
  m = /^w(\d+(?:\.\d+)?)h(\d+(?:\.\d+)?)$/i.exec(t)
  if (m) { const w = r1(Number(m[1]) * PT_TO_MM), h = r1(Number(m[2]) * PT_TO_MM); return w > 0 && h > 0 ? { w, h } : null }
  return NAMED[t.toLowerCase()] ? { ...NAMED[t.toLowerCase()] } : null
}

export const queueMedia = async (queue: string, ppdDir: string): Promise<MediaMm | null> => {
  const lo = await run('lpoptions', ['-p', queue])
  let m = /(?:^|\s)(?:media|PageSize)=(\S+)/.exec(lo.stdout)
  let media = m ? parsePageSizeToken(m[1]) : null
  if (!media) {
    try {
      const ppd = await readFile(path.join(ppdDir, `${queue}.ppd`), 'utf8')
      const d = /^\*DefaultPageSize:\s*(\S+)/m.exec(ppd)
      media = d ? parsePageSizeToken(d[1]) : null
    } catch { /* no PPD (driverless queues) */ }
  }
  if (!media) {
    const ll = await run('lpoptions', ['-p', queue, '-l'])
    const line = ll.stdout.split(/\r?\n/).find(l => /^(PageSize|media)\//i.test(l))
    const starred = line ? /\*(\S+)/.exec(line.split(':').slice(1).join(':')) : null
    media = starred ? parsePageSizeToken(starred[1]) : null
  }
  return media
}

const ppdField = async (queue: string, ppdDir: string, field: string): Promise<string> => {
  try {
    const ppd = await readFile(path.join(ppdDir, `${queue}.ppd`), 'utf8')
    const m = new RegExp(`^\\*${field}:\\s*"?([^"\\n]+)"?`, 'm').exec(ppd)
    return m ? m[1].trim() : ''
  } catch { return '' }
}

// ── inventory ───────────────────────────────────────────────────────────────
export interface QueueInfo {
  queue: string
  state: string
  accepting: boolean
  deviceUri: string
  makeModel: string
  media: MediaMm | null
  jobs: number
}

export const listQueues = async (ppdDir: string): Promise<QueueInfo[]> => {
  const [p, a, v, depth] = await Promise.all([run('lpstat', ['-p']), run('lpstat', ['-a']), run('lpstat', ['-v']), queueDepth()])
  const queues = new Map<string, QueueInfo>()
  for (const line of p.stdout.split(/\r?\n/)) {
    const m = /^printer (\S+) (.+)$/.exec(line.trim())
    if (!m) continue
    const rest = m[2]
    const state = /disabled/i.test(rest) ? 'disabled' : /is printing/i.test(rest) ? 'printing' : /is idle/i.test(rest) ? 'idle' : rest.slice(0, 40)
    queues.set(m[1], { queue: m[1], state, accepting: true, deviceUri: '', makeModel: '', media: null, jobs: depth[m[1]] || 0 })
  }
  for (const line of a.stdout.split(/\r?\n/)) {
    const m = /^(\S+) (accepting|not accepting)/.exec(line.trim())
    if (m && queues.has(m[1])) queues.get(m[1])!.accepting = m[2] === 'accepting'
  }
  for (const line of v.stdout.split(/\r?\n/)) {
    const m = /^device for (\S+): (.+)$/.exec(line.trim())
    if (m && queues.has(m[1])) queues.get(m[1])!.deviceUri = m[2].trim()
  }
  for (const q of queues.values()) {
    q.media = await queueMedia(q.queue, ppdDir)
    q.makeModel = (await ppdField(q.queue, ppdDir, 'NickName')) || (await ppdField(q.queue, ppdDir, 'ModelName'))
  }
  return [...queues.values()].sort((x, y) => x.queue.localeCompare(y.queue, undefined, { numeric: true }))
}

/** job id "labelprinter-1-123" → queue "labelprinter-1" */
export const queueOfJobId = (id: string) => id.slice(0, id.lastIndexOf('-'))

const jobIdsFrom = (stdout: string): Set<string> => {
  const ids = new Set<string>()
  for (const line of stdout.split(/\r?\n/)) {
    const m = /^(\S+-\d+)\s/.exec(line.trim())
    if (m) ids.add(m[1])
  }
  return ids
}

export const pendingJobIds = async (): Promise<Set<string>> => jobIdsFrom((await run('lpstat', ['-o'])).stdout)
export const completedJobIds = async (): Promise<Set<string>> => jobIdsFrom((await run('lpstat', ['-W', 'completed', '-o'])).stdout)

export const queueDepth = async (): Promise<Record<string, number>> => {
  const out: Record<string, number> = {}
  for (const id of await pendingJobIds()) { const q = queueOfJobId(id); out[q] = (out[q] || 0) + 1 }
  return out
}

// ── printing ────────────────────────────────────────────────────────────────
export interface SubmitResult { ok: boolean; requestId: string | null; stdout: string; stderr: string }

export const submit = async (queue: string, optionTokens: string[], file: string): Promise<SubmitResult> => {
  const args = [...(queue ? ['-d', queue] : []), ...optionTokens, file]
  const r = await run('lp', args, 60_000)
  const m = /request id is (\S+)/i.exec(r.stdout)
  return { ok: r.code === 0 && !!m, requestId: m ? m[1] : null, stdout: r.stdout, stderr: r.stderr }
}

export const cancelAll = () => run('cancel', ['-a'])
export const restartCups = () => run('systemctl', ['restart', 'cups'], 60_000)
export const lpstatAll = () => run('lpstat', ['-t'])

// ── USB auto-provisioning ───────────────────────────────────────────────────
export interface UsbPrinter { uri: string; make: string; model: string; serial: string }

export const discoverUsbPrinters = async (): Promise<UsbPrinter[]> => {
  const r = await run('lpinfo', ['-v'], 20_000)
  const out: UsbPrinter[] = []
  for (const line of r.stdout.split(/\r?\n/)) {
    const m = /^direct (usb:\/\/\S+)/.exec(line.trim())
    if (!m) continue
    const uri = m[1]
    const u = /^usb:\/\/([^/]+)\/([^?]+)(?:\?serial=([^&]+))?/.exec(uri)
    out.push({ uri, make: decodeURIComponent(u?.[1] || ''), model: decodeURIComponent(u?.[2] || '').replace(/%20/g, ' '), serial: decodeURIComponent(u?.[3] || '') })
  }
  return out
}

/**
 * Creates `labelprinter-<n>` queues for USB printers of the configured makes that have no queue
 * yet (matched by device URI). Returns the queue names created.
 */
export const autoProvisionUsb = async (makes: string[], driver: string, ppdDir: string): Promise<string[]> => {
  const printers = (await discoverUsbPrinters()).filter(p => makes.some(mk => p.make.toLowerCase().includes(mk.toLowerCase())))
  if (!printers.length) return []
  const existing = await listQueues(ppdDir)
  const usedUris = new Set(existing.map(q => q.deviceUri))
  const usedNames = new Set(existing.map(q => q.queue))
  const created: string[] = []
  for (const p of printers) {
    if (usedUris.has(p.uri)) continue
    let n = 1
    while (usedNames.has(`labelprinter-${n}`)) n++
    const name = `labelprinter-${n}`
    const r = await run('lpadmin', ['-p', name, '-E', '-v', p.uri, '-m', driver, '-o', 'printer-is-shared=false', '-D', `${p.make} ${p.model}`.trim()], 60_000)
    if (r.code === 0) { created.push(name); usedNames.add(name); usedUris.add(p.uri) }
  }
  return created
}

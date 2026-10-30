/**
 * Idempotency ledger: LogShip job id → CUPS job id of what we already handed to `lp`.
 * The server re-sends a job that was claimed but never acked (agent crash, network loss);
 * the ledger makes a resend a no-op, so nothing prints twice. Persisted as JSON in STATE_DIR.
 */
import { existsSync, readFileSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'

interface Entry { cupsJobId: string | null; queue: string; ts: number; file?: string }

export class Ledger {
  private file: string
  private spooled: Record<string, Entry> = {}
  private dirty = false
  private cap: number

  constructor(stateDir: string, cap = 5000) {
    this.cap = cap
    this.file = path.join(stateDir, 'ledger.json')
    try {
      if (existsSync(this.file)) this.spooled = JSON.parse(readFileSync(this.file, 'utf8'))?.spooled || {}
    } catch { this.spooled = {} }
    setInterval(() => this.flush(), 2000).unref()
  }

  has(jobId: number) { return Object.prototype.hasOwnProperty.call(this.spooled, String(jobId)) }
  get(jobId: number): Entry | undefined { return this.spooled[String(jobId)] }

  add(jobId: number, cupsJobId: string | null, queue: string, file?: string) {
    this.spooled[String(jobId)] = { cupsJobId, queue, ts: Date.now(), file }
    const keys = Object.keys(this.spooled)
    if (keys.length > this.cap) {
      keys.sort((a, b) => this.spooled[a].ts - this.spooled[b].ts).slice(0, keys.length - this.cap).forEach(k => { delete this.spooled[k] })
    }
    this.dirty = true
  }

  flush() {
    if (!this.dirty) return
    this.dirty = false
    try {
      const tmp = this.file + '.tmp'
      writeFileSync(tmp, JSON.stringify({ spooled: this.spooled }))
      renameSync(tmp, this.file)
    } catch { this.dirty = true }
  }
}

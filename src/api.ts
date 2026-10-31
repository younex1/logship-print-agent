/**
 * HTTP client for the LogShip instance (server/api/print-agent/* in the ERP repo).
 * All traffic is outbound HTTPS from the tenant LAN; nothing listens on the WAN side.
 */
import { VERSION } from './config.ts'

export class ApiError extends Error {
  status: number
  body?: any
  constructor(status: number, message: string, body?: any) { super(message); this.status = status; this.body = body }
  get unauthorized() { return this.status === 401 || this.status === 403 }
}

export interface AgentJob {
  id: number
  batchId: string | null
  queue: string
  options: string
  fileName: string
  fileSize: number
  source: string
  createdAt: string
  attempt: number
  /** base64 PDF when ≤ inline limit */
  content: string | null
  fileUrl: string | null
}

export interface AgentCommandMsg { id: number; command: string; payload: any }

export interface AckMsg { id: number; status: 'spooled' | 'completed' | 'failed'; cupsJobId?: string | null; output?: string | null; error?: string | null }

const ua = `logship-print-agent/${VERSION} (node ${process.version})`

export class Api {
  private url: string
  private token: string
  constructor(url: string, token: string) { this.url = url; this.token = token }

  private async req<T = any>(method: string, path: string, body?: any, opts: { timeoutMs?: number; raw?: boolean; auth?: boolean } = {}): Promise<T> {
    const headers: Record<string, string> = { 'User-Agent': ua, Accept: 'application/json' }
    if (opts.auth !== false) headers.Authorization = `Bearer ${this.token}`
    if (body !== undefined) headers['Content-Type'] = 'application/json'
    const res = await fetch(this.url + path, {
      method, headers, body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000)
    })
    if (!res.ok) {
      let detail: any = null
      try { detail = await res.json() } catch { try { detail = await res.text() } catch { /* ignore */ } }
      throw new ApiError(res.status, `${method} ${path} → ${res.status} ${detail?.statusMessage || detail?.message || res.statusText}`, detail)
    }
    if (opts.raw) return Buffer.from(await res.arrayBuffer()) as any
    return (await res.json()) as T
  }

  static async enroll(url: string, code: string, meta: { name?: string; hostname?: string; platform?: string; version?: string }) {
    const api = new Api(url.replace(/\/+$/, ''), '')
    return api.req<{ ok: boolean; agentId: number; token: string; name: string; clientId: number; orgId: number; instance: any; poll: any }>(
      'POST', '/api/print-agent/enroll', { code, ...meta }, { auth: false })
  }

  heartbeat(body: any) {
    return this.req<{ ok: boolean; serverTime: string; queued: number; commands: AgentCommandMsg[]; supportUntil: string | null }>('POST', '/api/print-agent/heartbeat', body)
  }

  next(wait: number, max: number, fresh = false) {
    return this.req<{ jobs: AgentJob[]; commands: AgentCommandMsg[]; reconcile?: { id: number; cupsJobId: string | null; queue: string }[] }>('GET', `/api/print-agent/jobs/next?wait=${wait}&max=${max}${fresh ? '&fresh=1' : ''}`, undefined, { timeoutMs: wait * 1000 + 15_000 })
  }

  file(id: number): Promise<Buffer> {
    return this.req<Buffer>('GET', `/api/print-agent/jobs/${id}/file`, undefined, { raw: true, timeoutMs: 120_000 })
  }

  ack(acks: AckMsg[]) {
    if (!acks.length) return Promise.resolve({ ok: true, results: [] })
    return this.req<{ ok: boolean; results: any[] }>('POST', '/api/print-agent/jobs/ack', { acks })
  }

  commandResult(id: number, ok: boolean, result: string) {
    // text results are kept short; an HTTP relay result (CUPS page, image) may be several MB
    return this.req('POST', `/api/print-agent/commands/${id}/result`, { ok, result: String(result || '').slice(0, 8 * 1024 * 1024) }, { timeoutMs: 60_000 })
  }

  uploadBackup(tar: Buffer) {
    return this.req('POST', '/api/print-agent/backup', { tarBase64: tar.toString('base64') }, { timeoutMs: 120_000 })
  }

  async downloadBackup(): Promise<Buffer | null> {
    try { return await this.req<Buffer>('GET', '/api/print-agent/backup', undefined, { raw: true, timeoutMs: 120_000 }) } catch (e: any) {
      if (e instanceof ApiError && e.status === 404) return null
      throw e
    }
  }
}

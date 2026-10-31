/**
 * Agent configuration — /etc/logship-print-agent/agent.env (KEY=VALUE), overridable by real
 * environment variables. The enrol step writes LOGSHIP_URL / LOGSHIP_AGENT_TOKEN into that file.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'

declare const __VERSION__: string | undefined
export const VERSION: string = (typeof __VERSION__ !== 'undefined' && __VERSION__) ? __VERSION__ : (process.env.LOGSHIP_AGENT_VERSION || 'dev')

export const ENV_FILE = process.env.LOGSHIP_AGENT_ENV || '/etc/logship-print-agent/agent.env'

export interface AgentConfig {
  envFile: string
  /** LogShip instance origin, e.g. https://erp.tenant.example */
  url: string
  token: string
  name: string
  stateDir: string
  spoolDir: string
  pollWait: number
  pollMax: number
  heartbeatSeconds: number
  completionPollMs: number
  /** max jobs the agent keeps open in CUPS per queue before it waits (backpressure) */
  maxActivePerQueue: number
  setupPort: number
  setupBind: string
  autoProvisionUsb: boolean
  /** comma list of USB printer makes that get a CUPS queue automatically */
  autoProvisionMakes: string[]
  autoProvisionDriver: string
  ppdDir: string
  backupEnabled: boolean
  supportUnit: string
  /** local CUPS admin (lpadmin group) the HTTP relay signs in with — created by the installer */
  cupsAdminUser: string
  cupsAdminPass: string
  /** hard switches on the device itself (customer policy); LogShip has the same per-box toggles */
  allowHttpRelay: boolean
  allowSupportTunnel: boolean
}

export const parseEnvFile = (text: string): Record<string, string> => {
  const out: Record<string, string> = {}
  for (const raw of String(text || '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1)
    out[key] = val
  }
  return out
}

export const readEnvFile = (file = ENV_FILE): Record<string, string> => {
  try { return existsSync(file) ? parseEnvFile(readFileSync(file, 'utf8')) : {} } catch { return {} }
}

/** Merges `updates` into the env file (keeps comments/other keys), mode 600. */
export const writeEnvFile = (updates: Record<string, string>, file = ENV_FILE) => {
  const dir = path.dirname(file)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const existing = existsSync(file) ? readFileSync(file, 'utf8').split(/\r?\n/) : []
  const seen = new Set<string>()
  const lines = existing.map((raw) => {
    const m = /^\s*([A-Z0-9_]+)\s*=/.exec(raw)
    if (m && updates[m[1]] !== undefined) { seen.add(m[1]); return `${m[1]}=${updates[m[1]]}` }
    return raw
  })
  for (const [k, v] of Object.entries(updates)) if (!seen.has(k)) lines.push(`${k}=${v}`)
  writeFileSync(file, lines.filter((l, i, a) => !(l === '' && i === a.length - 1)).join('\n') + '\n', { mode: 0o600 })
  try { chmodSync(file, 0o600) } catch { /* not root */ }
}

const bool = (v: any, d: boolean) => v === undefined || v === '' ? d : !['0', 'false', 'no', 'off'].includes(String(v).toLowerCase())
const num = (v: any, d: number) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : d }

export const loadConfig = (): AgentConfig => {
  const f = readEnvFile()
  const get = (k: string, d = '') => (process.env[k] ?? f[k] ?? d)
  const stateDir = get('STATE_DIR', '/var/lib/logship-print-agent')
  const cfg: AgentConfig = {
    envFile: ENV_FILE,
    url: get('LOGSHIP_URL').replace(/\/+$/, ''),
    token: get('LOGSHIP_AGENT_TOKEN'),
    name: get('LOGSHIP_AGENT_NAME', 'Print-Agent'),
    stateDir,
    spoolDir: get('SPOOL_DIR', path.join(stateDir, 'spool')),
    pollWait: Math.min(num(get('POLL_WAIT'), 25), 25),
    pollMax: Math.min(num(get('POLL_MAX'), 50), 100),
    heartbeatSeconds: num(get('HEARTBEAT_SECONDS'), 60),
    completionPollMs: num(get('COMPLETION_POLL_MS'), 2000),
    maxActivePerQueue: Math.min(num(get('MAX_ACTIVE_PER_QUEUE'), 40), 400),
    setupPort: num(get('SETUP_PORT'), 8080),
    setupBind: get('SETUP_BIND', '0.0.0.0'),
    autoProvisionUsb: bool(get('AUTO_PROVISION_USB'), true),
    autoProvisionMakes: get('AUTO_PROVISION_MAKES', 'Zebra').split(',').map(s => s.trim()).filter(Boolean),
    autoProvisionDriver: get('AUTO_PROVISION_DRIVER', 'drv:///sample.drv/zebra.ppd'),
    ppdDir: get('CUPS_PPD_DIR', '/etc/cups/ppd'),
    backupEnabled: bool(get('BACKUP_ENABLED'), true),
    supportUnit: get('SUPPORT_UNIT', 'logship-print-support.service'),
    cupsAdminUser: get('CUPS_ADMIN_USER', ''),
    cupsAdminPass: get('CUPS_ADMIN_PASS', ''),
    allowHttpRelay: bool(get('ALLOW_HTTP_RELAY'), true),
    allowSupportTunnel: bool(get('ALLOW_SUPPORT_TUNNEL'), true)
  }
  for (const d of [cfg.stateDir, cfg.spoolDir]) { try { if (!existsSync(d)) mkdirSync(d, { recursive: true }) } catch { /* read-only dev run */ } }
  return cfg
}

export const isEnrolled = (cfg: AgentConfig) => !!(cfg.url && cfg.token)

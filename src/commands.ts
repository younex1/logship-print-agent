/**
 * Commands queued in LogShip (Settings → Printers → Print-Agents) and delivered with the next
 * poll/heartbeat. The result is posted back and shown in LogShip.
 *
 * Remote printer administration (no VPN needed): discover-printers (lpinfo -v / curated lpinfo -m /
 * ippfind), add-printer (lpadmin), remove-printer, set-queue-option (lpoptions), queue-control
 * (enable/disable/accept/reject/cancel), test-print. After a change the agent pushes a fresh
 * inventory heartbeat immediately so LogShip shows the new queue within a second or two.
 */
import { existsSync } from 'node:fs'
import { writeFile } from 'node:fs/promises'
import { run, lpstatAll, restartCups, cancelAll, submit, listQueues } from './cups.ts'
import type { Api, AgentCommandMsg } from './api.ts'
import type { AgentConfig } from './config.ts'
import { createCupsBackup } from './backup.ts'
import { log } from './log.ts'

const trim = (s: string, n = 18000) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s)

const SAFE_QUEUE = /^[A-Za-z0-9_.-]{1,64}$/
const SAFE_URI = /^[a-z0-9+.-]+:\/\/[^\s"'`;&|<>$\\]{1,300}$/i
const SAFE_DRIVER = /^[A-Za-z0-9_.:/+ ()-]{1,200}$/
const SAFE_OPTION_KEY = /^[A-Za-z0-9_.-]{1,40}$/
const SAFE_OPTION_VALUE = /^[A-Za-z0-9=_.,:+-]{1,80}$/
const SAFE_TEXT = (s: any, n = 120) => String(s ?? '').replace(/[^\p{L}\p{N} _.,()/#+:-]/gu, '').slice(0, n)

/** Curated driver list: the models a LogShip site realistically meets + the generic ones. */
const DRIVER_FILTER = /everywhere|zebra|dymo|brother|tsc|godex|citizen|sato|bixolon|intermec|datamax|generic|postscript|pcl|raw|cups-pdf/i

export interface CommandCtx { refreshInventory?: () => Promise<void> }

/**
 * HTTP relay to the local CUPS web interface: LogShip forwards the admin's browser request
 * (method, path, a few headers, body) and renders the response — the CUPS GUI appears inside
 * LogShip without any inbound connectivity. Admin pages are signed in with the local lpadmin
 * credential from agent.env, so no CUPS password ever leaves the box.
 */
const relayHttp = async (cfg: AgentConfig, p: any) => {
  const method = String(p?.method || 'GET').toUpperCase()
  if (!/^(GET|POST|HEAD)$/.test(method)) throw new Error('method not allowed')
  const path = String(p?.path || '/')
  if (!path.startsWith('/') || path.startsWith('//') || /[\s]/.test(path)) throw new Error('invalid path')
  const headers: Record<string, string> = { 'User-Agent': 'logship-print-agent-relay' }
  for (const k of ['content-type', 'accept', 'cookie', 'accept-language']) {
    const v = p?.headers?.[k]
    if (v) headers[k] = String(v).slice(0, 4000)
  }
  if (cfg.cupsAdminUser && cfg.cupsAdminPass) headers.Authorization = 'Basic ' + Buffer.from(`${cfg.cupsAdminUser}:${cfg.cupsAdminPass}`).toString('base64')
  const body = p?.bodyBase64 ? Buffer.from(String(p.bodyBase64), 'base64') : undefined
  const res = await fetch('http://127.0.0.1:631' + path, { method, headers, body, redirect: 'manual', signal: AbortSignal.timeout(20_000) })
  const buf = Buffer.from(await res.arrayBuffer())
  if (buf.length > 5 * 1024 * 1024) throw new Error('response too large')
  const outHeaders: Record<string, string> = {}
  for (const k of ['content-type', 'location', 'cache-control', 'last-modified', 'etag']) { const v = res.headers.get(k); if (v) outHeaders[k] = v }
  const setCookies: string[] = typeof (res.headers as any).getSetCookie === 'function' ? (res.headers as any).getSetCookie() : []
  return JSON.stringify({ status: res.status, headers: outHeaders, setCookies, bodyBase64: buf.toString('base64') })
}

const discoverPrinters = async () => {
  const [devs, drvs, ipp] = await Promise.all([run('lpinfo', ['-l', '-v'], 40_000), run('lpinfo', ['-m'], 40_000), run('ippfind', ['-T', '4'], 15_000)])
  // `lpinfo -l -v` → blocks: "Device: uri = … / class = … / info = … / make-and-model = … / device-id = …"
  const devices: any[] = []
  let cur: any = null
  for (const raw of devs.stdout.split(/\r?\n/)) {
    const line = raw.trim()
    if (line.startsWith('Device:')) { cur = {}; devices.push(cur); continue }
    const m = /^([a-z-]+)\s*=\s*(.*)$/.exec(line)
    if (cur && m) cur[m[1]] = m[2]
  }
  const drivers = drvs.stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l && DRIVER_FILTER.test(l)).slice(0, 400).map(l => {
    const sp = l.indexOf(' ')
    return sp > 0 ? { id: l.slice(0, sp), name: l.slice(sp + 1) } : { id: l, name: l }
  })
  const ippUris = ipp.stdout.split(/\r?\n/).map(l => l.trim()).filter(Boolean)
  return {
    devices: devices.filter(d => d.uri && !/^(file|cups-pdf):/.test(d.uri)).map(d => ({ uri: d.uri, class: d.class, info: d.info, makeModel: d['make-and-model'], deviceId: d['device-id'] })),
    ippEverywhere: ippUris,
    drivers,
    note: devs.code !== 0 ? devs.stderr : undefined
  }
}

const addPrinter = async (p: any) => {
  const queue = String(p?.queue || '').trim()
  const uri = String(p?.deviceUri || '').trim()
  const driver = String(p?.driver || 'everywhere').trim()
  if (!SAFE_QUEUE.test(queue)) throw new Error('invalid queue name (A-Z a-z 0-9 _ . -)')
  if (!SAFE_URI.test(uri)) throw new Error('invalid device URI')
  if (!SAFE_DRIVER.test(driver)) throw new Error('invalid driver id')
  const args = ['-p', queue, '-E', '-v', uri, '-o', 'printer-is-shared=false', '-o', 'printer-error-policy=retry-job']
  if (driver === 'raw') args.push('-m', 'raw')
  else args.push('-m', driver)
  if (p?.description) args.push('-D', SAFE_TEXT(p.description))
  if (p?.location) args.push('-L', SAFE_TEXT(p.location))
  const r = await run('lpadmin', args, 90_000)
  if (r.code !== 0) throw new Error(`lpadmin failed: ${r.stderr || r.stdout}`)
  const out: string[] = [`queue ${queue} created (${driver} @ ${uri})`]
  if (p?.media && SAFE_OPTION_VALUE.test(String(p.media))) {
    const o = await run('lpoptions', ['-p', queue, '-o', `media=${p.media}`], 20_000)
    out.push(o.code === 0 ? `default media ${p.media}` : `media option failed: ${o.stderr}`)
  }
  await run('cupsaccept', [queue]); await run('cupsenable', [queue])
  return out.join('\n')
}

const setQueueOptions = async (p: any) => {
  const queue = String(p?.queue || '').trim()
  if (!SAFE_QUEUE.test(queue)) throw new Error('invalid queue name')
  const opts = p?.options && typeof p.options === 'object' ? p.options : {}
  const args = ['-p', queue]
  for (const [k, v] of Object.entries(opts)) {
    if (!SAFE_OPTION_KEY.test(k) || !SAFE_OPTION_VALUE.test(String(v))) throw new Error(`invalid option ${k}`)
    args.push('-o', `${k}=${v}`)
  }
  if (args.length === 2) throw new Error('no options given')
  const r = await run('lpoptions', args, 20_000)
  if (r.code !== 0) throw new Error(r.stderr || r.stdout)
  return `options set on ${queue}: ${Object.entries(opts).map(([k, v]) => `${k}=${v}`).join(' ')}`
}

const queueControl = async (p: any) => {
  const queue = String(p?.queue || '').trim()
  const action = String(p?.action || '')
  if (!SAFE_QUEUE.test(queue)) throw new Error('invalid queue name')
  const map: Record<string, string[]> = {
    enable: ['cupsenable', queue], disable: ['cupsdisable', queue], accept: ['cupsaccept', queue], reject: ['cupsreject', queue],
    'cancel-jobs': ['cancel', '-a', queue]
  }
  const cmd = map[action]
  if (!cmd) throw new Error('unknown action')
  const r = await run(cmd[0], cmd.slice(1), 20_000)
  if (r.code !== 0) throw new Error(r.stderr || r.stdout)
  return `${action} ${queue}: ok`
}

const testPrint = async (cfg: AgentConfig, p: any) => {
  const queue = String(p?.queue || '').trim()
  if (!SAFE_QUEUE.test(queue)) throw new Error('invalid queue name')
  let file = '/usr/share/cups/data/testprint'
  if (!existsSync(file)) {
    file = `${cfg.spoolDir}/testpage.txt`
    await writeFile(file, `LogShip Print Agent test page\nqueue: ${queue}\n${new Date().toISOString()}\n`)
  }
  const r = await submit(queue, ['-o', 'fit-to-page'], file)
  if (!r.ok) throw new Error(r.stderr || r.stdout || 'lp failed')
  return `test page sent to ${queue} (${r.requestId})`
}

export const handleCommand = async (cfg: AgentConfig, api: Api, c: AgentCommandMsg, ctx: CommandCtx = {}) => {
  log.info(`command #${c.id}: ${c.command}`)
  let ok = true
  let result = ''
  let inventoryChanged = false
  try {
    switch (c.command) {
      case 'lpstat': {
        const r = await lpstatAll()
        result = trim(r.stdout + (r.stderr ? '\n' + r.stderr : ''))
        break
      }
      case 'restart-cups': {
        const r = await restartCups()
        ok = r.code === 0
        result = ok ? 'cups restarted' : r.stderr
        inventoryChanged = true
        break
      }
      case 'cancel-all': {
        const r = await cancelAll()
        ok = r.code === 0
        result = r.stdout || r.stderr || 'all CUPS jobs cancelled'
        break
      }
      case 'journal': {
        const r = await run('journalctl', ['-u', 'logship-print-agent', '-n', '400', '--no-pager'], 30_000)
        result = trim(r.stdout || r.stderr)
        break
      }
      case 'update': {
        // detached: apt restarts this service from postinst, which would kill an inline run
        const r = await run('systemd-run', ['--unit=logship-print-agent-update', '--collect', '--description=LogShip Print Agent update',
          '/bin/sh', '-c', 'apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq --only-upgrade logship-print-agent'], 20_000)
        ok = r.code === 0
        result = ok ? 'update started (apt-get --only-upgrade logship-print-agent); the new version reports with the next heartbeat' : (r.stderr || r.stdout)
        break
      }
      case 'reboot': {
        const r = await run('systemd-run', ['--on-active=5', '--collect', 'systemctl', 'reboot'], 10_000)
        ok = r.code === 0
        result = ok ? 'reboot scheduled in 5 s' : r.stderr
        break
      }
      case 'backup-now': {
        const tar = await createCupsBackup()
        const up: any = await api.uploadBackup(tar)
        result = `uploaded /etc/cups backup, ${up?.bytes ?? tar.length} bytes`
        break
      }
      case 'support-tunnel-on': {
        const r = await run('systemctl', ['start', cfg.supportUnit], 30_000)
        ok = r.code === 0
        if (ok) await run('systemd-run', ['--on-active=8h', '--collect', '--unit=logship-print-support-stop', 'systemctl', 'stop', cfg.supportUnit], 10_000)
        result = ok ? `support tunnel started (${cfg.supportUnit}), auto-stop in 8 h` : (r.stderr || 'could not start support tunnel – is /etc/logship-print-agent/support.env configured?')
        break
      }
      case 'support-tunnel-off': {
        const r = await run('systemctl', ['stop', cfg.supportUnit], 30_000)
        ok = r.code === 0
        result = ok ? 'support tunnel stopped' : r.stderr
        break
      }
      // ── remote printer administration ─────────────────────────────────────
      case 'discover-printers': {
        result = JSON.stringify(await discoverPrinters())
        break
      }
      case 'add-printer': {
        result = await addPrinter(c.payload)
        inventoryChanged = true
        break
      }
      case 'remove-printer': {
        const queue = String(c.payload?.queue || '').trim()
        if (!SAFE_QUEUE.test(queue)) throw new Error('invalid queue name')
        const r = await run('lpadmin', ['-x', queue], 30_000)
        ok = r.code === 0
        result = ok ? `queue ${queue} removed` : (r.stderr || r.stdout)
        inventoryChanged = true
        break
      }
      case 'set-queue-option': {
        result = await setQueueOptions(c.payload)
        inventoryChanged = true
        break
      }
      case 'queue-control': {
        result = await queueControl(c.payload)
        inventoryChanged = true
        break
      }
      case 'test-print': {
        result = await testPrint(cfg, c.payload)
        break
      }
      case 'list-queues': {
        result = JSON.stringify(await listQueues(cfg.ppdDir))
        break
      }
      case 'http': {
        result = await relayHttp(cfg, c.payload)
        break
      }
      default:
        ok = false
        result = `unknown command ${c.command}`
    }
  } catch (e: any) {
    ok = false
    result = e?.message || String(e)
  }
  try { await api.commandResult(c.id, ok, result) } catch (e: any) { log.warn('could not post command result:', e?.message || e) }
  if (inventoryChanged && ctx.refreshInventory) {
    try { await ctx.refreshInventory() } catch (e: any) { log.warn('inventory refresh failed:', e?.message || e) }
  }
}

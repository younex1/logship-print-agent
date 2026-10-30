/**
 * Commands queued in LogShip (Settings → Printers → Print-Agents) and delivered with the next
 * poll/heartbeat. The result is posted back and shown in the "Befehle" dialog.
 */
import { run, lpstatAll, restartCups, cancelAll } from './cups.ts'
import type { Api, AgentCommandMsg } from './api.ts'
import type { AgentConfig } from './config.ts'
import { createCupsBackup } from './backup.ts'
import { log } from './log.ts'

const trim = (s: string, n = 18000) => (s.length > n ? s.slice(0, n) + '\n…(truncated)' : s)

export const handleCommand = async (cfg: AgentConfig, api: Api, c: AgentCommandMsg) => {
  log.info(`command #${c.id}: ${c.command}`)
  let ok = true
  let result = ''
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
      default:
        ok = false
        result = `unknown command ${c.command}`
    }
  } catch (e: any) {
    ok = false
    result = e?.message || String(e)
  }
  try { await api.commandResult(c.id, ok, result) } catch (e: any) { log.warn('could not post command result:', e?.message || e) }
}

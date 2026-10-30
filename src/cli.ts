#!/usr/bin/env node
/**
 * logship-print-agent CLI
 *   run                              service entry (systemd)
 *   enroll --url <https://…> --code <LSPA-…> [--name "…"]
 *   status                           connection + CUPS inventory
 *   restore-cups                     restore the /etc/cups backup stored on the instance
 *   backup-now                       upload /etc/cups now
 *   version
 */
import os from 'node:os'
import { Api } from './api.ts'
import { VERSION, loadConfig, isEnrolled, writeEnvFile } from './config.ts'
import { listQueues, queueDepth } from './cups.ts'
import { restoreCupsBackup, uploadCupsBackup } from './backup.ts'
import { runService } from './worker.ts'
import { log } from './log.ts'

const argv = process.argv.slice(2)
const cmd = argv[0] || 'run'
const opt = (name: string) => { const i = argv.indexOf(`--${name}`); return i >= 0 ? argv[i + 1] : undefined }

const main = async () => {
  const cfg = loadConfig()
  switch (cmd) {
    case 'run':
      return runService(cfg)
    case 'enroll': {
      const url = String(opt('url') || cfg.url || '').replace(/\/+$/, '')
      const code = String(opt('code') || '').trim().toUpperCase()
      const name = opt('name') || cfg.name
      if (!url || !code) { console.error('usage: logship-print-agent enroll --url https://erp.example --code LSPA-XXXX-XXXX-XXXX [--name "Lager 1"]'); process.exit(2) }
      const r = await Api.enroll(url, code, { name, hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}`, version: VERSION })
      writeEnvFile({ LOGSHIP_URL: url, LOGSHIP_AGENT_TOKEN: r.token, LOGSHIP_AGENT_NAME: JSON.stringify(r.name || name) }, cfg.envFile)
      console.log(`enrolled as agent #${r.agentId} "${r.name}" at ${url} (${r.instance?.name || 'LogShip'}) — token saved to ${cfg.envFile}`)
      console.log('restart the service:  systemctl restart logship-print-agent')
      return
    }
    case 'status': {
      console.log(`logship-print-agent ${VERSION} on ${os.hostname()} (${os.platform()} ${os.arch()})`)
      console.log(isEnrolled(cfg) ? `instance: ${cfg.url}  agent name: ${cfg.name}` : 'NOT ENROLLED — run: logship-print-agent enroll --url … --code …')
      const [queues, depth] = await Promise.all([listQueues(cfg.ppdDir), queueDepth()])
      if (!queues.length) console.log('no CUPS queues')
      for (const q of queues) console.log(`  ${q.queue.padEnd(20)} ${q.state.padEnd(9)} ${q.accepting ? 'accepting' : 'NOT accepting'}  ${q.media ? `${q.media.w}×${q.media.h} mm` : '-'}  ${q.makeModel}  ${q.deviceUri}  open: ${depth[q.queue] || 0}`)
      if (isEnrolled(cfg)) {
        try {
          const r = await fetch(`${cfg.url}/api/print-agent/heartbeat`, { method: 'POST', headers: { Authorization: `Bearer ${cfg.token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ version: VERSION }), signal: AbortSignal.timeout(15000) })
          console.log(`instance reachable: ${r.status} ${r.ok ? 'OK' : 'ERROR (token revoked?)'}`)
        } catch (e: any) { console.log(`instance NOT reachable: ${e?.message || e}`) }
      }
      return
    }
    case 'restore-cups': {
      if (!isEnrolled(cfg)) { console.error('not enrolled'); process.exit(2) }
      const ok = await restoreCupsBackup(new Api(cfg.url, cfg.token))
      process.exit(ok ? 0 : 1)
    }
    case 'backup-now': {
      if (!isEnrolled(cfg)) { console.error('not enrolled'); process.exit(2) }
      await uploadCupsBackup(new Api(cfg.url, cfg.token))
      return
    }
    case 'version':
      console.log(VERSION)
      return
    default:
      console.error(`unknown command ${cmd}`)
      process.exit(2)
  }
}

main().catch((e) => { log.error(e); process.exit(1) })

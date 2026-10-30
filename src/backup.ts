/**
 * /etc/cups backup (queues, PPDs, printers.conf) → LogShip instance, nightly + on demand.
 * A re-imaged or replacement box runs `logship-print-agent restore-cups` after enrolment.
 */
import { spawn } from 'node:child_process'
import { run } from './cups.ts'
import type { Api } from './api.ts'
import { log } from './log.ts'

export const createCupsBackup = (): Promise<Buffer> => new Promise((resolve, reject) => {
  const chunks: Buffer[] = []
  const p = spawn('tar', ['czf', '-', '-C', '/', 'etc/cups'])
  p.stdout.on('data', (d: Buffer) => chunks.push(d))
  let err = ''
  p.stderr.on('data', (d: Buffer) => { err += d.toString() })
  p.on('close', (code) => code === 0 ? resolve(Buffer.concat(chunks)) : reject(new Error(`tar failed (${code}): ${err}`)))
  p.on('error', reject)
})

export const uploadCupsBackup = async (api: Api) => {
  const tar = await createCupsBackup()
  const res: any = await api.uploadBackup(tar)
  log.info(`cups backup uploaded (${res?.bytes ?? tar.length} bytes)`)
  return res
}

export const restoreCupsBackup = async (api: Api): Promise<boolean> => {
  const tar = await api.downloadBackup()
  if (!tar) { log.warn('no cups backup stored on the instance for this agent'); return false }
  await new Promise<void>((resolve, reject) => {
    const p = spawn('tar', ['xzf', '-', '-C', '/'])
    let err = ''
    p.stderr.on('data', (d: Buffer) => { err += d.toString() })
    p.on('close', (code) => code === 0 ? resolve() : reject(new Error(`tar extract failed (${code}): ${err}`)))
    p.on('error', reject)
    p.stdin.end(tar)
  })
  const r = await run('systemctl', ['restart', 'cups'], 60_000)
  log.info(`cups backup restored (${tar.length} bytes), cups restart ${r.code === 0 ? 'ok' : 'FAILED: ' + r.stderr}`)
  return r.code === 0
}

/** Runs the backup once a day around 03:30 local time (plus once 5 min after start). */
export const scheduleBackups = (api: Api) => {
  const tick = async () => { try { await uploadCupsBackup(api) } catch (e: any) { log.warn('cups backup failed:', e?.message || e) } }
  setTimeout(tick, 5 * 60_000).unref()
  const msUntil = () => {
    const d = new Date(); d.setHours(3, 30, 0, 0)
    if (d.getTime() <= Date.now()) d.setDate(d.getDate() + 1)
    return d.getTime() - Date.now()
  }
  const arm = () => setTimeout(async () => { await tick(); arm() }, msUntil()).unref()
  arm()
}

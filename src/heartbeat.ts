/**
 * Heartbeat payload: CUPS inventory (queues, state, PPD label size), queue depth and device
 * health (disk, SSD wear, load, temperature, pending agent update). Sent every HEARTBEAT_SECONDS;
 * the LogShip Settings → Printers page renders it.
 */
import os from 'node:os'
import { readFile } from 'node:fs/promises'
import { VERSION, type AgentConfig } from './config.ts'
import { listQueues, queueDepth, run, autoProvisionUsb } from './cups.ts'
import { log } from './log.ts'

export const collectHealth = async () => {
  const health: any = {
    uptimeHours: Math.round(os.uptime() / 36) / 100,
    load: Math.round(os.loadavg()[0] * 100) / 100,
    memFreeMb: Math.round(os.freemem() / 1048576),
    agentVersion: VERSION
  }
  const df = await run('df', ['-Pm', '/'])
  const line = df.stdout.trim().split(/\r?\n/).pop() || ''
  const parts = line.split(/\s+/)
  if (parts.length >= 4 && Number.isFinite(Number(parts[3]))) health.diskFreeMb = Number(parts[3])
  try {
    const t = Number((await readFile('/sys/class/thermal/thermal_zone0/temp', 'utf8')).trim())
    if (Number.isFinite(t)) health.temp = Math.round(t / 1000)
  } catch { /* no thermal zone */ }
  // NVMe / SATA wear via smartctl (smartmontools in the appliance playbook)
  for (const dev of ['/dev/nvme0', '/dev/sda', '/dev/mmcblk0']) {
    const r = await run('smartctl', ['-A', '-j', dev], 10_000)
    if (r.code !== 0 && !r.stdout) continue
    try {
      const j = JSON.parse(r.stdout)
      const pct = j?.nvme_smart_health_information_log?.percentage_used
      if (Number.isFinite(Number(pct))) { health.smartWear = Number(pct); health.smartDevice = dev; break }
      const table: any[] = j?.ata_smart_attributes?.table || []
      const wear = table.find(a => /Wear_Leveling_Count|Percent_Lifetime_Remain|Media_Wearout_Indicator/i.test(a?.name || ''))
      if (wear && Number.isFinite(Number(wear.value))) { health.smartWear = 100 - Number(wear.value); health.smartDevice = dev; break }
    } catch { /* no json */ }
  }
  const apt = await run('apt', ['list', '--upgradable'], 20_000)
  health.updateAvailable = /^logship-print-agent\//m.test(apt.stdout)
  return health
}

export const buildHeartbeat = async (cfg: AgentConfig) => {
  if (cfg.autoProvisionUsb) {
    try {
      const created = await autoProvisionUsb(cfg.autoProvisionMakes, cfg.autoProvisionDriver, cfg.ppdDir)
      if (created.length) log.info(`auto-provisioned USB label printer queue(s): ${created.join(', ')}`)
    } catch (e: any) { log.warn('USB auto-provisioning failed:', e?.message || e) }
  }
  const [printers, depth, health] = await Promise.all([listQueues(cfg.ppdDir), queueDepth(), collectHealth()])
  return {
    version: VERSION,
    hostname: os.hostname(),
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    printers: printers.map(p => ({ queue: p.queue, state: p.state, accepting: p.accepting, deviceUri: p.deviceUri, makeModel: p.makeModel, media: p.media, jobs: p.jobs })),
    queueDepth: depth,
    health
  }
}

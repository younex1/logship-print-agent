/**
 * LAN-only setup/status page on http://logship-print.local:8080
 *  - not enrolled: form with instance URL + enrolment code (from LogShip → Settings → Printers)
 *  - enrolled: connection state, queues with label size, last jobs, link to CUPS (:631), test print
 * No authentication by design: it exposes nothing secret and only works inside the tenant LAN
 * (nftables in the appliance playbook allows :8080 from the LAN only).
 */
import http from 'node:http'
import os from 'node:os'
import { Api } from './api.ts'
import { VERSION, writeEnvFile, type AgentConfig } from './config.ts'
import { submit } from './cups.ts'
import { log } from './log.ts'

export interface AgentState {
  cfg: AgentConfig
  version?: string
  enrolled: boolean
  connected: boolean
  lastPoll: number
  lastHeartbeat: number
  lastError: string
  queuedOnServer: number
  printers: any[]
  recentJobs: { id: number; queue: string; fileName: string; status: string; error?: string; ts: number }[]
  recent(job: { id: number; queue: string; fileName: string }, status: string, error?: string): void
}

const esc = (s: any) => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
const ago = (ts: number) => !ts ? 'nie' : `${Math.round((Date.now() - ts) / 1000)} s`

const page = (title: string, body: string) => `<!doctype html><html lang="de"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><style>
body{font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;max-width:900px;margin:24px auto;padding:0 16px;color:#111;background:#f7f7f8}
h1{font-size:1.4rem;margin:0 0 4px}.sub{color:#666;margin:0 0 18px}.card{background:#fff;border:1px solid #e5e7eb;border-radius:10px;padding:16px;margin-bottom:14px}
table{width:100%;border-collapse:collapse;font-size:.9rem}th,td{text-align:left;padding:6px 8px;border-bottom:1px solid #eee}th{color:#555;font-weight:600}
.ok{color:#16a34a;font-weight:600}.bad{color:#dc2626;font-weight:600}code{background:#f1f5f9;padding:1px 5px;border-radius:4px}
input,button{font:inherit;padding:8px 10px;border:1px solid #cbd5e1;border-radius:6px}input{width:100%;box-sizing:border-box;margin:4px 0 10px}
button{background:#0f172a;color:#fff;border-color:#0f172a;cursor:pointer}button.sec{background:#fff;color:#0f172a}.row{display:flex;gap:10px;flex-wrap:wrap}.muted{color:#777;font-size:.85rem}
</style></head><body><h1>LogShip Print Agent</h1><p class="sub">${esc(os.hostname())} · Version ${esc(VERSION)}</p>${body}</body></html>`

const readBody = (req: http.IncomingMessage) => new Promise<string>((resolve) => { let b = ''; req.on('data', d => { b += d; if (b.length > 1e6) req.destroy() }); req.on('end', () => resolve(b)) })

export const startSetupServer = (state: AgentState) => {
  const { cfg } = state
  const srv = http.createServer(async (req, res) => {
    const send = (code: number, html: string) => { res.writeHead(code, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); res.end(html) }
    try {
      const url = new URL(req.url || '/', 'http://x')
      if (req.method === 'POST' && url.pathname === '/enroll') {
        const form = new URLSearchParams(await readBody(req))
        const instanceUrl = String(form.get('url') || '').trim().replace(/\/+$/, '')
        const code = String(form.get('code') || '').trim().toUpperCase()
        const name = String(form.get('name') || '').trim() || cfg.name
        if (!/^https?:\/\//.test(instanceUrl) || !code) return send(400, page('Fehler', `<div class="card bad">URL oder Code fehlt.</div><p><a href="/">zurück</a></p>`))
        const r = await Api.enroll(instanceUrl, code, { name, hostname: os.hostname(), platform: `${os.platform()} ${os.arch()}`, version: VERSION })
        writeEnvFile({ LOGSHIP_URL: instanceUrl, LOGSHIP_AGENT_TOKEN: r.token, LOGSHIP_AGENT_NAME: JSON.stringify(r.name || name) }, cfg.envFile)
        log.info(`enrolled as agent #${r.agentId} "${r.name}" at ${instanceUrl} via setup page — restarting`)
        send(200, page('Verbunden', `<div class="card"><p class="ok">Erfolgreich mit ${esc(instanceUrl)} verbunden (Agent #${r.agentId}, „${esc(r.name)}“).</p><p>Der Dienst startet neu. Diese Seite in ein paar Sekunden neu laden.</p></div>`))
        setTimeout(() => process.exit(0), 800) // systemd Restart=always brings us back with the new env
        return
      }
      if (req.method === 'POST' && url.pathname === '/test-print') {
        const form = new URLSearchParams(await readBody(req))
        const queue = String(form.get('queue') || '').trim()
        if (!/^[A-Za-z0-9_.-]{1,64}$/.test(queue)) return send(400, page('Fehler', '<div class="card bad">Ungültige Warteschlange.</div>'))
        const r = await submit(queue, ['-o', 'fit-to-page'], '/usr/share/cups/data/testprint')
        return send(200, page('Testdruck', `<div class="card"><p class="${r.ok ? 'ok' : 'bad'}">${r.ok ? 'Testseite an ' + esc(queue) + ' gesendet (' + esc(r.requestId) + ')' : 'Fehler: ' + esc(r.stderr || r.stdout)}</p><p><a href="/">zurück</a></p></div>`))
      }
      if (url.pathname === '/health') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, enrolled: state.enrolled, connected: state.connected, version: VERSION })) }

      if (!state.enrolled) {
        return send(200, page('Einrichtung', `<div class="card"><h3>Mit LogShip verbinden</h3>
<p class="muted">Code und URL stammen aus LogShip → Einstellungen → Drucker → „Print-Agents“ → „Enrolment-Code erzeugen“.</p>
<form method="post" action="/enroll"><label>Instanz-URL</label><input name="url" placeholder="https://erp.ihre-firma.de" required>
<label>Enrolment-Code</label><input name="code" placeholder="LSPA-XXXX-XXXX-XXXX" required style="text-transform:uppercase">
<label>Gerätename</label><input name="name" placeholder="z. B. Lager Halle 2 – Druckbox" value="${esc(cfg.name)}">
<button type="submit">Verbinden</button></form></div>
<div class="card"><h3>Drucker</h3><p>USB-Etikettendrucker (Zebra) werden automatisch eingerichtet. Netzwerk- und A4-Drucker über die CUPS-Oberfläche anlegen: <a href="http://${esc(os.hostname())}.local:631/admin" target="_blank">http://${esc(os.hostname())}.local:631</a></p></div>`))
      }

      const queues = state.printers.map((p: any) => `<tr><td><code>${esc(p.queue)}</code></td><td>${esc(p.makeModel || '')}<div class="muted">${esc(p.deviceUri || '')}</div></td><td>${esc(p.state)}${p.accepting === false ? ' <span class="bad">nimmt nicht an</span>' : ''}</td><td>${p.media ? esc(p.media.w + ' × ' + p.media.h + ' mm') : '–'}</td><td>${esc(p.jobs ?? 0)}</td><td><form method="post" action="/test-print" style="margin:0"><input type="hidden" name="queue" value="${esc(p.queue)}"><button class="sec" type="submit">Testseite</button></form></td></tr>`).join('')
      const jobs = state.recentJobs.map(j => `<tr><td>${j.id}</td><td><code>${esc(j.queue)}</code></td><td>${esc(j.fileName)}</td><td class="${j.status === 'failed' ? 'bad' : 'ok'}">${esc(j.status)}</td><td class="muted">${esc(j.error || '')}</td><td class="muted">${ago(j.ts)}</td></tr>`).join('')
      send(200, page('Status', `<div class="card"><h3>Verbindung</h3>
<table><tr><th>Instanz</th><td><a href="${esc(cfg.url)}" target="_blank">${esc(cfg.url)}</a></td></tr>
<tr><th>Gerätename</th><td>${esc(cfg.name)}</td></tr>
<tr><th>Status</th><td class="${state.connected ? 'ok' : 'bad'}">${state.connected ? 'verbunden' : 'nicht verbunden'} <span class="muted">· letzter Abruf vor ${ago(state.lastPoll)}, Heartbeat vor ${ago(state.lastHeartbeat)}</span></td></tr>
<tr><th>Wartend auf Server</th><td>${state.queuedOnServer}</td></tr>
${state.lastError ? `<tr><th>Letzter Fehler</th><td class="bad">${esc(state.lastError)}</td></tr>` : ''}</table></div>
<div class="card"><h3>Warteschlangen (CUPS)</h3>${queues ? `<table><tr><th>Name</th><th>Modell</th><th>Zustand</th><th>Etikett</th><th>Offen</th><th></th></tr>${queues}</table>` : '<p class="muted">Noch keine Warteschlangen. USB-Drucker anstecken oder in CUPS anlegen.</p>'}
<p class="muted">Drucker verwalten: <a href="http://${esc(os.hostname())}.local:631/admin" target="_blank">CUPS-Verwaltung</a>. Welche LogShip-Drucker über dieses Gerät drucken, wird in LogShip unter Einstellungen → Drucker pro Drucker festgelegt.</p></div>
<div class="card"><h3>Letzte Aufträge</h3>${jobs ? `<table><tr><th>#</th><th>Warteschlange</th><th>Datei</th><th>Status</th><th></th><th>vor</th></tr>${jobs}</table>` : '<p class="muted">Noch keine Aufträge.</p>'}</div>`))
    } catch (e: any) {
      log.warn('setup page error:', e?.message || e)
      send(500, page('Fehler', `<div class="card bad">${esc(e?.message || e)}</div><p><a href="/">zurück</a></p>`))
    }
  })
  srv.on('error', (e: any) => log.warn(`setup page not available on :${cfg.setupPort}: ${e?.message || e}`))
  srv.listen(cfg.setupPort, cfg.setupBind, () => log.info(`setup/status page on http://${os.hostname()}:${cfg.setupPort}`))
  return srv
}

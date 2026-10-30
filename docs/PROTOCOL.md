# Agent ↔ instance protocol

Base: the LogShip instance origin (e.g. `https://erp.tenant.de`). Auth: `Authorization: Bearer lspa_…`
(issued once at enrolment; the instance stores only its SHA-256). JSON bodies. Server side lives in
`erp-nuxt-frontend/server/api/print-agent/*`.

| Call | Purpose |
|------|---------|
| `POST /api/print-agent/enroll` `{code, name?, hostname?, platform?, version?}` (no auth, rate-limited) | → `{ok, agentId, token, name, clientId, orgId, instance:{name,url}, poll:{waitSeconds,maxJobs,heartbeatSeconds,inlineFileLimit}}` |
| `POST /api/print-agent/heartbeat` `{version, hostname, platform, printers:[{queue,state,accepting,deviceUri,makeModel,media:{w,h}|null,jobs}], queueDepth:{q:n}, health:{…}}` | → `{ok, serverTime, queued, commands:[{id,command,payload}], supportUntil}` |
| `GET /api/print-agent/jobs/next?wait=25&max=50` | long-poll; claims jobs (status→sent). → `{jobs:[{id,batchId,queue,options,fileName,fileSize,source,createdAt,attempt,content(base64)|null,fileUrl|null}], commands}` |
| `GET /api/print-agent/jobs/:id/file` | PDF stream (only the owning agent; 410 when purged) |
| `POST /api/print-agent/jobs/ack` `{acks:[{id,status:'spooled'|'completed'|'failed',cupsJobId?,output?,error?}]}` | → `{ok, results:[{id,ok,status}]}`; each ack is pushed to the creator's browser |
| `POST /api/print-agent/commands/:id/result` `{ok, result}` | outcome of update / lpstat / journal / … |
| `POST /api/print-agent/backup` `{tarBase64}` ≤ 5 MB · `GET /api/print-agent/backup` | /etc/cups backup store (per agent) |

Commands: `update`, `lpstat`, `restart-cups`, `journal`, `cancel-all`, `reboot`, `backup-now`,
`support-tunnel-on` (payload `{until}`), `support-tunnel-off`.

Job options are a CUPS option string (`-o fit-to-page -o media=Custom.102x152mm -o sides=one-sided`);
both sides whitelist tokens (`-o/-n/-t/-H/-P/-q` + `[A-Za-z0-9=_.,:+-]`). The queue name is the
printer's `CupsName` in LogShip and must exist on the device's CUPS.

Timing: the instance wakes a held poll within ~200 ms of a new job; the agent acks `spooled`
right after `lp` (the ERP toast), then `completed`/`failed` from `lpstat` every 2 s. Acks are
batched (300 ms) so a 800-label batch costs a handful of requests.

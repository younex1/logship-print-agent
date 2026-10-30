# CLAUDE.md — LogShip Print Agent

Small Node 22 daemon that runs on a Linux box inside a tenant's LAN and prints LogShip ERP jobs on
the CUPS queues of that box. It replaces "CUPS on the app host" for rented LogShip instances whose
printers are not reachable from the server (no VPN). Outbound HTTPS only.

Counterpart in the ERP repo (`../erp-nuxt-frontend`): `server/utils/printDispatch.ts` (per-printer
routing local ↔ agent), `server/utils/printSpoolDb.ts` (SQLite spool/agents/bindings),
`server/api/print-agent/*` (the protocol below), `server/api/settings/print-agents/*` +
`app/components/settings/PrintAgentsCard.vue` (admin UI). Recipe there: `.claude/rules/printing/print-agent.md`.

## Layout
```
src/cli.ts          entry: run | enroll | status | restore-cups | backup-now | version
src/worker.ts       long-poll loop, per-queue workers (id order), CompletionTracker (lpstat), AckBatcher
src/cups.ts         lp / lpstat / lpoptions / PPD media / lpinfo + USB auto-provision (lpadmin)
src/heartbeat.ts    inventory + queue depth + health (df, smartctl, temp, apt upgradable)
src/commands.ts     update / lpstat / restart-cups / journal / cancel-all / reboot / backup-now / support-tunnel-*
src/backup.ts       /etc/cups tar.gz → instance (nightly 03:30), restore
src/setup-server.ts LAN status/enrol page :8080 (no auth by design, LAN only via nftables)
src/config.ts       /etc/logship-print-agent/agent.env (+ env overrides), VERSION (esbuild define)
packaging/          nfpm.yaml (.deb with bundled Node), systemd units, env examples, postinst
scripts/            bundle.mjs (esbuild → dist/agent.mjs), build.sh (deb amd64+arm64), publish-apt.sh (reprepro)
ansible/            appliance.yml = golden box (CUPS LAN config, apt repo, unattended-upgrades, nftables,
                    journald/fstrim/watchdog/smartd, first-boot identity reset, idle-aware night reboot)
docs/               README.de.md (tenant leaflet), HARDWARE.md, SUPPORT.md (runbook), PROTOCOL.md
```

## Protocol (Bearer agent token, all paths on the instance)
`POST /api/print-agent/enroll {code}` → `{token}` once · `POST heartbeat` every 60 s (inventory/health,
returns commands) · `GET jobs/next?wait=25&max=50` long-poll (files ≤ 300 KB inline base64, else
`jobs/:id/file`) · `POST jobs/ack {acks:[{id,status:spooled|completed|failed,cupsJobId,error}]}` ·
`POST commands/:id/result` · `POST/GET backup`. Details: `docs/PROTOCOL.md`.

## Rules
- Zero runtime npm dependencies (Node 22 built-ins only) — the .deb bundles Node; keep it that way.
- Per queue strictly in job-id order, queues in parallel; `lp` returns on spool, completion comes from
  `lpstat -W completed -o`; ack `spooled` immediately (that is what the ERP toasts on).
- Idempotency = `Ledger` (job id → CUPS id). Never print a job that is in the ledger; ack it instead.
- Options are whitelisted again on the device (`tokenizeOptions`), never passed through a shell.
- Dev run without CUPS: `LOGSHIP_AGENT_ENV=./agent.env STATE_DIR=./.state npm run dev` (lpstat calls
  fail soft → empty inventory). Type-check: `npm run typecheck`. Package: `scripts/build.sh` (needs nfpm).
- Versioning: `package.json` version = stable; Jenkins tags `vX.Y.Z` → `stable`, main → `beta` channel.
- Commits: never add Claude as co-author / no "Generated with" trailers.

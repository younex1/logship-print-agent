# Support runbook (LogYou)

## Everything from LogShip (no VPN)
Settings → Printers → Print-Agents: online dot (heartbeat < 3 min), version, hostname, health line
(disk, SSD wear, load, temp, update available), per-queue state + depth, job stats.
Buttons per agent: **update** (apt --only-upgrade via systemd-run), **lpstat** (`lpstat -t`),
**restart CUPS**, **journal** (last 400 lines), **commands/results**, **Fernwartung 8 h**
(reverse SSH, see below), rename, remove (revokes token, unbinds printers, cancels open jobs).
Jobs panel: status per job/batch, lp output / error, retry, cancel.

## Job states
`queued` (on instance) → `sent` (claimed by the agent) → `spooled` (lp accepted, CUPS id known —
the user toast fires here) → `completed` (CUPS history) | `failed` (lp error, or CUPS job vanished =
cancelled/aborted on the device, typically printer offline / media out).
`sent` without ack for 3 min → back to `queued` automatically; the agent ledger prevents a double print.

## CUPS web UI of a box — inside LogShip (no VPN)
Settings → Printers → Print-Agents → **CUPS-Oberfläche** (per agent): LogShip relays every browser
request over the agent channel to `http://127.0.0.1:631` on the box and rewrites CUPS' links onto
`/api/settings/print-agents/<id>/cups/…`. Admin pages are signed in on the box with the local
`logship-cups` lpadmin user (`CUPS_ADMIN_USER/PASS` in agent.env, created by installer/playbook) —
no CUPS password on the LogShip side. Round trip ≈ 0.3–1 s per page; only works while the agent is online.

## Reverse SSH support tunnel (full shell)
`support-tunnel-on` starts `logship-print-support.service` (autossh `-R <REMOTE_PORT>:localhost:22`
to `SUPPORT_USER@SUPPORT_HOST`, key `/etc/logship-print-agent/support_key`, auto-stop after 8 h).
Jump host: user `printsupport` on edge.logship.de with `command="echo tunnel only"`,
`no-pty`, `permitopen="localhost:22"`-style restrictions in `authorized_keys`; `GatewayPorts no`.
Register a box on the jump host once: `jumphost-add-box.sh "<support_key.pub>" <REMOTE_PORT>` (script in
`scripts/`, installed at `/usr/local/sbin/jumphost-add-box` on the edge VM; creates the restricted
`printsupport` user: `restrict,port-forwarding,permitlisten="<port>"`, Match block with
`AllowTcpForwarding remote`, `ForceCommand /bin/false`). REMOTE_PORT must be unique per device.
Connect from your Mac (root on the edge VM = jump): 
`ssh -J root@192.168.12.52 -p <REMOTE_PORT> younes@localhost` → full shell, sudo.
CUPS GUI through the same tunnel: add `-L 6310:localhost:631` and open http://localhost:6310/admin.
Lab box 2026-10-31: port 22001, `SUPPORT_HOST=192.168.12.52` (LAN). For tenant boxes on the internet the
jump host needs a public SSH port (OPNsense NAT e.g. 2222 → .52:22 on 5.9.170.82) — not yet configured.

## On the box
```
logship-print-agent status            # enrolment, instance reachability, queues + media + depth
journalctl -u logship-print-agent -f  # live log
lpstat -t ; lpstat -W completed -o    # CUPS view
cat /etc/logship-print-agent/agent.env
systemctl restart logship-print-agent
logship-print-agent restore-cups      # replacement box: pull /etc/cups backup from the instance
```
State: `/var/lib/logship-print-agent/{ledger.json,spool/}`. Setup page `:8080` has test prints.

## Replacement box
Write the golden image, boot, revoke the old agent in LogShip (keeps its backup file on the instance
under the OLD id — so run the restore BEFORE revoking, or copy `data/print-agent-backups/agent-<old>.tar.gz`
to the new id on the instance), enrol with a new code, `logship-print-agent restore-cups`, then
re-bind the printers in LogShip to the new agent (per printer, Druckerformular).

## Known limits (v1)
Linux only (Windows shops: PrintNode driver planned), `lp` on the box = root service, no TLS pinning
beyond system CA, setup page unauthenticated (LAN only).

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

## Reverse SSH support tunnel
`support-tunnel-on` starts `logship-print-support.service` (autossh `-R <REMOTE_PORT>:localhost:22`
to `SUPPORT_USER@SUPPORT_HOST`, key `/etc/logship-print-agent/support_key`, auto-stop after 8 h).
Jump host: user `printsupport` on edge.logship.de with `command="echo tunnel only"`,
`no-pty`, `permitopen="localhost:22"`-style restrictions in `authorized_keys`; `GatewayPorts no`.
Connect: `ssh -J printsupport@edge.logship.de -p <REMOTE_PORT> root@localhost` (admin key from the
playbook `admin_ssh_keys`). REMOTE_PORT must be unique per device (`support.env`).

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

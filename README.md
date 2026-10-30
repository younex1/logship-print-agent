# LogShip Print Agent

Prints LogShip ERP jobs (shipping labels, product labels, picklists, delivery notes) on CUPS printers
inside a customer's LAN. The agent pulls jobs from the LogShip instance over HTTPS (long-poll),
so no VPN, no port forwarding and no inbound firewall rule is needed. One box per site; which
LogShip printer uses which box is configured per printer in LogShip (Settings → Printers).

```
 browser / scanner ──► LogShip instance (cloud) ──spool──► ┐
                                                          │ HTTPS long-poll (outbound only)
   tenant LAN:   Zebra ◄─ CUPS ◄─ logship-print-agent ◄───┘
                 A4 laser ◄┘       (N100 mini-PC / Raspberry Pi 5, Debian 12)
```

- **Fast:** a label leaves the printer < 1 s after the click (job inline in the poll response, `lp` on
  the device, `spooled` ack → toast). 800 labels are handed to CUPS in well under 2 minutes, strictly
  in order per queue; queues print in parallel.
- **Robust:** idempotent job ledger (no double prints after a crash), offline tolerance (jobs wait on
  the instance), completion/failure tracking via `lpstat`, nightly `/etc/cups` backup to the instance.
- **Zero-touch printers:** USB Zebra printers get their CUPS queue automatically; network/A4 printers
  are added in the CUPS web UI on `:631`.
- **Maintained remotely without VPN:** version/health in LogShip, `update` / `lpstat` / `journal` /
  `restart-cups` commands over the same channel, opt-in 8 h reverse-SSH support tunnel.

## Quick start (device)
```bash
# Debian 12 box prepared with ansible/appliance.yml (or: apt install ./logship-print-agent_*.deb)
sudo logship-print-agent enroll --url https://erp.example.de --code LSPA-XXXX-XXXX-XXXX --name "Lager Halle 2"
sudo systemctl restart logship-print-agent
logship-print-agent status
```
Or open `http://logship-print.local:8080` and paste URL + code there. The code comes from LogShip →
Settings → Printers → Print-Agents → "Enrolment-Code erzeugen".

## Build
```bash
npm ci && npm run typecheck && npm run build        # dist/agent.mjs
VERSION=0.1.0 ./scripts/build.sh                    # dist/*.deb (amd64 + arm64, bundled Node; needs nfpm)
./scripts/publish-apt.sh stable                     # on the apt host (reprepro)
```

Docs: `docs/README.de.md` (tenant leaflet), `docs/HARDWARE.md`, `docs/SUPPORT.md`, `docs/PROTOCOL.md`.

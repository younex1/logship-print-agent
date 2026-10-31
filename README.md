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
git clone https://github.com/younex1/logship-print-agent.git && cd logship-print-agent
sudo ./install/install.sh --url https://erp.example.de --code LSPA-XXXX-XXXX-XXXX --name "Lager Halle 2"
```
Installs CUPS + the agent package from `install/` (prebuilt, checksum-verified), enrols, verifies.
Requirements, device recommendations and the manual steps: **`install/README.md`**. Boxes shipped by
LogYou are additionally hardened with `ansible/appliance.yml` (see `docs/HARDWARE.md`).
Or open `http://logship-print.local:8080` and paste URL + code there. The code comes from LogShip →
Settings → Printers → Print-Agents → "Enrolment-Code erzeugen".

## Build
```bash
npm ci && npm run typecheck && npm run build        # dist/agent.mjs
VERSION=0.1.0 ./scripts/build.sh                    # dist/*.deb (amd64 + arm64, bundled Node; needs nfpm)
./scripts/publish-apt.sh stable                     # on the apt host (reprepro)
```
Official builds run on the Jenkins controller (`jenkins`, 192.168.12.65, Debian 12, nfpm in
`/usr/local/bin`, Node 22.22.3 via the jenkins user's nvm): checkout under
`/var/lib/jenkins/builds/logship-print-agent`, then `VERSION=x.y.z ./scripts/build.sh` as user
`jenkins` — or the `Jenkinsfile` once the job exists. Install on a box:
`apt install ./logship-print-agent_x.y.z_amd64.deb` (keeps `/etc/logship-print-agent/*.env`).

## Releases
Tag `vX.Y.Z` (= `package.json` version); the two `.deb` files + `SHA256SUMS` are attached to the
GitHub release of that tag (built on the controller). v0.1.0: first packaged release (2026-10-31).

Docs: `docs/README.de.md` (tenant leaflet), `docs/HARDWARE.md`, `docs/SUPPORT.md`, `docs/PROTOCOL.md`.

# Installing a LogShip print server

One box per site or merchant LAN. It pulls print jobs from the LogShip instance over HTTPS and
prints them on the CUPS printers attached to it. Nothing inbound, no VPN.

## Requirements

| | |
|---|---|
| OS | **Debian 12 (bookworm)**, amd64 or arm64 — the tested target. Debian 13 works (lab box). Ubuntu 22.04/24.04 should work, untested. |
| Install | fresh minimal install (netinst, "SSH server" + "standard utilities" only), root or sudo |
| Network | outbound HTTPS (443) to the LogShip instance and, for the installer, to nodejs.org/github.com (only when building from source); LAN access to the printers (USB, `socket://…:9100`, IPP). Optional inside the LAN: `:8080` setup page, `:631` CUPS UI, `:22` ssh |
| Printers | Zebra label printers (USB → queue created automatically; LAN → via LogShip "Drucker einrichten"), A4 lasers with IPP Everywhere (driverless) |
| Pulled in by the package | `cups cups-client cups-filters ghostscript poppler-utils` (+ recommended `printer-driver-zebra smartmontools avahi-daemon autossh`) |
| Footprint | ~120 MB on disk (bundled Node runtime), ~60 MB RAM, CPU idle except Ghostscript when rendering A4 |

## Device recommendation

- **Standard: Intel N100 mini-PC** — Beelink Mini S12 Pro (N100, 16 GB, 500 GB) or Beelink Mini S13 /
  GMKtec NucBox G3 Plus (N150), ASUS NUC 14 Essential. ~€150–200. Fanless or near-silent, 24/7, 4× USB-A, GbE.
  Swap the factory SSD for an endurance NVMe (WD Red SN700 500 GB ≈ 1000 TBW or Samsung 990 EVO).
  BIOS: *Restore on AC Power Loss = Power On*, Secure Boot off for the Debian netinst.
- **Budget / compact: Raspberry Pi 5 (4 GB)** + official 27 W PSU + active cooler + case + NVMe HAT with a
  256 GB SSD (arm64 package). Fine for label-only sites; A4 bursts render slower. Not Pi 3/Zero, no SD-only setups for production.
- Why not a Pi as standard: SD-card wear, Brother/Dymo vendor drivers are amd64-only, Ghostscript speed.
  Details and the imaging workflow for shipped boxes: `docs/HARDWARE.md`, `ansible/appliance.yml`.

## Install (prebuilt package from this repository)

```bash
sudo apt-get install -y git
git clone https://github.com/younex1/logship-print-agent.git
cd logship-print-agent
# code + URL: LogShip → Einstellungen → Drucker → "Druckserver verbinden" (one code per box, valid 24 h)
sudo ./install/install.sh --url https://erp.example.de --code LSPA-XXXX-XXXX-XXXX --name "Lager Halle 2 – Druckbox"
```
The script: installs the base packages, verifies and installs `install/logship-print-agent_<version>_<arch>.deb`
(CUPS and the other dependencies come with it), enrols the box, restarts the service and prints a
verification: services, CUPS limits, instance reachability, heartbeat accepted, queues.

Without `--code` the agent is installed but not enrolled; enrol later with
`sudo logship-print-agent enroll --url … --code …` or on the setup page `http://<box>:8080`.

Re-running the script is safe (keeps `/etc/logship-print-agent/*.env`). `--build` builds the package from
the checkout instead of using the prebuilt file (needs internet for Node + nfpm, ~2 min); `--version x.y.z`
selects another prebuilt file in `install/`.

## After the install

1. The box appears in LogShip under **Einstellungen → Drucker → Druckserver** within a minute (green dot).
2. USB Zebra printers are already there as `labelprinter-1…`; add network printers with **Drucker einrichten**
   or in the **CUPS-Oberfläche** (both in that card, no VPN needed), or locally at `http://<box>:631`.
3. Create / assign the LogShip printers: **Anlegen** next to a queue, or open an existing printer and pick the
   box under **Print-Agent**. Commissioning tables keep referencing printers by their CUPS name.
4. Test: a product label or a commissioning label → toast "An Drucker gesendet", job visible under **Druckaufträge**.

## Updates

- Package upgrade: `cd logship-print-agent && git pull && sudo ./install/install.sh` (same command, no code needed).
- Planned: apt repository on the edge host (`Origin: LogShip`) so boxes update unattended and the **Update**
  button in LogShip works; see `scripts/publish-apt.sh`.
- Debian security updates: `unattended-upgrades` (configured by the appliance playbook for shipped boxes).

## Useful commands on the box
```
logship-print-agent status                 # enrolment, instance reachability, CUPS queues + media
sudo journalctl -u logship-print-agent -f  # live log
lpstat -t                                  # CUPS view
sudo logship-print-agent restore-cups      # replacement box: restore the /etc/cups backup stored on the instance
```
Troubleshooting and remote support (CUPS relay, reverse-SSH tunnel): `docs/SUPPORT.md`.

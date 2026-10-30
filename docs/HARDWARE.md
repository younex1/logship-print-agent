# Hardware

## Standard box (recommended for every paying 3PL)
**Intel N100 mini-PC**, 8–16 GB RAM, 256–500 GB NVMe, 1 GbE, ≥ 2× USB-A, fanless or near-silent.
Tested/intended models: Beelink Mini S12 Pro (N100), Beelink Mini S13 (N150), GMKtec NucBox G3 Plus
(N150), ASUS NUC 14 Essential. ~€150–200.

Why x86 over a Pi: real NVMe instead of SD card, every CUPS/vendor driver (Brother, Dymo…) exists for
amd64, Ghostscript is fast enough for hundreds of A4 pages, same Debian 12 as the LogShip servers.

**Replace the factory SSD** with an endurance drive before imaging: WD Red SN700 500 GB (≈1000 TBW)
or Samsung 990 EVO. The bundled no-name drive is the part most likely to fail first.

**BIOS:** *Restore on AC Power Loss = Power On*, *Wake on LAN = on*, secure boot off (Debian netinst),
watchdog/iTCO enabled if listed.

## Budget / compact
**Raspberry Pi 5 (4 GB)** + official 27 W PSU + active cooler + case + NVMe HAT with a 256 GB SSD.
If an SD card is unavoidable: A2 "high endurance" card; the playbook installs log2ram on the Pi.
Fine for label-only sites; A4 bursts render slower (Ghostscript on ARM). Not Pi 3 / Zero.

## Printers
- Labels: Zebra ZD421 / ZD621 (203 dpi), USB or LAN. Auto-provisioned when USB (`AUTO_PROVISION_MAKES=Zebra`,
  ZPL driver `drv:///sample.drv/zebra.ppd`; set `zebraep2.ppd` for EPL-only models).
- A4: any laser with IPP Everywhere / AirPrint (driverless, `lpadmin -m everywhere`) — no vendor driver needed.
- Brother QL / Dymo: vendor `.deb` drivers are amd64-only → another reason for the N100 box.

## Longevity checklist (done by ansible/appliance.yml)
ext4 `noatime`, no swap partition, `/tmp` tmpfs, journald ≤ 200 MB, CUPS `PreserveJobFiles No`,
logrotate, fstrim weekly, smartd + wear % in the heartbeat, systemd hardware watchdog, idle-aware
night reboot, first-boot identity reset for cloned images.

## Imaging workflow
1. Install Debian 12 netinst (minimal + ssh), run the playbook against it.
2. `touch /var/lib/logship-print-agent/.first-boot`, power off, image the SSD (Clonezilla / `dd`).
3. New box: write the image, boot (first-boot regenerates ssh keys, machine-id, hostname suffix),
   enrol with a code from the tenant's instance, label the box, ship with `docs/README.de.md`.

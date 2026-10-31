# Testing the Print Agent yourself

## Lab setup that exists (2026-10-30)
| Piece | Where |
|------|-------|
| LogShip instance | Musterlager demo, VM 118 on prox2 → `http://192.168.12.68:3001` (public `https://edge.logship.de` once the edge proxy is back). Login `demo` (see `/root/demo-credentials.txt` on the VM) |
| "N100" box | prox1 VM 101 `n100-print-test`, Debian 13, `192.168.9.136` (DHCP), ssh `ssh -J root@prox1.younex.de younes@192.168.9.136`, agent enrolled as **agent #1 "N100 Testbox (prox1)"** |
| Virtual printers on the box | cups-pdf queues `labelprinter-1` (102×152) and `commission-a4-1` (A4) → PDFs land in `/root/PDF/` on the box (`sudo ls /root/PDF`) |
| Real printer via the box | queue `zebra-test-35x17` → office Zebra ZD411 `socket://192.168.1.61:9100` (created remotely from LogShip) |
| Status page of the box | `http://192.168.9.136:8080` (from the office LAN) |

## 1. In LogShip (browser)
Page **Einstellungen → Drucker** (`/settings/printers`): hero with the numbers, then three tabs.
1. Tab **Druckserver** (`?tab=servers`): one card per box — status dot, organisation, version, health,
   KPIs (queues / bound printers / open jobs / in CUPS / failed), queues with their LogShip printer and
   binding state, the **Fernzugriff** switches (CUPS web UI via LogShip, support tunnel) and the actions.
2. **Drucker einrichten** on a card → **USB- & Netzwerkdrucker suchen** (`lpinfo` on the box, ~5 s) → pick a
   device or type a URI (`socket://<ip>:9100` for Zebras, `ipp://…` for A4 lasers) → driver preset → media →
   **Auf dem Gerät anlegen**. The queue appears in the card within seconds. Per queue: Testseite,
   Etikettengröße, Anhalten/Aktivieren, Aufträge abbrechen, Entfernen.
3. **CUPS-Oberfläche** on a card → the box's CUPS admin UI opens in a modal inside LogShip (relayed
   through the agent; disabled when the customer switched it off or the box is offline).
4. **Anlegen** next to a queue without a LogShip printer (or open an existing printer in tab **Drucker**)
   → in the printer form choose the box under **Print-Agent** and the device queue; save. Column
   **Druckt über** in the grid shows the assignment.
5. Print as usual: commissioning label, product label, picklist, delivery note. A toast "An Drucker
   gesendet" appears when CUPS on the box accepted the job; bulk jobs show one progress toast.
   Tab **Druckaufträge** lists every job with status, lp output, retry/cancel (auto-refresh 10 s).
6. Unplug the box's LAN cable, print, plug it back in: the job waits as `queued` and prints on reconnect.
7. Toolbar **Druckserver verbinden** → device name + organisation → code + instance URL for a tenant box.
8. **Fernwartung 8 h** on a card opens the reverse-SSH tunnel (see SUPPORT.md for the jump-host side).

## 2. On the box (ssh)
```bash
logship-print-agent status                 # enrolment, instance reachability, CUPS queues + media
sudo journalctl -u logship-print-agent -f  # live log: "job 123 → labelprinter-1 spooled as labelprinter-1-77"
lpstat -t                                  # CUPS view
sudo systemctl kill -s SIGKILL logship-print-agent   # crash test: jobs resume, none printed twice
```
Update the box from this checkout: `SSH_OPTS="-J root@prox1.younex.de" ./scripts/install-dev.sh younes@192.168.9.136`

## 3. Scripted (what the 2026-10-30 run did)
Session scripts live in the Claude scratchpad of that session (`printtest/flow.sh`, `burst.sh`,
`crash.sh`, `physical.sh`); the essence:
- login: `POST /api/idempiere-auth/login` → `POST /api/idempiere-auth/select-role` (multi-org user) →
  build the `Cookie:` header from the token (`logship_it`, `_client_id`, `_role_id`, `_organization_id`, `_user_id`)
- `POST /api/settings/print-agents/enroll-code`, `PUT /api/settings/print-agents/bindings/<CUST_Printer_ID>`
- `POST /api/print/labelprint {pathName,fileName,fileContent(base64),shippingPrinter}` → `printStatus: queued`, `jobId`
- `GET /api/settings/print-agents/jobs?limit=…` until `completed`

Results: single label queued → spooled 0.8 s → completed 2.1 s; 800 labels: all accepted in 3.2 s,
printed in order (0 inversions along CUPS job ids), 800/800 completed, 0 duplicates after a mid-batch
restart. Keep physical tests on the office Zebras to ≤ 30–40 labels.

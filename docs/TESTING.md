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
1. Log in to the demo, open **Einstellungen → Drucker**. The card **Print-Agents** at the top shows the
   box: green dot (online), version, host, queues with label size, job counters.
2. Click **Drucker einrichten** on the agent → **USB- & Netzwerkdrucker suchen** (runs `lpinfo` on the
   box, ~5 s) → pick a device or type a URI (`socket://<ip>:9100` for Zebras, `ipp://…` for A4 lasers)
   → driver preset → **Auf dem Gerät anlegen**. The new queue appears in the list within seconds.
   Buttons per queue: Testseite, Etikettengröße setzen, Anhalten/Aktivieren, Aufträge abbrechen, Entfernen.
3. Click **Anlegen** next to a discovered queue (or open an existing printer) → in the printer form
   choose the agent under **Print-Agent** and the device queue; save. The list column **Print-Agent**
   now shows the box instead of "lokal".
4. Print as usual: commissioning label, product label, picklist, delivery note. A toast
   "An Drucker gesendet" appears when CUPS on the box accepted the job; bulk jobs show one progress
   toast. **Druckaufträge** (button on the card) lists every job with status, lp output, retry/cancel.
5. Unplug the box's LAN cable, print, plug it back in: the job waits as `queued` and prints on reconnect.
6. **Enrolment-Code erzeugen** → the code + instance URL you would hand to a tenant.

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

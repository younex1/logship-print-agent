#!/usr/bin/env bash
# Installs the agent on a Debian/Ubuntu box straight from this checkout (same layout as the .deb,
# without dpkg) — for lab/test boxes while no apt repo is in place.
#   ./scripts/install-dev.sh root@192.168.9.50 [--with-pdf-printers]
# --with-pdf-printers adds two cups-pdf virtual queues (labelprinter-1, commission-a4-1) for tests.
set -euo pipefail
cd "$(dirname "$0")/.."
TARGET="${1:?target ssh host, e.g. root@192.168.9.50}"
WITH_PDF="${2:-}"
NODE_VERSION="${NODE_VERSION:-22.22.3}"
node scripts/bundle.mjs >/dev/null
# SSH_OPTS e.g. "-J root@jumphost" ; non-root targets need passwordless sudo
SSH="ssh -o StrictHostKeyChecking=accept-new ${SSH_OPTS:-} $TARGET"
SUDO=""; [ "${TARGET%%@*}" != "root" ] && [ "${TARGET%%@*}" != "$TARGET" ] && SUDO="sudo -n"
$SSH 'mkdir -p /tmp/lspa'
scp -q -o StrictHostKeyChecking=accept-new ${SSH_OPTS:-} dist/agent.mjs packaging/bin/logship-print-agent packaging/logship-print-agent.service packaging/logship-print-support.service packaging/agent.env.example packaging/support.env.example packaging/postinstall.sh "$TARGET:/tmp/lspa/"
$SSH $SUDO bash -s "$NODE_VERSION" "$WITH_PDF" <<'REMOTE'
set -euo pipefail
NODE_VERSION="$1"; WITH_PDF="$2"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq cups cups-client cups-filters cups-bsd ghostscript poppler-utils ca-certificates curl xz-utils avahi-daemon smartmontools printer-driver-cups-pdf >/dev/null
ARCH=$(dpkg --print-architecture); case "$ARCH" in amd64) NA=x64;; arm64) NA=arm64;; *) echo "arch $ARCH?"; exit 1;; esac
mkdir -p /opt/logship-print-agent /etc/logship-print-agent /var/lib/logship-print-agent/spool
if [ ! -x /opt/logship-print-agent/node ] || ! /opt/logship-print-agent/node -v | grep -q "v$NODE_VERSION"; then
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NA}.tar.xz" -o /tmp/lspa/node.tar.xz
  tar -xJf /tmp/lspa/node.tar.xz -C /tmp/lspa --strip-components=2 "node-v${NODE_VERSION}-linux-${NA}/bin/node"
  install -m 755 /tmp/lspa/node /opt/logship-print-agent/node
fi
install -m 755 /tmp/lspa/agent.mjs /opt/logship-print-agent/agent.mjs
install -m 755 /tmp/lspa/logship-print-agent /usr/bin/logship-print-agent
install -m 644 /tmp/lspa/logship-print-agent.service /lib/systemd/system/
install -m 644 /tmp/lspa/logship-print-support.service /lib/systemd/system/
[ -f /etc/logship-print-agent/agent.env ] || install -m 600 /tmp/lspa/agent.env.example /etc/logship-print-agent/agent.env
[ -f /etc/logship-print-agent/support.env ] || install -m 600 /tmp/lspa/support.env.example /etc/logship-print-agent/support.env
# same limits as ansible/appliance.yml (Debian default MaxJobs 500 rejects big bursts with "Too many active jobs")
for kv in "MaxJobs 5000" "MaxJobsPerPrinter 2000" "PreserveJobHistory 1d" "PreserveJobFiles No"; do
  k=${kv%% *}; grep -qE "^$k " /etc/cups/cupsd.conf && sed -i "s/^$k .*/$kv/" /etc/cups/cupsd.conf || echo "$kv" >> /etc/cups/cupsd.conf
done
systemctl enable cups >/dev/null; systemctl restart cups
if [ "$WITH_PDF" = "--with-pdf-printers" ]; then
  PPD=$(ls /usr/share/ppd/cups-pdf/*.ppd 2>/dev/null | head -1 || true)
  [ -n "$PPD" ] || PPD=$(find / -name 'CUPS-PDF*.ppd' 2>/dev/null | head -1)
  for q in labelprinter-1 commission-a4-1; do lpstat -p "$q" >/dev/null 2>&1 || lpadmin -p "$q" -E -v cups-pdf:/ -P "$PPD" -o printer-is-shared=false; done
  lpoptions -p labelprinter-1 -o media=Custom.102x152mm >/dev/null || true
  lpoptions -p commission-a4-1 -o media=A4 >/dev/null || true
  echo "cups-pdf queues: $(lpstat -p | awk '{print $2}' | tr '\n' ' ') → output in /var/spool/cups-pdf/<user>/"
fi
bash /tmp/lspa/postinstall.sh
sleep 1
systemctl is-active logship-print-agent && logship-print-agent version
REMOTE
echo "installed on $TARGET — enrol: ssh $TARGET logship-print-agent enroll --url https://… --code LSPA-… && systemctl restart logship-print-agent"

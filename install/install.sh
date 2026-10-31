#!/usr/bin/env bash
# =====================================================================================
# LogShip Print Agent — installer for a Debian/Ubuntu box in a site's LAN.
#
#   git clone https://github.com/younex1/logship-print-agent.git
#   cd logship-print-agent
#   sudo ./install/install.sh --url https://erp.example.de --code LSPA-XXXX-XXXX-XXXX --name "Lager Halle 2"
#
# What it does (idempotent, safe to re-run):
#   1. apt: curl, ca-certificates, xz-utils (+ cups & friends come as package dependencies)
#   2. installs the agent package: prebuilt install/logship-print-agent_<ver>_<arch>.deb (checksum-verified)
#      or --build: builds the same .deb from this checkout (downloads Node + nfpm, ~2 min)
#   3. enrols the box with the LogShip instance when --url/--code are given (skipped if already enrolled)
#   4. verifies: dpkg state, services, CUPS, agent version, instance reachability, prints next steps
# Options: --url <https://instance> --code <LSPA-…> [--name "<device name>"] [--build] [--no-enroll] [--version x.y.z]
# =====================================================================================
set -euo pipefail

URL=""; CODE=""; NAME=""; BUILD=0; NOENROLL=0; VERSION=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --no-enroll) NOENROLL=1; shift ;;
    --version) VERSION="$2"; shift 2 ;;
    -h|--help) sed -n 2,16p "$0"; exit 0 ;;
    *) echo "unknown option $1"; exit 2 ;;
  esac
done
[ "$(id -u)" = 0 ] || { echo "run as root: sudo $0 $*"; exit 1; }
cd "$(dirname "$0")/.."
REPO="$(pwd)"
ARCH="$(dpkg --print-architecture)"
ok()   { printf '  \033[32m✔\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
fail() { printf '  \033[31m✘\033[0m %s\n' "$*"; exit 1; }
step() { printf '\n\033[1m== %s\033[0m\n' "$*"; }

step "Checking the system"
. /etc/os-release
case "${ID:-}" in
  debian) [ "${VERSION_ID:-0}" -ge 12 ] 2>/dev/null || warn "Debian ${VERSION_ID:-?}: tested on 12 and 13" ;;
  ubuntu) warn "Ubuntu ${VERSION_ID:-?}: should work (systemd + CUPS 2.4), not part of the test matrix" ;;
  *) warn "${PRETTY_NAME:-unknown OS}: untested" ;;
esac
case "$ARCH" in amd64|arm64) ok "architecture $ARCH" ;; *) fail "unsupported architecture $ARCH (amd64 or arm64)" ;; esac
command -v systemctl >/dev/null || fail "systemd is required"
ok "$PRETTY_NAME"

step "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils gnupg >/dev/null
ok "curl / ca-certificates / xz-utils"

step "Agent package"
PKG_VERSION="${VERSION:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
DEB="$REPO/install/logship-print-agent_${PKG_VERSION}_${ARCH}.deb"
if [ "$BUILD" = 1 ] || [ ! -f "$DEB" ]; then
  [ "$BUILD" = 1 ] || warn "no prebuilt package for ${PKG_VERSION}/${ARCH} in install/ — building from source"
  NODE_VERSION="${NODE_VERSION:-22.22.3}"
  case "$ARCH" in amd64) NA=x64 ;; arm64) NA=arm64 ;; esac
  TMP="$(mktemp -d /tmp/lspa-build.XXXXXX)"
  echo "  downloading Node ${NODE_VERSION} (build toolchain + bundled runtime)"
  curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-${NA}.tar.xz" -o "$TMP/node.tar.xz"
  mkdir -p "$TMP/node" && tar -xJf "$TMP/node.tar.xz" -C "$TMP/node" --strip-components=1
  export PATH="$TMP/node/bin:$PATH"
  NFPM_V="$(curl -fsSL https://api.github.com/repos/goreleaser/nfpm/releases/latest | sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p' | head -1)"
  [ -n "$NFPM_V" ] || NFPM_V="v2.48.0"
  case "$ARCH" in amd64) NFA=x86_64 ;; arm64) NFA=arm64 ;; esac
  echo "  downloading nfpm ${NFPM_V}"
  curl -fsSL "https://github.com/goreleaser/nfpm/releases/download/${NFPM_V}/nfpm_${NFPM_V#v}_Linux_${NFA}.tar.gz" -o "$TMP/nfpm.tgz"
  curl -fsSL "https://github.com/goreleaser/nfpm/releases/download/${NFPM_V}/checksums.txt" -o "$TMP/nfpm-sums.txt"
  WANT="$(grep " nfpm_${NFPM_V#v}_Linux_${NFA}.tar.gz$" "$TMP/nfpm-sums.txt" | awk '{print $1}')"
  GOT="$(sha256sum "$TMP/nfpm.tgz" | awk '{print $1}')"
  [ "$WANT" = "$GOT" ] || fail "nfpm checksum mismatch"
  tar -xzf "$TMP/nfpm.tgz" -C "$TMP" nfpm && export PATH="$TMP:$PATH"
  mkdir -p build && cp "$TMP/node.tar.xz" "build/node-v${NODE_VERSION}-linux-${NA}.tar.xz"
  NODE_VERSION="$NODE_VERSION" VERSION="$PKG_VERSION" ARCHES="$ARCH" bash scripts/build.sh 2>&1 | grep -E "created package|bundled" | sed 's/^/  /'
  DEB="$REPO/dist/logship-print-agent_${PKG_VERSION}_${ARCH}.deb"
  [ -f "$DEB" ] || fail "build produced no package"
  ok "built $DEB"
else
  if [ -f install/SHA256SUMS ]; then
    (cd install && grep " $(basename "$DEB")$" SHA256SUMS | sha256sum -c --quiet -) || fail "checksum mismatch for $(basename "$DEB")"
    ok "checksum verified"
  fi
  ok "prebuilt $(basename "$DEB")"
fi
apt-get install -y -qq -o Dpkg::Options::=--force-confold "$DEB" >/dev/null 2>&1 || apt-get install -y -o Dpkg::Options::=--force-confold "$DEB"
ok "installed: $(dpkg-query -W -f='${Package} ${Version}' logship-print-agent)"

step "Enrolment"
ENV=/etc/logship-print-agent/agent.env
CUR_TOKEN="$(sed -n 's/^LOGSHIP_AGENT_TOKEN=//p' "$ENV" 2>/dev/null | head -1)"
if [ "$NOENROLL" = 1 ]; then
  warn "skipped (--no-enroll)"
elif [ -n "$CUR_TOKEN" ] && [ -z "$CODE" ]; then
  ok "already enrolled with $(sed -n 's/^LOGSHIP_URL=//p' "$ENV" | head -1) — keeping it (pass --code to re-enrol)"
elif [ -n "$URL" ] && [ -n "$CODE" ]; then
  logship-print-agent enroll --url "$URL" --code "$CODE" ${NAME:+--name "$NAME"} | sed 's/^/  /'
  systemctl restart logship-print-agent
  ok "enrolled"
else
  warn "not enrolled yet — run: sudo logship-print-agent enroll --url https://<instance> --code LSPA-…   (code from LogShip → Einstellungen → Drucker → Druckserver verbinden)"
  warn "or open the setup page http://$(hostname -I | awk '{print $1}'):8080"
fi

step "Verification"
sleep 3
systemctl is-active --quiet cups && ok "cups active" || fail "cups is not running"
systemctl is-active --quiet logship-print-agent && ok "logship-print-agent active ($(logship-print-agent version))" || fail "agent not running — journalctl -u logship-print-agent"
grep -q '^MaxJobs 5000' /etc/cups/cupsd.conf && ok "CUPS job limits set for label bursts" || warn "CUPS limits not applied"
grep -q '^CUPS_ADMIN_USER=' "$ENV" && ok "CUPS admin for the LogShip web relay configured" || warn "no CUPS admin in agent.env"
INST="$(sed -n 's/^LOGSHIP_URL=//p' "$ENV" | head -1)"
if [ -n "$INST" ]; then
  if curl -fsS -o /dev/null --max-time 10 "$INST/signin"; then ok "instance reachable: $INST"; else warn "instance NOT reachable from this box: $INST"; fi
  TOK="$(sed -n 's/^LOGSHIP_AGENT_TOKEN=//p' "$ENV" | head -1)"
  if [ -n "$TOK" ]; then
    HB="$(curl -s -o /dev/null -w '%{http_code}' --max-time 15 -X POST -H "Authorization: Bearer $TOK" -H 'Content-Type: application/json' -d "{\"version\":\"$(logship-print-agent version)\"}" "$INST/api/print-agent/heartbeat")"
    [ "$HB" = 200 ] && ok "heartbeat accepted by the instance — the box now shows up under Einstellungen → Drucker → Druckserver" || warn "heartbeat answered $HB (token revoked? re-enrol with a new code)"
  fi
fi
Q="$(lpstat -p 2>/dev/null | awk '{print $2}' | tr '\n' ' ')"
[ -n "$Q" ] && ok "CUPS queues: $Q" || warn "no CUPS queues yet — plug in a USB Zebra (auto-provisioned) or use „Drucker einrichten“ / the CUPS UI in LogShip"
printf '\n\033[1mDone.\033[0m  Status: logship-print-agent status   Log: journalctl -u logship-print-agent -f   Setup page: http://%s:8080\n' "$(hostname -I | awk '{print $1}')"

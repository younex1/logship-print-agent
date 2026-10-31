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
export LC_ALL=C.UTF-8 LANG=C.UTF-8

URL=""; CODE=""; NAME=""; BUILD=0; NOENROLL=0; PKG_VERSION_OPT=""; INTERACTIVE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --url) URL="${2%/}"; shift 2 ;;
    --code) CODE="$2"; shift 2 ;;
    --name) NAME="$2"; shift 2 ;;
    --build) BUILD=1; shift ;;
    --no-enroll) NOENROLL=1; shift ;;
    --version) PKG_VERSION_OPT="$2"; shift 2 ;;
    --interactive) INTERACTIVE=1; shift ;;
    --non-interactive) INTERACTIVE=0; shift ;;
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
ask()  { local prompt="$1" default="${2:-}" reply; if [ -n "$default" ]; then read -r -p "  $prompt [$default]: " reply; echo "${reply:-$default}"; else read -r -p "  $prompt: " reply; echo "$reply"; fi; }

# ── wizard: ask for what is missing when a human is at the keyboard ─────────────────────────────
[ -z "$INTERACTIVE" ] && { [ -t 0 ] && INTERACTIVE=1 || INTERACTIVE=0; }
ALREADY_ENROLLED="$(sed -n 's/^LOGSHIP_AGENT_TOKEN=//p' /etc/logship-print-agent/agent.env 2>/dev/null | head -1)"
if [ "$INTERACTIVE" = 1 ] && [ "$NOENROLL" = 0 ] && [ -z "$CODE" ]; then
  step "LogShip Print Agent – Einrichtung / setup"
  if [ -n "$ALREADY_ENROLLED" ]; then
    echo "  Dieses Gerät ist bereits mit $(sed -n 's/^LOGSHIP_URL=//p' /etc/logship-print-agent/agent.env | head -1) verbunden."
    re="$(ask 'Neu verbinden (anderes LogShip / neuer Code)? j/N' 'N')"
    case "$re" in j|J|y|Y) ;; *) NOENROLL=1 ;; esac
  fi
  if [ "$NOENROLL" = 0 ]; then
    echo "  Code und URL: LogShip → Einstellungen → Drucker → „Druckserver verbinden“ (Code 24 h gültig, einmalig)."
    while :; do
      URL="$(ask 'LogShip-Instanz URL (z. B. https://erp.firma.de)' "${URL:-}")"; URL="${URL%/}"
      case "$URL" in https://*|http://*) ;; *) echo "    bitte mit https:// angeben"; continue ;; esac
      if curl -fsS -o /dev/null --max-time 10 "$URL/signin"; then echo "    ✔ erreichbar"; break; else echo "    ✘ $URL antwortet nicht – Schreibweise/Netzwerk prüfen (Enter = trotzdem weiter)"; r="$(ask 'erneut eingeben? j/N' 'N')"; case "$r" in j|J|y|Y) continue ;; *) break ;; esac; fi
    done
    while :; do
      CODE="$(ask 'Enrolment-Code (LSPA-XXXX-XXXX-XXXX)' "${CODE:-}")"; CODE="$(echo "$CODE" | tr '[:lower:]' '[:upper:]' | tr -d ' ')"
      case "$CODE" in LSPA-????-????-????) break ;; "") echo "    (leer = jetzt nicht verbinden)"; NOENROLL=1; break ;; *) echo "    Format: LSPA-XXXX-XXXX-XXXX" ;; esac
    done
    [ "$NOENROLL" = 0 ] && NAME="$(ask 'Gerätename, wie er in LogShip erscheinen soll' "${NAME:-$(hostname)}")"
  fi
fi

step "Checking the system"
# read os-release in a subshell: it defines VERSION/NAME and would clobber our variables
OS_ID="$(. /etc/os-release; echo "${ID:-}")"; OS_VER="$(. /etc/os-release; echo "${VERSION_ID:-0}")"; OS_PRETTY="$(. /etc/os-release; echo "${PRETTY_NAME:-unknown OS}")"
case "$OS_ID" in
  debian) [ "${OS_VER%%.*}" -ge 12 ] 2>/dev/null || warn "Debian ${OS_VER}: tested on 12 and 13" ;;
  ubuntu) warn "Ubuntu ${OS_VER}: should work (systemd + CUPS 2.4), not part of the test matrix" ;;
  *) warn "${OS_PRETTY}: untested" ;;
esac
case "$ARCH" in amd64|arm64) ok "architecture $ARCH" ;; *) fail "unsupported architecture $ARCH (amd64 or arm64)" ;; esac
command -v systemctl >/dev/null || fail "systemd is required"
ok "$OS_PRETTY"

step "Base packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq curl ca-certificates xz-utils gnupg >/dev/null
ok "curl / ca-certificates / xz-utils"

step "Agent package"
PKG_VERSION="${PKG_VERSION_OPT:-$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' package.json | head -1)}"
[ -n "$PKG_VERSION" ] || fail "could not determine the package version (package.json)"
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
  # the checkout usually belongs to the login user — do not leave root-owned build output behind
  OWNER="$(stat -c %u:%g "$REPO")"; chown -R "$OWNER" "$REPO/dist" "$REPO/build" "$REPO/node_modules" 2>/dev/null || true
  rm -rf "$TMP"
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
  if OUT="$(logship-print-agent enroll --url "$URL" --code "$CODE" ${NAME:+--name "$NAME"} 2>&1)"; then
    echo "$OUT" | sed 's/^/  /'
    systemctl restart logship-print-agent
    ok "enrolled"
  else
    echo "$OUT" | tail -3 | sed 's/^/  /'
    fail "enrolment refused — code wrong/used/expired? Create a new one in LogShip and run: sudo logship-print-agent enroll --url $URL --code LSPA-…"
  fi
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

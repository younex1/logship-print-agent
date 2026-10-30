#!/usr/bin/env bash
# Publishes dist/*.deb into the GPG-signed apt repository served by nginx on the edge VM
# (apt.logship.de → /var/www/apt). Run on the edge VM (or via Jenkins with ssh).
#   ./scripts/publish-apt.sh [stable|beta]
# One-time setup on the edge VM:
#   apt install reprepro gnupg; gpg --full-generate-key (RSA 4096, "LogShip Apt Signing")
#   mkdir -p /var/www/apt/conf && cat > /var/www/apt/conf/distributions <<EOF
#   Origin: LogShip
#   Label: LogShip
#   Codename: stable
#   Architectures: amd64 arm64
#   Components: main
#   Description: LogShip Print Agent
#   SignWith: <KEYID>
#
#   Origin: LogShip
#   Label: LogShip
#   Codename: beta
#   Architectures: amd64 arm64
#   Components: main
#   Description: LogShip Print Agent (beta)
#   SignWith: <KEYID>
#   EOF
#   gpg --armor --export <KEYID> > /var/www/apt/logship-apt.gpg
set -euo pipefail
cd "$(dirname "$0")/.."
CHANNEL="${1:-stable}"
REPO_DIR="${APT_REPO_DIR:-/var/www/apt}"
for deb in dist/*.deb; do
  echo "publishing $deb → $CHANNEL"
  reprepro -b "$REPO_DIR" includedeb "$CHANNEL" "$deb"
done
echo "done. devices pick it up via unattended-upgrades (Origin: LogShip) or the 'update' command in LogShip."

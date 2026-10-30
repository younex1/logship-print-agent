#!/usr/bin/env bash
# Builds the .deb packages (amd64 + arm64) with a bundled Node runtime.
#   VERSION=0.1.0 ./scripts/build.sh            → dist/logship-print-agent_0.1.0_{amd64,arm64}.deb
# Needs: node ≥ 22 (build host), nfpm (https://nfpm.goreleaser.com), curl, xz
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${VERSION:-$(node -p "require('./package.json').version")}"
NODE_VERSION="${NODE_VERSION:-22.22.3}"          # same major as the ERP prod host
ARCHES="${ARCHES:-amd64 arm64}"

command -v nfpm >/dev/null || { echo "nfpm missing: https://nfpm.goreleaser.com/install/"; exit 1; }

npm ci --no-audit --no-fund
VERSION="$VERSION" node scripts/bundle.mjs

mkdir -p build dist
for ARCH in $ARCHES; do
  case "$ARCH" in
    amd64) NODE_ARCH=x64 ;;
    arm64) NODE_ARCH=arm64 ;;
    *) echo "unsupported arch $ARCH"; exit 1 ;;
  esac
  TARBALL="node-v${NODE_VERSION}-linux-${NODE_ARCH}.tar.xz"
  if [ ! -f "build/$TARBALL" ]; then
    echo "downloading $TARBALL"
    curl -fsSL "https://nodejs.org/dist/v${NODE_VERSION}/${TARBALL}" -o "build/$TARBALL"
  fi
  mkdir -p "build/$ARCH"
  tar -xJf "build/$TARBALL" -C "build/$ARCH" --strip-components=2 "node-v${NODE_VERSION}-linux-${NODE_ARCH}/bin/node"
  chmod 755 "build/$ARCH/node"
  ARCH="$ARCH" VERSION="$VERSION" NODE_BIN="build/$ARCH/node" nfpm package -p deb -f packaging/nfpm.yaml -t dist/
done
ls -la dist/*.deb

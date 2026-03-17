#!/usr/bin/env bash
set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLI_DIR="$SCRIPT_DIR/../packages/cli"

cd "$CLI_DIR"

echo "Building CLI..."
npm run build

echo "Packing..."
TARBALL=$(npm pack 2>/dev/null | tail -1)

echo "Installing $TARBALL globally..."
npm install -g "$TARBALL"

rm "$TARBALL"

echo "Done. $(yeet --version 2>/dev/null || echo 'yeet installed')"

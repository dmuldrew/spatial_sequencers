#!/usr/bin/env bash
# Spatial Sequencers - local preview (macOS / Linux)
# Usage: ./preview.sh [port]
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js is required. Install it from https://nodejs.org and run this again." >&2
  exit 1
fi

if [ ! -d "pyrosync/node_modules/d3" ]; then
  echo "Installing PyroSync dependencies (first run only)..."
  (cd pyrosync && npm install --omit=dev --no-audit --no-fund)
fi

node preview.js "$@"

#!/usr/bin/env bash
# Build and deploy PyroSync static bundle to the GitHub Pages `gh-pages` branch.
# Usage:
#   ./scripts/deploy-gh-pages.sh            # Build bundle and push to origin/gh-pages
#   ./scripts/deploy-gh-pages.sh --dry-run  # Stage and verify static bundle without pushing
#   ./scripts/deploy-gh-pages.sh --build-only  # Output bundle into ./dist without pushing

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

MODE="deploy"
if [[ "${1:-}" == "--dry-run" ]]; then
  MODE="dry-run"
elif [[ "${1:-}" == "--build-only" ]]; then
  MODE="build-only"
fi

REMOTE_NAME="${GIT_REMOTE:-origin}"
PAGES_BRANCH="${PAGES_BRANCH:-gh-pages}"
IMAGE_NAME="spatial-sequencers-pyrosync:latest"

STAGE_DIR="$(mktemp -d)"
cleanup() {
  rm -rf "$STAGE_DIR"
}
trap cleanup EXIT

echo "Staging static PyroSync assets into temporary bundle..."
cp -R "$ROOT_DIR/public/." "$STAGE_DIR/"
mkdir -p "$STAGE_DIR/vendor"
touch "$STAGE_DIR/.nojekyll"

copy_vendor_from_dir() {
  local nm="$1"
  cp "$nm/d3/dist/d3.min.js" "$STAGE_DIR/vendor/d3.min.js"
  cp "$nm/tone/build/Tone.js" "$STAGE_DIR/vendor/Tone.js"
  cp "$nm/d3-audio/dist/d3-audio.js" "$STAGE_DIR/vendor/d3-audio.js"
  cp "$nm/three/build/three.module.min.js" "$STAGE_DIR/vendor/three.module.min.js"
  cp "$nm/apache-arrow/Arrow.esnext.min.js" "$STAGE_DIR/vendor/arrow.min.js"
  mkdir -p "$STAGE_DIR/vendor/maplibre"
  cp "$nm/maplibre-gl/dist/maplibre-gl.mjs" "$nm/maplibre-gl/dist/maplibre-gl-worker.mjs" \
     "$nm/maplibre-gl/dist/maplibre-gl.css" "$STAGE_DIR/vendor/maplibre/"
  cp "$nm/pmtiles/dist/pmtiles.js" "$STAGE_DIR/vendor/pmtiles.js"
  cp "$nm/topojson-client/dist/topojson-client.min.js" "$STAGE_DIR/vendor/topojson-client.min.js"
  cp "$nm/world-atlas/countries-110m.json" "$STAGE_DIR/vendor/countries-110m.json"
}

if [[ -d "$ROOT_DIR/node_modules/d3-audio" && -f "$ROOT_DIR/node_modules/three/build/three.module.min.js" ]]; then
  echo "Copying vendor libraries from local node_modules/..."
  copy_vendor_from_dir "$ROOT_DIR/node_modules"
elif command -v npm >/dev/null 2>&1 && npm --version >/dev/null 2>&1; then
  echo "Installing vendor dependencies into temporary workspace via npm..."
  TMP_NPM="$(mktemp -d)"
  cp "$ROOT_DIR/package.json" "$TMP_NPM/package.json"
  npm --prefix "$TMP_NPM" install --omit=dev --no-audit --no-fund >/dev/null
  copy_vendor_from_dir "$TMP_NPM/node_modules"
  rm -rf "$TMP_NPM"
elif command -v docker >/dev/null 2>&1; then
  echo "Extracting vendor libraries via Docker ($IMAGE_NAME)..."
  if ! docker image inspect "$IMAGE_NAME" >/dev/null 2>&1; then
    docker build -t "$IMAGE_NAME" "$ROOT_DIR"
  fi
  CID="$(docker create "$IMAGE_NAME")"
  docker cp "$CID:/app/node_modules/d3/dist/d3.min.js" "$STAGE_DIR/vendor/d3.min.js"
  docker cp "$CID:/app/node_modules/tone/build/Tone.js" "$STAGE_DIR/vendor/Tone.js"
  docker cp "$CID:/app/node_modules/d3-audio/dist/d3-audio.js" "$STAGE_DIR/vendor/d3-audio.js"
  docker cp "$CID:/app/node_modules/three/build/three.module.min.js" "$STAGE_DIR/vendor/three.module.min.js"
  docker cp "$CID:/app/node_modules/apache-arrow/Arrow.esnext.min.js" "$STAGE_DIR/vendor/arrow.min.js"
  mkdir -p "$STAGE_DIR/vendor/maplibre"
  for f in maplibre-gl.mjs maplibre-gl-worker.mjs maplibre-gl.css; do
    docker cp "$CID:/app/node_modules/maplibre-gl/dist/$f" "$STAGE_DIR/vendor/maplibre/$f"
  done
  docker cp "$CID:/app/node_modules/pmtiles/dist/pmtiles.js" "$STAGE_DIR/vendor/pmtiles.js"
  docker cp "$CID:/app/node_modules/topojson-client/dist/topojson-client.min.js" "$STAGE_DIR/vendor/topojson-client.min.js"
  docker cp "$CID:/app/node_modules/world-atlas/countries-110m.json" "$STAGE_DIR/vendor/countries-110m.json"
  docker rm -f "$CID" >/dev/null
else
  echo "Error: Neither local node_modules/, npm, nor docker was found to bundle vendor dependencies." >&2
  exit 1
fi

if [[ ! -f "$STAGE_DIR/.nojekyll" ]]; then
  echo "Error: Missing .nojekyll file" >&2
  exit 1
fi

REQUIRED_FILES=(
  "index.html"
  "styles.css"
  "js/app.js"
  "js/hub-nav.js"
  "js/flyby.js"
  "js/tour-content.js"
  "data/tour/narration.json"
  "js/enable-audio.js"
  "data/fire_weather_data.json"
  "midwest/map.html"
  "midwest/data/midwest.json"
  "global-fire/index.html"
  "global-fire/map.js"
  "data/global-fire/manifest.json"
  "data/global-fire/global_fire.pmtiles"
  "spaceship-flyby/index.html"
  "hub/index.html"
  "vendor/d3.min.js"
  "vendor/Tone.js"
  "vendor/d3-audio.js"
  "vendor/three.module.min.js"
  "vendor/arrow.min.js"
  "vendor/maplibre/maplibre-gl.mjs"
  "vendor/maplibre/maplibre-gl-worker.mjs"
  "vendor/maplibre/maplibre-gl.css"
  "vendor/pmtiles.js"
  "vendor/topojson-client.min.js"
  "vendor/countries-110m.json"
)

for f in "${REQUIRED_FILES[@]}"; do
  if [[ ! -s "$STAGE_DIR/$f" ]]; then
    echo "Error: Missing or empty staged file: $f" >&2
    exit 1
  fi
done

echo "Verified staged bundle files:"
ls -lh "$STAGE_DIR/vendor" "$STAGE_DIR/data"

if [[ "$MODE" == "dry-run" ]]; then
  echo "Dry run succeeded — static bundle is complete and ready to push to $REMOTE_NAME/$PAGES_BRANCH."
  exit 0
fi

if [[ "$MODE" == "build-only" ]]; then
  rm -rf "$ROOT_DIR/dist"
  mkdir -p "$ROOT_DIR/dist"
  cp -R "$STAGE_DIR/." "$ROOT_DIR/dist/"
  echo "Static bundle built at ./dist"
  exit 0
fi

REMOTE_URL="$(git remote get-url "$REMOTE_NAME")"
SOURCE_SHA="$(git rev-parse --short HEAD)"

echo "Deploying static bundle ($SOURCE_SHA) to $REMOTE_URL ($PAGES_BRANCH)..."
git -C "$STAGE_DIR" init -q
git -C "$STAGE_DIR" checkout -q -b "$PAGES_BRANCH"
git -C "$STAGE_DIR" add -A
git -C "$STAGE_DIR" commit -q -m "Deploy PyroSync GitHub Pages ($SOURCE_SHA)"
git -C "$STAGE_DIR" push --force "$REMOTE_URL" "HEAD:$PAGES_BRANCH"

echo ""
echo "Deployed to branch '$PAGES_BRANCH' on $REMOTE_URL."
if [[ "$REMOTE_URL" =~ github\.com[:/]([^/]+)/([^/.]+)(\.git)?$ ]]; then
  OWNER="${BASH_REMATCH[1]}"
  REPO="${BASH_REMATCH[2]}"
  echo "GitHub Pages URL (after enabling Settings -> Pages -> Branch '$PAGES_BRANCH' / '(root)'):"
  echo "  https://${OWNER}.github.io/${REPO}/"
fi

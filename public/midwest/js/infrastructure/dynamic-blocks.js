const ENDPOINT = new URL('../../../api/midwest/', import.meta.url);
const MAX_RAW_BYTES = 24_000_000;

async function responseJSON(response) {
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || 'Unable to prepare the map block.');
  return data;
}

const mercator = latitude => Math.asinh(Math.tan(latitude * Math.PI / 180));
const latitudeAt = value => Math.atan(Math.sinh(value)) * 180 / Math.PI;

export function coordinates(id) {
  const match = /^(-?\d+)-(-?\d+)$/.exec(id);
  if (!match) throw new Error('Invalid map block ID.');
  return [Number(match[1]), Number(match[2])];
}

export function extendManifest(manifest, coverage) {
  const reference = manifest.blocks['1-1'].bounds;
  const dx = reference.east - reference.west;
  const dy = mercator(reference.north) - mercator(reference.south);
  const x0 = reference.west - dx;
  const y0 = mercator(reference.south) - dy;
  const blocks = { ...manifest.blocks };
  for (let x = Math.floor((coverage.west - x0) / dx); x < Math.ceil((coverage.east - x0) / dx); x += 1) {
    for (let y = Math.floor((mercator(coverage.south) - y0) / dy);
      y < Math.ceil((mercator(coverage.north) - y0) / dy); y += 1) {
      const id = `${x}-${y}`;
      // The southern row of the bundled archive is clipped at 40.01°N.
      if (blocks[id] && y !== 0) continue;
      blocks[id] = {
        dynamic: true,
        bytes: 1_000_000,
        bounds: {
          west: x0 + x * dx, east: x0 + (x + 1) * dx,
          south: latitudeAt(y0 + y * dy), north: latitudeAt(y0 + (y + 1) * dy),
        },
      };
    }
  }
  return { ...manifest, coverage, blocks, cacheKey: `${manifest.cacheKey}-dynamic-v1` };
}

export async function enableDynamicBlocks(manifest, signal) {
  try {
    const response = await fetch(new URL('config', ENDPOINT), {
      signal: AbortSignal.any([signal, AbortSignal.timeout(1500)]),
    });
    const { coverage } = await responseJSON(response);
    if (coverage && ['west', 'south', 'east', 'north'].every(key => Number.isFinite(coverage[key]))) {
      return extendManifest(manifest, coverage);
    }
  } catch {
    signal.throwIfAborted();
  }
  return manifest;
}

export async function planRemoteBlock(id, signal) {
  const response = await fetch(new URL(`blocks/${id}/plan`, ENDPOINT), { signal });
  const { sourceBytes } = await responseJSON(response);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 || sourceBytes > MAX_RAW_BYTES) {
    throw new Error('Invalid MODIS download estimate.');
  }
  return sourceBytes;
}

export function fetchRemoteBlock(id, budget, signal) {
  return fetch(new URL(`blocks/${id}?budget=${budget}`, ENDPOINT), { signal });
}

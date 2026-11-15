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
  return { ...manifest, coverage, blocks, dynamic: true, cacheKey: `${manifest.cacheKey}-dynamic-v1` };
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

export function regionalManifest(manifest, bounds, date) {
  const dx = (bounds.east - bounds.west) / 2;
  const dy = (mercator(bounds.north) - mercator(bounds.south)) / 2;
  const x0 = (bounds.east + bounds.west - dx) / 2;
  const y0 = (mercator(bounds.north) + mercator(bounds.south) - dy) / 2;
  const coverage = {
    west: Math.max(-180, x0 - 4 * dx), east: Math.min(180, x0 + 5 * dx),
    south: Math.max(-85, latitudeAt(y0 - 4 * dy)), north: Math.min(85, latitudeAt(y0 + 5 * dy)),
  };
  const blocks = {};
  for (let x = -4; x <= 4; x += 1) {
    for (let y = -4; y <= 4; y += 1) {
      const west = Math.max(coverage.west, x0 + x * dx);
      const east = Math.min(coverage.east, x0 + (x + 1) * dx);
      const south = Math.max(coverage.south, latitudeAt(y0 + y * dy));
      const north = Math.min(coverage.north, latitudeAt(y0 + (y + 1) * dy));
      if (west >= east || south >= north) continue;
      blocks[`${x}-${y}`] = { dynamic: true, custom: true, bytes: 1_000_000,
        bounds: { west, south, east, north } };
    }
  }
  return {
    ...manifest, coverage, blocks, date,
    cacheKey: `regional-v1:${Object.values(bounds).join(',')}:${date}`,
    unavailable: !manifest.dynamic,
  };
}

function blockURL(id, entry, date, suffix = '') {
  const url = new URL(`blocks/${id}${suffix}`, ENDPOINT);
  if (date) url.searchParams.set('date', date);
  if (entry.custom) {
    const { west, south, east, north } = entry.bounds;
    url.searchParams.set('bounds', [west, south, east, north].map(value => value.toFixed(7)).join(','));
  }
  return url;
}

export async function planRemoteBlock(id, entry, date, signal) {
  const response = await fetch(blockURL(id, entry, date, '/plan'), { signal });
  const { sourceBytes } = await responseJSON(response);
  if (!Number.isSafeInteger(sourceBytes) || sourceBytes < 0 || sourceBytes > MAX_RAW_BYTES) {
    throw new Error('Invalid MODIS download estimate.');
  }
  return sourceBytes;
}

export function fetchRemoteBlock(id, entry, date, budget, signal) {
  const url = blockURL(id, entry, date);
  url.searchParams.set('budget', budget);
  return fetch(url, { signal });
}

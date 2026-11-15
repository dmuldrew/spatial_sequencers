const URL_PATH = new URL('../../data/fires-2024-07-11.json', import.meta.url);
const ENDPOINT = new URL('../../../api/midwest/', import.meta.url);

export async function loadContext(kind, bounds, date, signal) {
  const { west, south, east, north } = bounds;
  const url = new URL(kind, ENDPOINT);
  url.searchParams.set('bounds', [west, south, east, north].join(','));
  url.searchParams.set('date', date);
  const response = await fetch(url, { signal });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(data.error || 'Context data unavailable.');
  return data;
}

export async function loadFireDetections(bounds, date, signal) {
  const data = bounds
    ? await loadContext('fires', bounds, date, signal)
    : await fetchBundled(signal);
  const { start, end, points } = data;
  // FIRMS type 0 denotes presumed vegetation fire.
  const detections = points.filter(row => row[7] === 0).map(
    ([latitude, longitude, date, time, satellite, confidence, power]) =>
      ({ latitude, longitude, date, time, satellite, confidence, power }),
  );
  return { start, end, points: detections };
}

async function fetchBundled(signal) {
  const response = await fetch(URL_PATH, { signal });
  if (!response.ok) throw new Error('MODIS hotspots could not be loaded.');
  return response.json();
}

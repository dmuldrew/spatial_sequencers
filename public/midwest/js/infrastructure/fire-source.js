const URL_PATH = new URL('../../data/fires-2024-07-11.json', import.meta.url);

export async function loadFireDetections() {
  const response = await fetch(URL_PATH, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error('MODIS hotspots could not be loaded.');
  const { start, end, points } = await response.json();
  // FIRMS type 0 denotes presumed vegetation fire.
  const detections = points.filter(row => row[7] === 0).map(
    ([latitude, longitude, date, time, satellite, confidence, power]) =>
      ({ latitude, longitude, date, time, satellite, confidence, power }),
  );
  return { start, end, points: detections };
}

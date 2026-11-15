export const DEFAULT_SELECTION = Object.freeze({
  latitude: 42.57, longitude: -96.52, date: '2024-07-11',
});

const DAY_MS = 86_400_000;
const isoDate = time => new Date(time).toISOString().slice(0, 10);

export function observationWindow(start) {
  const time = Date.parse(`${start}T00:00:00Z`);
  const year = Number(start.slice(0, 4));
  const jan1 = Date.UTC(year, 0, 1);
  const composite = jan1 + Math.floor((time - jan1) / DAY_MS / 16) * 16 * DAY_MS;
  return {
    start,
    end: isoDate(Math.min(time + 15 * DAY_MS, Date.now())),
    compositeStart: isoDate(composite),
    compositeEnd: isoDate(Math.min(composite + 15 * DAY_MS, Date.UTC(year, 11, 31))),
  };
}

export function sameCenter(a, b) {
  return a.latitude === b.latitude && a.longitude === b.longitude;
}

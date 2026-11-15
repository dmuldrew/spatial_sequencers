const MINUTE_MS = 60_000;
const DAY_MINUTES = 1_440;
export const MINUTES_PER_SECOND = 1440;

export function fireTimeline({ start, end, points }) {
  const startTime = Date.parse(`${start}T00:00:00Z`);
  const endTime = Date.parse(`${end}T00:00:00Z`);
  const lastMinute = (endTime - startTime) / MINUTE_MS + DAY_MINUTES - 1;
  if (!Number.isSafeInteger(lastMinute) || lastMinute < 0) {
    throw new Error('Invalid fire observation dates.');
  }
  const events = points.map(point => ({
    ...point,
    minute: (Date.parse(`${point.date}T${point.time.slice(0, 2)}:${point.time.slice(2)}:00Z`)
      - startTime) / MINUTE_MS,
  })).filter(point => Number.isSafeInteger(point.minute)
    && point.minute >= 0 && point.minute <= lastMinute)
    .sort((a, b) => a.minute - b.minute);
  return { startTime, lastMinute, events };
}

export function countThrough(events, minute) {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (events[middle].minute <= minute) low = middle + 1;
    else high = middle;
  }
  return low;
}

export function timeAt(timeline, minute) {
  return new Date(timeline.startTime + minute * MINUTE_MS);
}

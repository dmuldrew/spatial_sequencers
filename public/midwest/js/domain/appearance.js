/** User-defined appearance algorithm. No map, DOM, or dataset dependencies. */
export const APPEARANCE = Object.freeze({
  greenHue: 120,
  brownHue: 30,
  minimumSaturation: 75,
  maximumSaturation: 150,
  lightnessPercent: 35,
  missingColor: '#aeb6b5',
});

export function rangeOf(values) {
  const valid = values.filter(Number.isFinite);
  if (!valid.length) return null;
  return valid.reduce((range, value) => ({
    min: Math.min(range.min, value),
    max: Math.max(range.max, value),
  }), { min: Infinity, max: -Infinity });
}

export function normalize(value, range) {
  if (!Number.isFinite(value) || !range) return null;
  if (range.max === range.min) return 0.5;
  return Math.max(0, Math.min(1, (value - range.min) / (range.max - range.min)));
}

export function viewportRanges(cells) {
  // Each named input has its own range; missing values do not become zero.
  return {
    A1: rangeOf(cells.map(cell => cell.A1)),
    A2: rangeOf(cells.map(cell => cell.A2)),
  };
}

export function appearanceFor(cell, ranges) {
  const A1 = normalize(cell.A1, ranges.A1);
  const A2 = normalize(cell.A2, ranges.A2);
  if (A1 === null || A2 === null) {
    return { color: APPEARANCE.missingColor, A1, A2, missing: true };
  }
  const hue = APPEARANCE.greenHue
    + A1 * (APPEARANCE.brownHue - APPEARANCE.greenHue);
  const saturation = APPEARANCE.minimumSaturation
    + A2 * (APPEARANCE.maximumSaturation - APPEARANCE.minimumSaturation);
  return {
    color: `hsl(${hue}, ${saturation / 255 * 100}%, ${APPEARANCE.lightnessPercent}%)`,
    A1,
    A2,
    hue,
    saturation,
    missing: false,
  };
}

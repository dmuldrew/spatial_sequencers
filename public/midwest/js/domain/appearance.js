/** User-defined appearance algorithm. No map, DOM, or dataset dependencies. */
export const APPEARANCE = Object.freeze({
  greenHue: 120,
  brownHue: 30,
  minimumSaturation: 0.05,
  maximumSaturation: 0.95,
  lightnessPercent: 35,
  missingColor: '#aeb6b5',
});

function quantile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function rangeOf(values) {
  const valid = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!valid.length) return null;

  // Clip the tails for contrast. Small views use the observed range because
  // a few cells are too few to estimate stable percentile cutoffs.
  const clip = valid.length >= 20 ? 0.05 : 0;
  const min = quantile(valid, clip);
  const max = quantile(valid, 1 - clip);
  return min < max ? { min, max } : { min: valid[0], max: valid.at(-1) };
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
  return { ...colorFor(A1, A2), A1, A2, missing: false };
}

export function colorFor(temperature, vegetation) {
  const hue = APPEARANCE.greenHue
    + temperature * (APPEARANCE.brownHue - APPEARANCE.greenHue);
  const saturation = APPEARANCE.minimumSaturation
    + vegetation * (APPEARANCE.maximumSaturation - APPEARANCE.minimumSaturation);
  return {
    color: `hsl(${hue}, ${saturation * 100}%, ${APPEARANCE.lightnessPercent}%)`,
    hue,
    saturation,
  };
}

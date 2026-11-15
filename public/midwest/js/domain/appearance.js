/** User-defined appearance algorithm. No map, DOM, or dataset dependencies. */
export const APPEARANCE = Object.freeze({
  minimumSaturation: 0.05,
  maximumSaturation: 0.95,
  lightnessPercent: 35,
  mutedLightnessPercent: 58,
  missingColor: '#aeb6b5',
});

const GREEN_BROWN = [120, 30];
// Original palette: rows go from low to high A2, columns from low to high A1.
const BLUE_ORANGE = [
  ['#ede9e3', '#e9b997', '#c44f0b'],
  ['#a7c8db', '#c7b7ab', '#bb7654'],
  ['#15628e', '#5486a0', '#6c677d'],
];

export function normalize(value, range) {
  if (!Number.isFinite(value) || !range) return null;
  if (range.max === range.min) return 0.5;
  const fraction = Math.max(0, Math.min(1, (value - range.min) / (range.max - range.min)));
  const centered = 2 * fraction - 1;
  // Double the slope at the midpoint and keep the full observed range distinct.
  return 0.5 + centered / (1 + Math.abs(centered));
}

export function observedRanges(cells) {
  const ranges = { A1: null, A2: null };
  for (const cell of cells) {
    for (const key of ['A1', 'A2']) {
      const value = cell[key];
      if (!Number.isFinite(value)) continue;
      const range = ranges[key] ??= { min: value, max: value };
      range.min = Math.min(range.min, value);
      range.max = Math.max(range.max, value);
    }
  }
  return ranges;
}

function quantile(sorted, fraction) {
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  return sorted[lower] + (sorted[upper] - sorted[lower]) * (position - lower);
}

export function datasetBreaks(cells) {
  const paired = [...cells].filter(cell => Number.isFinite(cell.A1) && Number.isFinite(cell.A2));
  return Object.fromEntries(['A1', 'A2'].map(key => {
    const sorted = paired.map(cell => cell[key]).sort((a, b) => a - b);
    return [key, sorted.length ? [quantile(sorted, 1 / 3), quantile(sorted, 2 / 3)] : null];
  }));
}

function classIndex(value, breaks) {
  if (!Number.isFinite(value) || !breaks) return null;
  const [low, high] = breaks;
  return value < low ? 0 : value > high ? 2 : 1;
}

export function appearanceFor(cell, ranges, palette, breaks) {
  const secondary = normalize(cell.A2, ranges.A2);
  if (secondary !== null && !Number.isFinite(cell.A1)) {
    return { color: `hsl(141, 52%, ${90 - secondary * 64}%)`, missing: false };
  }
  if (palette === 'blue-orange') {
    const primaryClass = classIndex(cell.A1, breaks?.A1);
    const secondaryClass = classIndex(cell.A2, breaks?.A2);
    if (primaryClass === null || secondaryClass === null) {
      return { color: APPEARANCE.missingColor, missing: true };
    }
    return { color: BLUE_ORANGE[secondaryClass][primaryClass], missing: false };
  }
  const primary = normalize(cell.A1, ranges.A1);
  if (primary === null || secondary === null) {
    return { color: APPEARANCE.missingColor, missing: true };
  }
  return { color: colorFor(primary, secondary, palette), missing: false };
}

export function colorFor(primary, secondary, palette) {
  if (palette === 'blue-orange') {
    return BLUE_ORANGE[Math.round(secondary * 2)][Math.round(primary * 2)];
  }
  const [cool, warm] = GREEN_BROWN;
  const hue = cool + primary * (warm - cool);
  const saturation = APPEARANCE.minimumSaturation
    + secondary * (APPEARANCE.maximumSaturation - APPEARANCE.minimumSaturation);
  const lightness = APPEARANCE.mutedLightnessPercent
    + secondary * (APPEARANCE.lightnessPercent - APPEARANCE.mutedLightnessPercent);
  return `hsl(${hue}, ${saturation * 100}%, ${lightness}%)`;
}

/** User-defined appearance algorithm. No map, DOM, or dataset dependencies. */
export const APPEARANCE = Object.freeze({
  greenHue: 120,
  brownHue: 30,
  minimumSaturation: 0.05,
  maximumSaturation: 0.95,
  lightnessPercent: 35,
  mutedLightnessPercent: 58,
  missingColor: '#aeb6b5',
});

export const CLASSIFIED = 'classified';
export const FIRE_TIMELINE = 'fire-timeline';
export const NDVI_RANGE = Object.freeze({ min: 0.45, max: 0.95 });

export function ndviAppearance(value) {
  const amount = normalize(value, NDVI_RANGE);
  return {
    color: amount === null ? APPEARANCE.missingColor : `hsl(141, 52%, ${90 - amount * 64}%)`,
    missing: amount === null,
  };
}

// Rows run from low to high NDVI. Columns run from cool to warm.
const CLASS_COLORS = [
  ['#ede9e3', '#e9b997', '#c44f0b'],
  ['#a7c8db', '#c7b7ab', '#bb7654'],
  ['#15628e', '#5486a0', '#6c677d'],
];

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

export function appearanceFor(cell, ranges, mode, breaks) {
  if (mode === CLASSIFIED) {
    const temperature = classIndex(cell.A1, breaks.A1);
    const vegetation = classIndex(cell.A2, breaks.A2);
    if (temperature === null || vegetation === null) {
      return { color: APPEARANCE.missingColor, missing: true };
    }
    return {
      color: CLASS_COLORS[vegetation][temperature],
      temperatureClass: temperature,
      vegetationClass: vegetation,
      missing: false,
    };
  }
  const A1 = normalize(cell.A1, ranges.A1);
  const A2 = normalize(cell.A2, ranges.A2);
  if (A1 === null || A2 === null) {
    return { color: APPEARANCE.missingColor, A1, A2, missing: true };
  }
  return { ...colorFor(A1, A2), A1, A2, missing: false };
}

export function colorFor(temperature, vegetation, mode) {
  if (mode === CLASSIFIED) {
    return { color: CLASS_COLORS[Math.round(vegetation * 2)][Math.round(temperature * 2)] };
  }
  const hue = APPEARANCE.greenHue
    + temperature * (APPEARANCE.brownHue - APPEARANCE.greenHue);
  const saturation = APPEARANCE.minimumSaturation
    + vegetation * (APPEARANCE.maximumSaturation - APPEARANCE.minimumSaturation);
  const lightness = APPEARANCE.mutedLightnessPercent
    + vegetation * (APPEARANCE.lightnessPercent - APPEARANCE.mutedLightnessPercent);
  return {
    color: `hsl(${hue}, ${saturation * 100}%, ${lightness}%)`,
    hue,
    saturation,
  };
}

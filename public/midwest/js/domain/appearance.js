/** User-defined appearance algorithm. No map, DOM, or dataset dependencies. */
const MISSING_COLOR = '#aeb6b5';

// Adapted from ColorBrewer's YlGn and YlOrBr, with distinct muted low stops.
// https://colorbrewer2.org/
const [COOL_RAMP, WARM_RAMP] = [
  [0xc9e6d1, 0xc2e699, 0x78c679, 0x31a354, 0x006837],
  [0xf5e0c8, 0xfed98e, 0xfe9929, 0xd95f0e, 0x993404],
].map(ramp => ramp.map(color => [16, 8, 0].map(shift => (color >> shift) & 0xff)));

// Orange Cyan (OrCy), Jonatan Hildén, Bivariate hue blending (2022), appendix.
// https://aaltodoc.aalto.fi/bitstream/123456789/119235/1/master_Hilden_Jonatan_2022.pdf
// Rows go from low to high A2, columns from low to high A1.
const ORANGE_CYAN = [
  ['#f1f1f1', '#f5ca5a', '#ee8b15'],
  ['#73dbfb', '#ada09e', '#9e550d'],
  ['#00aef1', '#296d9c', '#3f212a'],
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
  if (palette === 'orange-cyan') {
    const primaryClass = classIndex(cell.A1, breaks?.A1);
    const secondaryClass = classIndex(cell.A2, breaks?.A2);
    if (primaryClass === null || secondaryClass === null) {
      return { color: MISSING_COLOR, missing: true };
    }
    return { color: ORANGE_CYAN[secondaryClass][primaryClass], missing: false };
  }
  const primary = normalize(cell.A1, ranges.A1);
  if (primary === null || secondary === null) {
    return { color: MISSING_COLOR, missing: true };
  }
  return { color: colorFor(primary, secondary, palette), missing: false };
}

function mixColor(from, to, amount) {
  return from.map((channel, index) => channel + (to[index] - channel) * amount);
}

function sampleRamp(ramp, amount) {
  const position = amount * (ramp.length - 1);
  const index = Math.min(Math.floor(position), ramp.length - 2);
  return mixColor(ramp[index], ramp[index + 1], position - index);
}

export function colorFor(primary, secondary, palette) {
  if (palette === 'orange-cyan') {
    return ORANGE_CYAN[Math.round(secondary * 2)][Math.round(primary * 2)];
  }
  const cool = sampleRamp(COOL_RAMP, secondary);
  const warm = sampleRamp(WARM_RAMP, secondary);
  return `rgb(${mixColor(cool, warm, primary).map(Math.round).join(', ')})`;
}

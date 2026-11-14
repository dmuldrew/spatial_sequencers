import { INPUTS, coarsestResolution } from './domain/inputs.js';
import { STUDY_AREA, areaBounds } from './domain/study-area.js';
import { appearanceFor, colorFor, viewportRanges } from './domain/appearance.js';
import { preferredH3Resolution, ZOOM_POLICY } from './domain/zoom-policy.js';
import { loadBundledDataset, loadDatasetFile } from './infrastructure/data-source.js';
import { aggregateSamples, visibleGrid } from './infrastructure/hex-grid.js';
import { MapView } from './infrastructure/map-view.js';

const element = id => document.getElementById(id);
const studyBounds = areaBounds();
let hasObservations = false;
let loadError = null;
let aggregates = new Map();
let activeResolution = coarsestResolution();
let h3Resolution = preferredH3Resolution(activeResolution, h3);
let requestVersion = 0;
let renderFrame = null;

function scheduleRender() {
  if (renderFrame !== null) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}

const view = new MapView('map', studyBounds, scheduleRender);

function formatValue(value, units = '') {
  return Number.isFinite(value) ? `${value.toFixed(2)} ${units}`.trim() : 'No data';
}

function formatRange(range, units) {
  return range ? `${formatValue(range.min)} – ${formatValue(range.max, units)}` : 'No observations';
}

function cellPopup(cell, appearance) {
  const container = document.createElement('div');
  const lines = [
    `H3 ${cell.id} · resolution ${h3Resolution}`,
    ...Object.entries(INPUTS).map(([key, input]) => {
      const value = formatValue(cell[key], input.units);
      const normalized = formatValue(appearance[key]);
      return `${input.product} ${input.label}: ${value} (normalized: ${normalized})`;
    }),
    appearance.missing ? 'Both inputs are required for color.'
      : `Hue: ${appearance.hue.toFixed(1)}° · saturation: ${Math.round(appearance.saturation * 100)}%`,
  ];
  for (const text of lines) {
    const line = document.createElement('div');
    line.textContent = text;
    container.append(line);
  }
  return container;
}

function render() {
  const cells = visibleGrid(view.getBounds(), studyBounds, h3Resolution, aggregates, h3);
  const ranges = viewportRanges(cells);
  view.render(cells, cell => appearanceFor(cell, ranges), cellPopup);
  const complete = cells.filter(cell => Number.isFinite(cell.A1) && Number.isFinite(cell.A2));
  element('cell-count').textContent = complete.length.toLocaleString();
  element('grid-count').textContent = cells.length.toLocaleString();
  element('a1-range').textContent = formatRange(ranges.A1, INPUTS.A1.units);
  element('a2-range').textContent = formatRange(ranges.A2, INPUTS.A2.units);
  element('zoom').value = view.getZoomPercent();
  element('zoomLabel').textContent = `${view.widthMiles().toFixed(1)} miles across`;
  element('grid-resolution').textContent = h3Resolution;
  if (loadError) {
    element('status').textContent = loadError;
  } else if (hasObservations) {
    element('status').textContent = complete.length
      ? `${complete.length.toLocaleString()} cells with both measurements.`
      : 'No paired observations in this view. Gray cells indicate missing temperature or vegetation data.';
  }
}

function installDataset(next) {
  activeResolution = coarsestResolution(next.inputs);
  h3Resolution = next.cells ? next.h3Resolution : preferredH3Resolution(activeResolution, h3);
  aggregates = next.cells
    ? new Map(next.cells.map(cell => [cell.id, cell]))
    : aggregateSamples(next.samples, h3Resolution, studyBounds, h3);
  hasObservations = (next.cells ?? next.samples).length > 0;
  loadError = null;
  element('window').textContent = next.periodLabel || 'Observation dates unavailable';
  element('provenance').textContent = next.description || 'Prepared map dataset';
  element('data-state').textContent = hasObservations ? 'Observed data' : 'Data unavailable';
  element('zoom-policy').textContent = `Closest view: at least ${ZOOM_POLICY.minimumPixelsAcross} pixels across at the coarser input resolution (${activeResolution.toLocaleString()} m).`;
  element('status').textContent = hasObservations ? 'Preparing paired cells…'
    : 'This dataset contains no observations.';
  view.updateLimits(activeResolution, true);
  render();
}

async function load(loader) {
  const version = ++requestVersion;
  try {
    const next = await loader();
    if (version === requestVersion) installDataset(next);
  } catch (error) {
    if (version === requestVersion) {
      loadError = error.message;
      element('status').textContent = loadError;
    }
  }
}

function bindControls() {
  element('zoom').addEventListener('input', event => view.setZoomPercent(Number(event.target.value)));
  element('fit').addEventListener('click', () => view.reset());
  element('reload').addEventListener('click', () => load(loadBundledDataset));
  element('file').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) load(() => loadDatasetFile(file));
    event.target.value = '';
  });
  new ResizeObserver(() => {
    view.updateLimits(activeResolution);
    scheduleRender();
  }).observe(element('map'));
}

// The parent dashboard embeds this standalone map without a second scrollbar.
const frame = window.frameElement;
if (frame) {
  document.body.classList.add('embedded');
  new ResizeObserver(() => {
    frame.style.height = `${Math.ceil(document.body.getBoundingClientRect().height)}px`;
  }).observe(document.body);
}

function renderColorLegend() {
  const swatches = [];
  for (const vegetation of [1, 0.5, 0]) {
    for (const temperature of [0, 0.5, 1]) {
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = colorFor(temperature, vegetation).color;
      swatches.push(swatch);
    }
  }
  element('color-swatches').replaceChildren(...swatches);
}

renderColorLegend();
element('region-name').textContent = STUDY_AREA.name;
for (const [key, input] of Object.entries(INPUTS)) {
  const id = key.toLowerCase();
  const encoding = { A1: 'Hue', A2: 'Saturation' };
  element(`${id}-encoding`).textContent = `${input.product} · ${encoding[key]}`;
  element(`${id}-name`).textContent = input.label;
  element(`${id}-key`).textContent = `${input.product} · ${input.label}`;
  element(`${id}-details`).textContent =
    `${input.units} · nominal ${input.resolutionMeters.toLocaleString()} m / ${input.compositeDays} days.`;
}
view.updateLimits(activeResolution, true);
bindControls();
load(loadBundledDataset);

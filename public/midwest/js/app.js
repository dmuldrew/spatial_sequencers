import { INPUTS, coarsestResolution } from './domain/inputs.js';
import { STUDY_AREA, areaBounds } from './domain/study-area.js';
import {
  appearanceFor, CLASSIFIED, colorFor, datasetBreaks, FIRE_TIMELINE, ndviAppearance, NDVI_RANGE, viewportRanges,
} from './domain/appearance.js';
import { preferredH3Resolution, ZOOM_POLICY } from './domain/zoom-policy.js';
import { loadDatasetFile } from './infrastructure/data-source.js';
import { BlockSource, loadManifest } from './infrastructure/block-source.js';
import { countThrough, fireTimeline } from './domain/fire-timeline.js';
import { TimelinePlayer } from './infrastructure/timeline-player.js';
import { loadFireDetections } from './infrastructure/fire-source.js';
import { DownloadGate } from './infrastructure/download-gate.js';
import { aggregateSamples, visibleGrid } from './infrastructure/hex-grid.js';
import { MapView } from './infrastructure/map-view.js';

const element = id => document.getElementById(id);
const studyBounds = areaBounds();
const FIRE_START = [42.57, -96.52];
let archive = null;
let firstBundledView = true;
let loadingBlocks = false;
const PAN_HINT = 'Focus the map and use the arrow keys to move one screen.';
let hasObservations = false;
let loadError = null;
let sourceDescription = '';
let aggregates = new Map();
let breaks = datasetBreaks([]);
let palette = FIRE_TIMELINE;
const classNames = ['Low', 'Middle', 'High'];
let activeResolution = coarsestResolution();
let h3Resolution = preferredH3Resolution(activeResolution, h3);
let requestVersion = 0;
let renderFrame = null;
let blockSource = null;
let roaming = false;
let blockStatus = '';
let manifestGate = null;

function scheduleRender() {
  if (renderFrame !== null) cancelAnimationFrame(renderFrame);
  renderFrame = requestAnimationFrame(() => {
    renderFrame = null;
    render();
  });
}

const view = new MapView('map', studyBounds, () => {
  element('map-navigation').textContent = PAN_HINT;
  player.showAll();
  scheduleRender();
  if (!manifestGate) blockSource?.update(view.getBounds());
});

const player = new TimelinePlayer({
  slider: element('fire-progress'),
  replay: element('fire-replay'),
  clock: element('fire-clock'),
  onSeek: renderFireLayer,
  onPlay: () => { element('fire-toggle').checked = true; },
});

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
    ...Object.entries(INPUTS).filter(([key]) => palette !== FIRE_TIMELINE || key === 'A2')
      .map(([key, input]) => (
        `${input.product} ${input.label}: ${formatValue(cell[key], input.units)}`
      )),
  ];
  if (palette === FIRE_TIMELINE) {
    lines.push('MOD13Q1 · 16-day vegetation composite');
  } else if (appearance.missing) {
    lines.push('Both measurements are required for color.');
  } else if (palette === CLASSIFIED) {
    lines.push(`${classNames[appearance.temperatureClass]} temperature · ${classNames[appearance.vegetationClass]} NDVI`);
  } else {
    lines.push(
      `Normalized temperature: ${formatValue(appearance.A1)} · NDVI: ${formatValue(appearance.A2)}`,
      `Hue: ${appearance.hue.toFixed(1)}° · saturation: ${Math.round(appearance.saturation * 100)}%`,
    );
  }
  for (const text of lines) {
    const line = document.createElement('div');
    line.textContent = text;
    container.append(line);
  }
  return container;
}

function render() {
  const mapBounds = roaming ? blockSource.manifest.coverage : studyBounds;
  const cells = visibleGrid(view.getBounds(), mapBounds, h3Resolution, aggregates, h3);
  renderFireLayer();
  const ndviOnly = palette === FIRE_TIMELINE;
  const ranges = palette === 'continuous' ? viewportRanges(cells) : null;
  view.render(cells, cell => ndviOnly ? ndviAppearance(cell.A2)
    : appearanceFor(cell, ranges, palette, breaks), cellPopup);
  const complete = cells.filter(cell => Number.isFinite(cell.A2)
    && (ndviOnly || Number.isFinite(cell.A1)));
  element('cell-count').textContent = complete.length.toLocaleString();
  element('cell-count-label').textContent = ndviOnly ? 'cells with NDVI' : 'cells with both inputs';
  element('grid-count').textContent = cells.length.toLocaleString();
  if (!ndviOnly) {
    for (const [key, input] of Object.entries(INPUTS)) {
      const bounds = breaks[key];
      element(`${key.toLowerCase()}-range`).textContent = ranges
        ? formatRange(ranges[key], input.units)
        : bounds ? `Breaks at ${bounds.map(value => value.toFixed(3)).join(' and ')} ${input.units}`
          : 'No paired observations';
    }
  }
  element('zoom').value = view.getZoomPercent();
  element('zoomLabel').textContent = `${view.widthMiles().toFixed(1)} miles across`;
  element('grid-resolution').textContent = h3Resolution;
  if (loadError) {
    element('status').textContent = loadError;
  } else if (blockStatus) {
    element('status').textContent = blockStatus;
  } else if (hasObservations) {
    element('status').textContent = complete.length
      ? `${complete.length.toLocaleString()} cells with ${ndviOnly ? 'NDVI' : 'both measurements'}.`
      : ndviOnly ? 'No NDVI observations in this view. Gray cells indicate missing data.'
        : 'No paired observations in this view. Gray cells indicate missing temperature or vegetation data.';
  }
}

function renderFireLayer() {
  const checkbox = element('fire-toggle');
  const message = element('fire-count');
  if (!checkbox.checked || !blockSource || !archive) {
    view.renderFires([]);
    if (archive) message.textContent = '';
    return;
  }
  const bounds = view.getBounds();
  const events = palette === FIRE_TIMELINE
    ? archive.events.slice(0, countThrough(archive.events, player.minute)) : archive.events;
  const visible = events.filter(point => point.latitude >= bounds.south && point.latitude <= bounds.north
    && point.longitude >= bounds.west && point.longitude <= bounds.east);
  view.renderFires(visible);
  const text = palette === FIRE_TIMELINE
    ? `${visible.length} MODIS hotspots through this time` : `${visible.length} MODIS hotspots · Jul 11–26, 2024`;
  if (message.textContent !== text) message.textContent = text;
}

function syncTimeline() {
  const isTimeline = palette === FIRE_TIMELINE;
  element('timeline-controls').hidden = !isTimeline;
  player.setAvailable(isTimeline && !!archive && !!blockSource);
  element('timeline-caption').textContent = blockSource
    ? 'NDVI stays fixed for July 11–26, 2024. Dots accumulate at their recorded UTC times.'
    : 'Load the bundled data to play the July fire timeline.';
}

function loadingIndicator(loading, ready = false) {
  document.body.classList.toggle('map-updating', loading);
  element('map-update-state').textContent = loading ? 'Updating map…' : ready ? 'Map updated' : '';
}

function installDataset(next) {
  activeResolution = coarsestResolution(next.inputs);
  h3Resolution = next.cells ? next.h3Resolution : preferredH3Resolution(activeResolution, h3);
  aggregates = next.cells
    ? new Map(next.cells.map(cell => [cell.id, cell]))
    : aggregateSamples(next.samples, h3Resolution, studyBounds, h3);
  breaks = datasetBreaks(aggregates.values());
  hasObservations = (next.cells ?? next.samples).length > 0;
  loadError = null;
  updateDatasetLabels(next);
  view.updateLimits(activeResolution, true);
  render();
}

function updateDatasetLabels(next) {
  element('window').textContent = next.periodLabel || 'Observation dates unavailable';
  sourceDescription = next.description || 'Prepared map dataset';
  renderProvenance();
  element('data-state').textContent = hasObservations ? 'Observed data' : 'Data unavailable';
  element('zoom-policy').textContent = `Closest view: at least ${ZOOM_POLICY.minimumPixelsAcross} pixels across at the coarser input resolution (${activeResolution.toLocaleString()} m).`;
  element('status').textContent = hasObservations ? 'Preparing paired cells…'
    : 'This dataset contains no observations.';
}

async function loadLocal(file) {
  const version = ++requestVersion;
  if (manifestGate) {
    manifestGate.cancel();
    manifestGate = null;
    showDownloadPrompt(null);
  }
  try {
    const next = await loadDatasetFile(file);
    if (version !== requestVersion) return;
    clearBlockSource();
    installDataset(next);
  } catch (error) {
    if (version === requestVersion) {
      loadError = error.message;
      element('status').textContent = loadError;
    }
  }
}

function setRoaming(enabled) {
  roaming = enabled;
  element('roam').checked = enabled;
  element('region-name').textContent = enabled ? 'Iowa and surrounding areas' : STUDY_AREA.name;
  view.setPanBounds(enabled ? blockSource.manifest.coverage : studyBounds, enabled);
  element('zoom-out-label').textContent = enabled ? '60-mile roaming view' : 'Full study area';
  element('map-navigation').textContent = PAN_HINT;
  scheduleRender();
  if (!enabled) view.reset();
}

function clearBlockSource() {
  blockSource?.stop();
  blockSource = null;
  blockStatus = '';
  element('roam').disabled = true;
  element('fire-toggle').disabled = true;
  syncTimeline();
  loadingIndicator(false);
  element('block-retry').hidden = true;
  setRoaming(false);
}

function moveWithArrows(event) {
  if (!roaming || event.target !== element('map') || event.altKey || event.ctrlKey
    || event.metaKey || event.shiftKey) return;
  const direction = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  }[event.key];
  if (!direction) return;
  event.preventDefault();
  if (!view.moveByView(...direction)) {
    element('map-navigation').textContent = 'Edge of the prepared data. Try another direction or zoom in.';
  }
}

function showDownloadPrompt(details) {
  element('download-prompt').hidden = !details;
  if (!details) return;
  const size = bytes => bytes >= 1_000_000
    ? `${(bytes / 1_000_000).toFixed(1)} MB` : `${Math.ceil(bytes / 1000)} KB`;
  const progress = details.total
    ? `${size(details.completed)} of ${size(details.total)} received.`
    : 'Checking the map data catalog.';
  const state = details.ready ? 'Ready to load into the map.'
    : details.paused ? 'Paused at the preview limit.' : 'A small preview can download while you decide.';
  element('download-message').textContent = `${progress} ${state}`;
}

async function loadBundled() {
  const version = ++requestVersion;
  blockSource?.stop();
  manifestGate?.cancel();
  showDownloadPrompt(null);
  const gate = new DownloadGate(0, showDownloadPrompt);
  manifestGate = gate;
  try {
    const manifest = await loadManifest(gate.signal);
    await gate.beforeCommit();
    const source = new BlockSource(manifest, (status, canRetry, loading = false) => {
      if (blockSource !== source) return;
      loadingIndicator(loading, loadingBlocks && !loading && !status);
      loadingBlocks = loading;
      aggregates = source.cache.cells();
      blockStatus = status;
      hasObservations = aggregates.size > 0;
      element('block-retry').hidden = !canRetry;
      element('data-state').textContent = hasObservations ? 'Observed data' : 'Loading observations';
      scheduleRender();
    }, showDownloadPrompt);
    await source.restore();
    if (version !== requestVersion) return;
    manifestGate = null;
    showDownloadPrompt(null);
    blockSource?.stop();
    blockSource = source;
    activeResolution = coarsestResolution(manifest.inputs);
    h3Resolution = manifest.h3Resolution;
    breaks = manifest.colorBreaks;
    aggregates = source.cache.cells();
    hasObservations = aggregates.size > 0;
    loadError = null;
    blockStatus = '';
    element('block-retry').hidden = true;
    element('roam').disabled = false;
    element('fire-toggle').disabled = false;
    syncTimeline();
    updateDatasetLabels(manifest);
    const opening = firstBundledView;
    firstBundledView = false;
    setRoaming(opening || roaming);
    view.updateLimits(activeResolution, !roaming);
    if (opening) view.reset(FIRE_START);
    source.update(view.getBounds());
    scheduleRender();
  } catch (error) {
    if (version === requestVersion) {
      loadError = gate.signal.aborted ? 'Reload canceled.' : error.message;
      element('status').textContent = loadError;
    }
  } finally {
    gate.finish();
    if (manifestGate === gate) {
      manifestGate = null;
      showDownloadPrompt(null);
    }
  }
}

function bindControls() {
  element('palette').addEventListener('change', event => {
    palette = event.target.value;
    renderColorLegend();
    scheduleRender();
  });
  element('zoom').addEventListener('input', event => view.setZoomPercent(Number(event.target.value)));
  element('fit').addEventListener('click', () => view.reset(roaming ? FIRE_START : undefined));
  element('fire-toggle').addEventListener('change', event => {
    if (!event.target.checked) player.pause();
    renderFireLayer();
  });
  element('reload').addEventListener('click', loadBundled);
  element('roam').addEventListener('change', event => {
    setRoaming(event.target.checked);
    if (roaming) element('map').focus({ preventScroll: true });
  });
  element('map').addEventListener('keydown', moveWithArrows);
  element('download-allow').addEventListener('click', () => {
    (manifestGate ?? blockSource)?.allow();
    showDownloadPrompt(null);
  });
  element('download-cancel').addEventListener('click', () => {
    (manifestGate ?? blockSource)?.cancel();
  });
  element('block-retry').addEventListener('click', () => {
    loadError = null;
    blockSource?.update(view.getBounds(), true);
  });
  element('file').addEventListener('change', event => {
    const file = event.target.files[0];
    if (file) loadLocal(file);
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

function renderProvenance() {
  element('provenance').textContent = palette === FIRE_TIMELINE && sourceDescription
    ? 'Terra MODIS vegetation composite. Fire detections come from the NASA FIRMS archive.'
    : sourceDescription || 'Checking prepared observations…';
}

function renderColorLegend() {
  renderProvenance();
  const ndviOnly = palette === FIRE_TIMELINE;
  element('temperature-details').hidden = ndviOnly;
  element('bivariate-key').hidden = ndviOnly;
  element('ndvi-key').hidden = !ndviOnly;
  element('map').setAttribute('aria-label', ndviOnly
    ? 'MODIS vegetation and fire hotspot map' : 'MODIS temperature and vegetation map');
  syncTimeline();
  if (ndviOnly) {
    element('a2-encoding').textContent = `${INPUTS.A2.product} · NDVI`;
    const limits = [NDVI_RANGE.min, NDVI_RANGE.max];
    const samples = [limits[0], (limits[0] + limits[1]) / 2, limits[1]];
    element('ndvi-ramp').style.backgroundImage = `linear-gradient(to right, ${samples.map(value => ndviAppearance(value).color).join(', ')})`;
    element('ndvi-low').textContent = `≤ ${limits[0]}`;
    element('ndvi-high').textContent = `≥ ${limits[1]}`;
    return;
  }
  const swatches = [];
  for (const vegetation of [1, 0.5, 0]) {
    for (const temperature of [0, 0.5, 1]) {
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = colorFor(temperature, vegetation, palette).color;
      swatches.push(swatch);
    }
  }
  element('color-swatches').replaceChildren(...swatches);

  element('a1-encoding').textContent = palette === CLASSIFIED
    ? `${INPUTS.A1.product} · Temperature classes` : `${INPUTS.A1.product} · Hue`;
  element('a2-encoding').textContent = palette === CLASSIFIED
    ? `${INPUTS.A2.product} · NDVI classes` : `${INPUTS.A2.product} · Saturation and lightness`;
}

renderColorLegend();
element('region-name').textContent = STUDY_AREA.name;
for (const [key, input] of Object.entries(INPUTS)) {
  const id = key.toLowerCase();
  element(`${id}-name`).textContent = input.label;
  element(`${id}-key`).textContent = `${input.product} · ${input.label}`;
  element(`${id}-details`).textContent =
    `${input.units} · nominal ${input.resolutionMeters.toLocaleString()} m / ${input.compositeDays} days.`;
}
view.updateLimits(activeResolution, true);
bindControls();
loadBundled();

loadFireDetections().then(data => {
  archive = fireTimeline(data);
  player.install(archive);
  syncTimeline();
}).catch(() => {
  element('fire-count').textContent = 'MODIS hotspots unavailable.';
});

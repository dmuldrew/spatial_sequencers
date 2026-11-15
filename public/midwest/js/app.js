import { INPUTS, coarsestResolution } from './domain/inputs.js';
import { STUDY_AREA, areaBounds } from './domain/study-area.js';
import { DEFAULT_SELECTION, observationWindow, sameCenter } from './domain/map-selection.js';
import { appearanceFor, colorFor, datasetBreaks, observedRanges } from './domain/appearance.js';
import { preferredH3Resolution } from './domain/zoom-policy.js';
import { loadDatasetFile } from './infrastructure/data-source.js';
import { BlockSource, loadManifest } from './infrastructure/block-source.js';
import { countThrough, fireTimeline, timeAt } from './domain/fire-timeline.js';
import { TimelinePlayer } from './infrastructure/timeline-player.js';
import { loadContext, loadFireDetections } from './infrastructure/fire-source.js';
import { contextBounds, FireContext } from './infrastructure/fire-context.js';
import { regionalManifest } from './infrastructure/dynamic-blocks.js';
import { DownloadGate } from './infrastructure/download-gate.js';
import { aggregateSamples, visibleGrid } from './infrastructure/hex-grid.js';
import { MapView } from './infrastructure/map-view.js';
import { sonifyCell } from './domain/sonification.js';
import { MapAudio } from './infrastructure/map-audio.js';

const element = id => document.getElementById(id);
// Keep the map silent and its Sound control hidden until the instrument blend is distinguishable.
const MAP_AUDIO_ENABLED = false;
const mapAudio = MAP_AUDIO_ENABLED ? new MapAudio() : null;
let mapPointer = null;
let studyBounds = areaBounds();
let selection = DEFAULT_SELECTION;
let fireKey = '';
let fireController = null;
let fireStatus = '';
let contextTimer = null;
let firstBundledView = true;
let loadingBlocks = false;
const PAN_HINT = element('map-navigation').textContent;
let loadError = null;
let aggregates = new Map();
let ranges = observedRanges(aggregates.values());
let breaks = null;
let palette = element('palette').value;
let activeResolution = coarsestResolution();
let h3Resolution = preferredH3Resolution(activeResolution, h3);
let requestVersion = 0;
let renderFrame = null;
let blockSource = null;
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
  resetPanHint();
  scheduleRender();
  if (!manifestGate && blockSource) {
    blockSource.update(view.getBounds());
    scheduleContext();
  }
});

const player = new TimelinePlayer({
  slider: element('fire-progress'),
  replay: element('fire-replay'),
  clock: element('fire-clock'),
  onSeek: renderFireLayer,
  onPlay: () => { element('fire-toggle').checked = true; },
});

const fireContext = new FireContext({
  view,
  layers: {
    wind: element('wind-layer'),
    perimeters: element('perimeter-layer'),
    terrain: element('terrain-layer'),
  },
  weatherOutput: element('weather-state'),
  perimeterOutput: element('perimeter-state'),
  loadNearby: (bounds, date) => loadContext('nearby', bounds, date, AbortSignal.timeout(9000)),
});

function scheduleContext() {
  clearTimeout(contextTimer);
  contextTimer = setTimeout(refreshContext, 300);
}

function refreshContext() {
  clearTimeout(contextTimer);
  const bounds = view.getBounds();
  const center = view.map.getCenter();
  fireContext.update(bounds, selection.date);
  const bundled = selection.date === DEFAULT_SELECTION.date && center.lng >= -124.8
    && center.lng <= -66.9 && center.lat >= 24.5 && center.lat <= 49.3;
  const area = contextBounds(bounds, 0.25);
  const key = bundled ? 'bundled' : JSON.stringify([selection.date, area]);
  if (fireKey === key) return;
  fireKey = key;
  fireController?.abort();
  const controller = new AbortController();
  fireController = controller;
  const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(9000)]);
  const range = observationWindow(selection.date);
  fireStatus = 'Loading MODIS hotspots…';
  player.install(fireTimeline({ ...range, points: [] }));
  loadFireDetections(bundled ? null : area, selection.date, signal).then(data => {
    if (controller.signal.aborted) return;
    const archive = fireTimeline(data);
    fireStatus = '';
    player.install(archive);
  }).catch(error => {
    if (controller.signal.aborted) return;
    fireStatus = signal.aborted ? 'MODIS hotspots unavailable.' : error.message;
    renderFireLayer();
  });
}

function formatValue(value, units = '') {
  return Number.isFinite(value) ? `${value.toFixed(2)} ${units}`.trim() : 'No data';
}

function formatRange(range, units) {
  return range ? `${formatValue(range.min)} – ${formatValue(range.max, units)}` : 'No observations';
}

function cellPopup(cell) {
  const container = document.createElement('div');
  for (const [key, input] of Object.entries(INPUTS)) {
    const line = document.createElement('div');
    line.textContent = `${input.label}: ${formatValue(cell[key], input.units)}`;
    container.append(line);
  }
  return container;
}

function render() {
  const mapBounds = blockSource?.manifest.coverage ?? studyBounds;
  const cells = visibleGrid(view.getBounds(), mapBounds, h3Resolution, aggregates, h3);
  renderFireLayer();
  updateHoverMusic();
  view.render(cells, cell => appearanceFor(cell, ranges, palette, breaks), cellPopup);
  for (const [key, input] of Object.entries(INPUTS)) {
    const cutoffs = breaks?.[key];
    element(`${key.toLowerCase()}-range`).textContent = palette === 'blue-orange'
      ? cutoffs ? `classes split at ${cutoffs.map(value => formatValue(value, input.units)).join(' and ')}`
        : 'No paired observations'
      : formatRange(ranges[key], input.units);
  }
  element('zoom').value = view.getZoomPercent();
  element('zoomLabel').textContent = `${view.widthMiles().toFixed(1)} miles across`;
  const hasData = cells.some(cell => Number.isFinite(cell.A2));
  const status = loadError || blockStatus || (loadingBlocks ? 'Loading map data…'
    : hasData ? '' : 'No observations for this view.');
  if (element('status').textContent !== status) element('status').textContent = status;
}

function renderFireLayer({ playback = false, previousMinute = -1 } = {}) {
  const checkbox = element('fire-toggle');
  const message = element('fire-count');
  const archive = player.timeline;
  if (archive) {
    fireContext.showTime(timeAt(archive, player.minute).getTime());
  }
  if (!checkbox.checked || !archive) {
    view.renderFires([]);
    message.textContent = '';
    return;
  }
  const bounds = view.getBounds();
  const events = archive.events.slice(0, countThrough(archive.events, player.minute));
  const visible = events.filter(point => point.latitude >= bounds.south && point.latitude <= bounds.north
    && point.longitude >= bounds.west && point.longitude <= bounds.east);
  if (playback && mapAudio) {
    mapAudio.pop(visible.filter(point => point.minute > previousMinute).length);
  }
  view.renderFires(visible, player.minute, (container, point) =>
    fireContext.brief(container, point, timeAt(archive, point.minute).getTime()));
  const text = fireStatus || `${visible.length} ${visible.length === 1 ? 'hotspot' : 'hotspots'}`;
  if (message.textContent !== text) message.textContent = text;
}

function setAggregates(cells) {
  aggregates = cells;
  ranges = observedRanges(cells.values());
  const manifest = blockSource?.manifest;
  const preparedBreaks = manifest && !manifest.date ? manifest.colorBreaks : null;
  breaks = preparedBreaks ?? datasetBreaks(cells.values());
}

function installDataset(next) {
  activeResolution = coarsestResolution(next.inputs);
  h3Resolution = next.cells ? next.h3Resolution : preferredH3Resolution(activeResolution, h3);
  setAggregates(next.cells
    ? new Map(next.cells.map(cell => [cell.id, cell]))
    : aggregateSamples(next.samples, h3Resolution, studyBounds, h3));
  loadError = null;
  updateDatasetLabels(next);
  view.updateLimits(activeResolution, true);
  render();
}

function updateDatasetLabels(next) {
  element('window').textContent = next.periodLabel || 'Observation dates unavailable';
  element('provenance').textContent = next.description || 'Prepared map dataset';
}

async function loadLocal(file) {
  const version = ++requestVersion;
  if (manifestGate) {
    manifestGate.cancel();
    manifestGate = null;
    showDownloadPrompt(null);
    element('selection-state').textContent = '';
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

function updateMapBounds() {
  const defaultCenter = sameCenter(selection, DEFAULT_SELECTION);
  element('region-name').textContent = defaultCenter
    ? (blockSource ? 'Iowa and surrounding areas' : STUDY_AREA.name)
    : `${selection.latitude.toFixed(4)}°, ${selection.longitude.toFixed(4)}°`;
  view.setPanBounds(blockSource?.manifest.coverage ?? studyBounds, Boolean(blockSource));
  resetPanHint();
}

function clearBlockSource() {
  blockSource?.stop();
  blockSource = null;
  blockStatus = '';
  fireController?.abort();
  fireKey = '';
  clearTimeout(contextTimer);
  element('fire-toggle').disabled = true;
  player.clear();
  loadingBlocks = false;
  document.body.classList.remove('map-updating');
  element('block-retry').hidden = true;
  updateMapBounds();
}

function resetPanHint() {
  const hint = element('map-navigation');
  if (hint.textContent !== PAN_HINT) hint.textContent = PAN_HINT;
  hint.classList.add('visually-hidden');
}

function moveWithArrows(event) {
  if (!blockSource || event.target !== element('map') || event.altKey || event.ctrlKey
    || event.metaKey || event.shiftKey) return;
  const direction = {
    ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1],
  }[event.key];
  if (!direction) return;
  event.preventDefault();
  if (!view.moveByView(...direction)) {
    const hint = element('map-navigation');
    hint.textContent = 'Edge of the prepared data.';
    hint.classList.remove('visually-hidden');
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

async function loadSelection(next = selection, fromForm = false) {
  const version = ++requestVersion;
  const recenter = !sameCenter(next, selection) || (fromForm && next.date === selection.date);
  blockSource?.stop();
  manifestGate?.cancel();
  showDownloadPrompt(null);
  const gate = new DownloadGate(0, showDownloadPrompt);
  manifestGate = gate;
  element('selection-state').textContent = 'Checking map data…';
  try {
    let manifest = await loadManifest(gate.signal);
    const { compositeStart, compositeEnd } = observationWindow(next.date);
    const defaultCenter = sameCenter(next, DEFAULT_SELECTION);
    const bounds = defaultCenter ? areaBounds() : areaBounds({ ...STUDY_AREA, ...next });
    bounds.east = Math.min(180, bounds.east);
    bounds.west = Math.max(-180, bounds.west);
    if (!defaultCenter) {
      manifest = regionalManifest(manifest, bounds, compositeStart);
    } else if (compositeStart !== DEFAULT_SELECTION.date) {
      const blocks = Object.fromEntries(Object.entries(manifest.blocks).map(([id, block]) =>
        [id, { ...block, dynamic: true, bytes: 1_000_000 }]));
      manifest = { ...manifest, blocks, date: compositeStart,
        unavailable: !manifest.dynamic, cacheKey: `${manifest.cacheKey}:${compositeStart}` };
    }
    if (!defaultCenter || compositeStart !== DEFAULT_SELECTION.date) {
      manifest.periodLabel = `${compositeStart} to ${compositeEnd} (satellite composites)`;
      manifest.description = Object.values(INPUTS).map(input => `${input.product} ${input.label}`).join(' · ');
    }
    await gate.beforeCommit();
    const source = new BlockSource(manifest, (status, canRetry, loading = false) => {
      if (blockSource !== source) return;
      loadingBlocks = loading;
      document.body.classList.toggle('map-updating', loading);
      setAggregates(source.cache.cells());
      blockStatus = status;
      element('block-retry').hidden = !canRetry;
      scheduleRender();
    }, showDownloadPrompt);
    await source.restore(!fromForm);
    if (version !== requestVersion) return;
    showDownloadPrompt(null);
    blockSource?.stop();
    blockSource = source;
    selection = next;
    studyBounds = bounds;
    view.setStudyBounds(bounds);
    activeResolution = coarsestResolution(manifest.inputs);
    h3Resolution = manifest.h3Resolution;
    setAggregates(source.cache.cells());
    loadError = null;
    blockStatus = manifest.unavailable ? 'This region or composite needs the Docker map data service.' : '';
    element('block-retry').hidden = true;
    element('fire-toggle').disabled = false;
    updateDatasetLabels(manifest);
    const opening = firstBundledView;
    firstBundledView = false;
    updateMapBounds();
    view.updateLimits(activeResolution, false, !recenter && !opening);
    if (recenter || opening) view.reset([selection.latitude, selection.longitude]);
    manifestGate = null;
    element('selection-state').textContent = '';
    const focused = document.activeElement;
    if (fromForm && (focused === document.body || element('study-selection').contains(focused))) {
      element('map').focus({ preventScroll: true });
    }
    refreshContext();
    source.update(view.getBounds(), false, fromForm);
    scheduleRender();
  } catch (error) {
    if (version === requestVersion) {
      loadError = gate.signal.aborted ? 'Reload canceled.' : error.message;
      element('selection-state').textContent = '';
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

function updateHoverMusic() {
  if (!mapAudio) return;
  if (!mapPointer) {
    mapAudio.hover(null);
    return;
  }
  const { lat, lng } = view.map.mouseEventToLatLng(mapPointer);
  const id = h3.latLngToCell(lat, lng, h3Resolution);
  mapAudio.hover(sonifyCell(aggregates.get(id), ranges));
}

function bindAudioControls() {
  if (!mapAudio) return;
  const button = element('map-audio-toggle');
  button.hidden = false;
  element('map-audio-hint').hidden = false;
  const status = element('map-audio-status');
  const map = element('map');
  let muted = false;
  const enable = async () => {
    if (button.disabled || mapAudio.enabled) return;
    button.disabled = true;
    try {
      await mapAudio.setEnabled(true);
      button.setAttribute('aria-pressed', 'true');
      status.textContent = '';
      void mapAudio.loadMusic().catch(() => {
        if (mapAudio.enabled) status.textContent = 'Music samples unavailable. Hotspot pops are active.';
      });
    } catch {
      status.textContent = 'Sound unavailable. Try again.';
    } finally {
      button.disabled = false;
    }
  };
  const unlock = event => {
    if (event.isTrusted && !muted) void enable();
  };
  // Capture the gesture before Replay can schedule any detections.
  element('fire-replay').addEventListener('click', unlock, true);
  map.addEventListener('click', unlock);
  button.addEventListener('click', () => {
    muted = mapAudio.enabled;
    if (muted) {
      void mapAudio.setEnabled(false);
      button.setAttribute('aria-pressed', 'false');
      status.textContent = '';
    } else {
      void enable();
    }
  });
  const move = event => {
    if (event.pointerType !== 'mouse') return;
    mapPointer = event;
    updateHoverMusic();
  };
  const leave = () => {
    mapPointer = null;
    updateHoverMusic();
  };
  map.addEventListener('pointerenter', move);
  map.addEventListener('pointermove', move);
  map.addEventListener('pointerleave', leave);
  const silence = () => {
    leave();
    mapAudio.silence();
  };
  window.addEventListener('pagehide', silence);
  document.addEventListener('visibilitychange', () => { if (document.hidden) silence(); });
}

function bindControls() {
  bindAudioControls();
  element('palette').addEventListener('change', event => {
    palette = event.target.value;
    renderColorLegend();
    scheduleRender();
  });
  element('zoom').addEventListener('input', event => view.setZoomPercent(Number(event.target.value)));
  element('fire-toggle').addEventListener('change', event => {
    if (!event.target.checked) player.pause();
    renderFireLayer();
  });
  element('reload').addEventListener('click', () => {
    fireKey = '';
    void loadSelection();
  });
  const date = element('study-date');
  date.max = new Date().toISOString().slice(0, 10);
  element('study-selection').addEventListener('submit', event => {
    event.preventDefault();
    const next = {
      latitude: Number(element('study-latitude').value),
      longitude: Number(element('study-longitude').value),
      date: date.value,
    };
    void loadSelection(next, true);
  });
  for (const id of ['wind-layer', 'perimeter-layer', 'terrain-layer']) {
    element(id).addEventListener('change', () => fireContext.update(view.getBounds(), selection.date));
  }
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
  new ResizeObserver(() => {
    frame.style.height = `${Math.ceil(document.body.getBoundingClientRect().height)}px`;
  }).observe(document.body);
}

function renderColorLegend() {
  const swatches = [];
  for (const secondary of [1, 0.5, 0]) {
    for (const primary of [0, 0.5, 1]) {
      const swatch = document.createElement('span');
      swatch.style.backgroundColor = colorFor(primary, secondary, palette);
      swatches.push(swatch);
    }
  }
  element('color-swatches').replaceChildren(...swatches);
}

element('a1-label').textContent = INPUTS.A1.legendLabel;
element('a2-label').textContent = INPUTS.A2.legendLabel;
element('a1-axis').textContent = `${INPUTS.A1.legendLabel} →`;
element('a2-axis').textContent = `↑ ${INPUTS.A2.legendLabel}`;
renderColorLegend();
element('region-name').textContent = STUDY_AREA.name;
view.updateLimits(activeResolution, true);
bindControls();
void loadSelection();

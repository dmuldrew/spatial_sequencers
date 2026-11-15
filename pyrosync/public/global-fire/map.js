// Global fire history map: MapLibre GL + the committed PMTiles (H3 resolutions 0-4),
// streamed over HTTP byte-range requests. Basemap countries come from the vendored
// world-atlas file, so no third-party tile server is involved.
import * as maplibregl from '../vendor/maplibre/maplibre-gl.mjs';

const DATA_DIR = '../data/global-fire/';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August',
  'September', 'October', 'November', 'December'];
// Same low-to-high ramp as the flyby's Fire History carpet.
const DENSITY_STOPS = ['#4c0519', '#b91c1c', '#f97316', '#facc15', '#fef9c3'];
// Diverging: falling fire activity blue, rising red (trend_log2: -1 = halved, +1 = doubled).
const TREND_STOPS = [[-1.5, '#2166ac'], [-0.5, '#67a9cf'], [0, '#ece7df'], [0.5, '#ef8a62'], [1.5, '#b2182b']];
const monthColor = (m) => `hsl(${(m - 1) * 30}, 78%, 58%)`;
// Hexagons with few detections have noisy trends and seasons: fade them.
const CONFIDENCE_OPACITY = ['interpolate', ['linear'], ['log10', ['max', ['get', 'detections'], 1]], 0, 0.12, 2, 0.58];
const HEX_OPACITY = 0.55; // semi-transparent, so coastlines and land stay visible
const INITIAL_VIEW = { center: [20, 8], zoom: 2.2 };
// PMTiles zoom bands for resolutions 0-4 (raster_h3 zoom bands), for the status line.
const RES_FOR_ZOOM = [0, 0, 1, 1, 2, 3, 4, 4];
const EDGE_KM = [1107, 418, 158, 60, 23];

const el = (id) => document.getElementById(id);
let map = null;
let manifest = null;
let mode = 'density';

if (window.frameElement) document.body.classList.add('embedded');

function densityExpression(lo, hi) {
  const stops = DENSITY_STOPS.flatMap((color, i) => [lo + ((hi - lo) * i) / (DENSITY_STOPS.length - 1), color]);
  return ['interpolate', ['linear'], ['log10', ['max', ['get', 'density'], 1e-9]], ...stops];
}

function paintFor(selected) {
  const { min: lo, max: hi } = manifest.colorRange;
  if (selected === 'trend') {
    return {
      color: ['interpolate', ['linear'], ['coalesce', ['get', 'trend_log2'], 0], ...TREND_STOPS.flat()],
      opacity: CONFIDENCE_OPACITY
    };
  }
  if (selected === 'season') {
    const cases = MONTHS.flatMap((_, i) => [i + 1, monthColor(i + 1)]);
    return {
      color: ['match', ['coalesce', ['get', 'peak_month'], 0], ...cases, '#64748b'],
      opacity: CONFIDENCE_OPACITY
    };
  }
  return { color: densityExpression(lo, hi), opacity: HEX_OPACITY };
}

// world-atlas cuts shapes at the 180th meridian, so a line can step from +180 to -180
// longitude. That step has no length on the sphere, but MapLibre draws it as a line
// all the way round the globe (Fiji's coast became a ring at 17 degrees south).
// Split lines wherever consecutive points jump more than 180 degrees in longitude.
function splitAtAntimeridian(geometry) {
  const lines = geometry.type === 'LineString' ? [geometry.coordinates] : geometry.coordinates;
  const out = [];
  for (const line of lines) {
    let current = [line[0]];
    for (let i = 1; i < line.length; i += 1) {
      if (Math.abs(line[i][0] - line[i - 1][0]) > 180) {
        if (current.length > 1) out.push(current);
        current = [];
      }
      current.push(line[i]);
    }
    if (current.length > 1) out.push(current);
  }
  return { type: 'MultiLineString', coordinates: out };
}

// Polygon rings with the same +180/-180 step would fill a sliver round the globe; shift
// their negative longitudes by 360 so each ring is continuous (MapLibre wraps them).
function unwrapAntimeridianRings(collection) {
  const fixRing = (ring) => {
    const jumps = ring.some((p, i) => i > 0 && Math.abs(p[0] - ring[i - 1][0]) > 180);
    return jumps ? ring.map(([lon, lat]) => [lon < 0 ? lon + 360 : lon, lat]) : ring;
  };
  for (const feature of collection.features) {
    const g = feature.geometry;
    if (g.type === 'Polygon') g.coordinates = g.coordinates.map(fixRing);
    else if (g.type === 'MultiPolygon') g.coordinates = g.coordinates.map((poly) => poly.map(fixRing));
  }
  return collection;
}

const per1000 = (density) => (density * 1000).toPrecision(2);
const trendPercent = (t) => Math.round((Math.pow(2, t) - 1) * 100);

function renderLegend() {
  const legend = el('gf-legend');
  const note = el('gf-legend-note');
  const { min: lo, max: hi } = manifest.colorRange;
  const win = manifest.trend;
  if (mode === 'density') {
    legend.innerHTML = `
      <div class="gf-ramp" style="background:linear-gradient(90deg,${DENSITY_STOPS.join(',')})"></div>
      <div class="gf-ramp-labels"><span>≤ ${per1000(10 ** lo)}</span><span>${per1000(10 ** ((lo + hi) / 2))}</span><span>≥ ${per1000(10 ** hi)}</span></div>`;
    note.textContent = 'Fire detections per 1,000 km² per year (log scale, shared with the flyby).';
  } else if (mode === 'trend') {
    const colors = TREND_STOPS.map(([, c]) => c).join(',');
    legend.innerHTML = `
      <div class="gf-ramp" style="background:linear-gradient(90deg,${colors})"></div>
      <div class="gf-ramp-labels"><span>${trendPercent(-1.5)}%</span><span>no change</span><span>+${trendPercent(1.5)}%</span></div>`;
    note.textContent = win
      ? `Mean yearly detections, ${win.late[0]}–${win.late[1]} vs ${win.early[0]}–${win.early[1]}. Faint hexagons have few detections, so their trend is uncertain.`
      : 'Trend not available in this dataset.';
  } else {
    legend.innerHTML = `<div class="gf-months">${MONTHS.map((m, i) => `<span style="background:${monthColor(i + 1)}">${m.slice(0, 3)}</span>`).join('')}</div>`;
    note.textContent = 'Calendar month with the most detections. Faint hexagons have few detections.';
  }
}

function setMode(next) {
  mode = next;
  const paint = paintFor(mode);
  map.setPaintProperty('fire-fill', 'fill-color', paint.color);
  map.setPaintProperty('fire-fill', 'fill-opacity', paint.opacity);
  renderLegend();
}

function updateStatus() {
  const z = Math.min(RES_FOR_ZOOM.length - 1, Math.max(0, Math.floor(map.getZoom())));
  const res = RES_FOR_ZOOM[z];
  el('gf-status').textContent = `Zoom ${map.getZoom().toFixed(1)} · H3 resolution ${res} (edges ≈ ${EDGE_KM[res]} km)` +
    (map.getZoom() > 8 ? ' · finest data is resolution 4' : '');
}

function showDetails(props) {
  const lines = [
    ['Hexagon', `${props.h3_hex} (r${props.resolution})`],
    ['Fires', `${Number(props.detections).toLocaleString()} (${manifest.periodLabel.replace(' – ', ' to ')})`],
    ['Density', `${per1000(props.density)} per 1,000 km² per year`]
  ];
  if (props.trend_log2 !== undefined && manifest.trend) {
    const pct = trendPercent(Number(props.trend_log2));
    const w = manifest.trend;
    lines.push(['Trend', `${pct >= 0 ? '+' : ''}${pct}% (${w.late[0]}–${w.late[1]} vs ${w.early[0]}–${w.early[1]})`]);
  }
  if (props.peak_month >= 1) lines.push(['Peak month', MONTHS[props.peak_month - 1]]);
  el('gf-details').innerHTML = `<dl>${lines.map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('')}</dl>`;
}

async function main() {
  manifest = await fetch(`${DATA_DIR}manifest.json`).then((r) => {
    if (!r.ok) throw new Error(`manifest.json: HTTP ${r.status}`);
    return r.json();
  });
  const pmtilesFile = manifest.pmtiles?.file || manifest.pmtiles || 'global_fire.pmtiles';
  const pmtilesUrl = new URL(`${DATA_DIR}${pmtilesFile}`, window.location.href).href;
  el('gf-period').textContent = `${Math.round(manifest.years)} years of NASA FIRMS MODIS vegetation-fire detections (${manifest.periodLabel}) on a hexagonal H3 grid. Hexagons get finer as you zoom.`;

  const protocol = new window.pmtiles.Protocol();
  maplibregl.addProtocol('pmtiles', protocol.tile);

  const world = await fetch('../vendor/countries-110m.json').then((r) => r.json());
  const countries = world.objects.countries;
  const land = unwrapAntimeridianRings(window.topojson.feature(world, countries));
  const borders = splitAtAntimeridian(window.topojson.mesh(world, countries, (a, b) => a !== b));
  const coast = splitAtAntimeridian(window.topojson.mesh(world, countries, (a, b) => a === b));
  const paint = paintFor(mode);

  map = new maplibregl.Map({
    container: 'gf-map',
    ...INITIAL_VIEW,
    maxZoom: 10,
    attributionControl: { compact: true, customAttribution: 'Fire data: NASA FIRMS MODIS C6.1 · Countries: Natural Earth via world-atlas' },
    style: {
      version: 8,
      projection: { type: 'globe' },
      sources: {
        land: { type: 'geojson', data: land },
        borders: { type: 'geojson', data: borders },
        coast: { type: 'geojson', data: coast },
        fire: { type: 'vector', url: `pmtiles://${pmtilesUrl}` }
      },
      layers: [
        { id: 'ocean', type: 'background', paint: { 'background-color': '#0b1a2e' } },
        { id: 'land', type: 'fill', source: 'land', paint: { 'fill-color': '#2f435a' } },
        {
          id: 'fire-fill',
          type: 'fill',
          source: 'fire',
          'source-layer': 'h3_hexagons',
          paint: { 'fill-color': paint.color, 'fill-opacity': paint.opacity }
        },
        {
          id: 'fire-outline',
          type: 'line',
          source: 'fire',
          'source-layer': 'h3_hexagons',
          minzoom: 5,
          paint: { 'line-color': '#0b1120', 'line-width': 0.4, 'line-opacity': 0.5 }
        },
        // Drawn above the hexagons so continents stay readable at every zoom.
        { id: 'borders', type: 'line', source: 'borders', paint: { 'line-color': '#cbd5e1', 'line-width': 0.7, 'line-opacity': 0.55 } },
        { id: 'coast-glow', type: 'line', source: 'coast', paint: { 'line-color': '#7dd3fc', 'line-width': 4, 'line-opacity': 0.25, 'line-blur': 2 } },
        { id: 'coast', type: 'line', source: 'coast', paint: { 'line-color': '#e0f2fe', 'line-width': 1.3, 'line-opacity': 0.95 } }
      ]
    }
  });
  map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), 'top-right');
  map.addControl(new maplibregl.ScaleControl(), 'bottom-left');

  map.on('click', 'fire-fill', (e) => {
    const f = e.features?.[0];
    if (f) showDetails(f.properties);
  });
  map.on('mouseenter', 'fire-fill', () => { map.getCanvas().style.cursor = 'pointer'; });
  map.on('mouseleave', 'fire-fill', () => { map.getCanvas().style.cursor = ''; });
  map.on('zoomend', updateStatus);
  map.on('load', () => {
    updateStatus();
    renderLegend();
  });
  map.on('error', (e) => console.warn('Map error:', e.error?.message || e));

  document.querySelectorAll('input[name="gf-mode"]').forEach((input) => {
    input.addEventListener('change', () => input.checked && setMode(input.value));
  });
  el('gf-projection').addEventListener('click', (e) => {
    const globe = e.currentTarget.getAttribute('aria-pressed') !== 'true';
    e.currentTarget.setAttribute('aria-pressed', String(globe));
    e.currentTarget.textContent = globe ? '🌐 Globe view' : '🗺️ Flat view';
    map.setProjection({ type: globe ? 'globe' : 'mercator' });
  });
  el('gf-reset').addEventListener('click', () => map.flyTo({ ...INITIAL_VIEW, bearing: 0, pitch: 0 }));
  window.gfMap = map; // for debugging and automated checks
}

main().catch((err) => {
  console.error(err);
  el('gf-status').textContent = `The map could not load: ${err.message}`;
});

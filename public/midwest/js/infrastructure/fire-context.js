import { loadContext } from './fire-source.js';

const HILLSHADE = 'https://server.arcgisonline.com/arcgis/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}';
const timestamp = properties => Number(properties.poly_PolygonDateTime);
const utc = value => new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

export function contextBounds(bounds, spacing = 0.05) {
  const roundup = value => Number((Math.ceil(value / spacing) * spacing).toFixed(5));
  const rounddown = value => Number((Math.floor(value / spacing) * spacing).toFixed(5));
  return {
    west: Math.max(-180, rounddown(bounds.west)),
    south: Math.max(-85, rounddown(bounds.south)),
    east: Math.min(180, roundup(bounds.east)),
    north: Math.min(85, roundup(bounds.north)),
  };
}

function intersectsConus({ west, south, east, north }) {
  return west < -66.9 && east > -124.8 && south < 49.4 && north > 24.4;
}

function insideRing(x, y, ring) {
  let inside = false;
  let previous = ring.at(-1);
  for (const current of ring) {
    const [x1, y1] = previous;
    const [x2, y2] = current;
    if ((y1 > y) !== (y2 > y) && x < (x2 - x1) * (y - y1) / (y2 - y1) + x1) inside = !inside;
    previous = current;
  }
  return inside;
}

function insidePerimeter(point, geometry) {
  const polygons = geometry.type === 'MultiPolygon' ? geometry.coordinates : [geometry.coordinates];
  const [x, y] = [point.longitude, point.latitude];
  return polygons.some(([outer, ...holes]) =>
    insideRing(x, y, outer) && !holes.some(ring => insideRing(x, y, ring)));
}

function describeWind(hour) {
  const [, speed, from, gust, humidity] = hour;
  if (!Number.isFinite(speed) || !Number.isFinite(from)) return 'Wind unavailable for this hour.';
  return [
    `${speed} mph from ${from}°`,
    Number.isFinite(gust) && `gusts ${gust} mph`,
    Number.isFinite(humidity) && `${humidity}% RH`,
  ].filter(Boolean).join(' · ');
}

export class FireContext {
  constructor({ view, layers, weatherOutput, perimeterOutput, loadNearby }) {
    this.map = view.map;
    this.layers = layers;
    this.weatherOutput = weatherOutput;
    this.perimeterOutput = perimeterOutput;
    this.loadNearby = loadNearby;
    this.hillshade = L.tileLayer(HILLSHADE, {
      opacity: 0.34, maxNativeZoom: 16, maxZoom: 22,
      attribution: 'Hillshade © Esri and elevation data contributors',
    });
    this.map.createPane('incident-context').style.zIndex = '415';
    this.perimeters = L.geoJSON(null, {
      pane: 'incident-context',
      style: { color: '#652e9b', opacity: 0.95, weight: 2, dashArray: '6 4', fillOpacity: 0.08 },
      onEachFeature: (feature, layer) => {
        const label = document.createElement('span');
        label.textContent = `${feature.properties.poly_IncidentName || 'Mapped fire'} · ${utc(timestamp(feature.properties))}`;
        layer.bindTooltip(label);
      },
    }).addTo(this.map);
    this.wind = L.marker(this.map.getCenter(), { interactive: false, keyboard: false, opacity: 0 })
      .addTo(this.map);
  }

  update(bounds, date) {
    this.date = date;
    const rounded = contextBounds(bounds);
    const key = JSON.stringify([rounded, date, this.layers.wind.checked, this.layers.perimeters.checked]);
    this.toggleHillshade();
    if (this.key === key) return;
    this.key = key;
    this.weather = null;
    this.perimeters.clearLayers();
    this.features = [];
    this.hour = null;
    this.visiblePerimeters = null;
    this.wind.setOpacity(0);
    this.controller?.abort();
    this.controller = new AbortController();
    const signal = AbortSignal.any([this.controller.signal, AbortSignal.timeout(9_000)]);
    const update = (kind, output, install) => {
      output.textContent = `Loading ${kind}…`;
      return loadContext(kind, rounded, date, signal).then(data => {
        if (this.key !== key) return;
        install(data);
        this.showTime(this.time);
      }).catch(() => {
        if (this.key === key) output.textContent = `${kind[0].toUpperCase() + kind.slice(1)} unavailable.`;
      });
    };
    this.weatherOutput.textContent = '';
    this.perimeterOutput.textContent = '';
    if (this.layers.wind.checked) {
      void update('weather', this.weatherOutput, data => { this.weather = data; });
    }
    if (this.layers.perimeters.checked && intersectsConus(rounded)) {
      void update('perimeters', this.perimeterOutput, data => {
        this.features = data.features.filter(feature => feature.geometry && timestamp(feature.properties) > 0);
        this.perimeterOutput.textContent = this.features.length ? 'NIFC mapped perimeters (purple)' : 'No NIFC perimeters in this period and area.';
      });
    } else if (this.layers.perimeters.checked) {
      this.perimeterOutput.textContent = 'NIFC perimeters are unavailable outside the covered U.S. region.';
    }
  }

  toggleHillshade() {
    if (this.layers.terrain.checked && !this.map.hasLayer(this.hillshade)) {
      this.hillshade.addTo(this.map);
    } else if (!this.layers.terrain.checked) {
      this.hillshade.remove();
    }
  }

  showTime(time) {
    this.time = time;
    const hour = this.weather?.hours.findLast(row => row[0] * 1000 <= time);
    if (hour && this.hour !== hour) {
      this.hour = hour;
      this.weatherOutput.textContent = `${describeWind(hour)} · ${this.weather.source} at map center`;
      const from = hour[2];
      if (Number.isFinite(from) && Number.isFinite(hour[1])) {
        this.wind.setLatLng([this.weather.latitude, this.weather.longitude])
          .setIcon(L.divIcon({
            className: 'wind-arrow',
            html: `<span style="transform:rotate(${from + 180}deg)">↑</span>`,
            iconSize: [32, 32], iconAnchor: [16, 16],
          })).setOpacity(1);
      } else {
        this.wind.setOpacity(0);
      }
    }
    const visible = this.features?.filter(feature => timestamp(feature.properties) <= time) ?? [];
    const latest = new Map();
    for (const feature of visible) {
      const id = feature.properties.poly_IRWINID || feature.id || feature;
      if (!latest.has(id) || timestamp(latest.get(id).properties) < timestamp(feature.properties)) {
        latest.set(id, feature);
      }
    }
    const next = [...latest.values()];
    if (this.visiblePerimeters?.length === next.length
      && next.every((feature, index) => feature === this.visiblePerimeters[index])) return;
    this.visiblePerimeters = next;
    this.perimeters.clearLayers().addData(next);
  }

  brief(container, point, time) {
    const hour = this.weather?.hours.findLast(row => row[0] * 1000 <= time);
    const perimeter = this.features?.find(feature => timestamp(feature.properties) <= time
      && insidePerimeter(point, feature.geometry));
    const line = value => {
      const row = document.createElement('div');
      row.textContent = value;
      container.append(row);
      return row;
    };
    line(`${point.latitude.toFixed(3)}°, ${point.longitude.toFixed(3)}°`);
    line(hour ? `${describeWind(hour)} · ${this.weather.source} at map center`
      : 'Wind at detection time unavailable.');
    line(perimeter ? `Inside mapped perimeter: ${perimeter.properties.poly_IncidentName || 'Unnamed incident'} · ${utc(timestamp(perimeter.properties))}`
      : 'No matching perimeter in the loaded records.');
    const access = line('Loading nearby roads, buildings, and water…');
    const bounds = {
      west: Math.max(-180, point.longitude - 0.01), south: Math.max(-85, point.latitude - 0.01),
      east: Math.min(180, point.longitude + 0.01), north: Math.min(85, point.latitude + 0.01),
    };
    this.loadNearby(bounds, this.date).then(data => {
      const details = Object.entries(data.groups).filter(([, names]) => names.length)
        .map(([group, names]) => `${group}: ${names.join(', ')}`);
      access.textContent = details.length ? `${data.source} within ~2 km: ${details.join(' · ')}. Verify access and water availability locally.`
        : 'No named access or water features returned within ~2 km.';
    }).catch(() => {
      access.textContent = 'Nearby features unavailable. Roads and water are shown on the basemap.';
    });
  }
}

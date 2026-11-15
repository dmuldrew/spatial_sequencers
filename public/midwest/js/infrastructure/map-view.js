import { closestZoom } from '../domain/zoom-policy.js';

// At 60 miles across, multiple full-screen moves fit in the prepared coverage.
const ROAMING_ZOOM_OFFSET = Math.log2(3);

export class MapView {
  constructor(element, bounds, onViewChange) {
    this.bounds = L.latLngBounds(
      [bounds.south, bounds.west], [bounds.north, bounds.east],
    );
    this.map = L.map(element, {
      preferCanvas: true,
      dragging: false,
      scrollWheelZoom: false,
      zoomControl: false,
      doubleClickZoom: false,
      touchZoom: false,
      boxZoom: false,
      keyboard: false,
      zoomSnap: 0,
      zoomAnimation: false,
      maxBounds: this.bounds,
      maxBoundsViscosity: 1,
    }).setView(this.bounds.getCenter(), 8);
    this.setStudyBounds(bounds);

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19,
      maxZoom: 22,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.map.createPane('hexagons').style.zIndex = '410';
    this.map.createPane('hotspots').style.zIndex = '425';
    this.cells = L.layerGroup().addTo(this.map);
    this.fires = L.layerGroup().addTo(this.map);
    this.fireMarkers = new Map();
    this.map.on('moveend', onViewChange);
  }

  setStudyBounds(bounds) {
    this.bounds = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
    // Match the projected study box without adding margins at minimum zoom.
    this.projectedSize = L.bounds(
      this.map.project(this.bounds.getSouthWest(), 0),
      this.map.project(this.bounds.getNorthEast(), 0),
    ).getSize();
    this.map.getContainer().style.aspectRatio = this.projectedSize.x / this.projectedSize.y;
  }

  setPanBounds(bounds, roaming) {
    const changed = this.roaming !== roaming;
    this.roaming = roaming;
    const limit = L.latLngBounds([bounds.south, bounds.west], [bounds.north, bounds.east]);
    this.map.setMaxBounds(limit);
    if (changed) this.updateLimits(this.resolutionMeters, false, true);
  }

  moveByView(x, y) {
    const size = this.map.getSize();
    const center = this.map.project(this.map.getCenter());
    const next = center.add([x * size.x, y * size.y]);
    this.map.setView(this.map.unproject(next), this.map.getZoom(), { animate: false });
    return center.distanceTo(this.map.project(this.map.getCenter())) >= 1;
  }

  updateLimits(resolutionMeters, reset = false, preserveScale = false) {
    this.resolutionMeters = resolutionMeters;
    const position = this.getZoomPercent();
    const previousZoom = this.map.getZoom();
    this.map.invalidateSize({ pan: false });
    const size = this.map.getSize();
    // Compute directly in scale space. Leaflet's getBoundsZoom clamps to the
    // previous limits, which can trap the zoom range after a resize.
    const fitScale = Math.max(size.x / this.projectedSize.x, size.y / this.projectedSize.y);
    this.minimumZoom = Math.log2(fitScale) + (this.roaming ? ROAMING_ZOOM_OFFSET : 0);
    this.maximumZoom = Math.max(this.minimumZoom, Math.min(22, closestZoom(
      this.bounds.getNorth(), size.x, resolutionMeters,
    )));
    this.map.setMinZoom(this.minimumZoom);
    this.map.setMaxZoom(this.maximumZoom);
    if (reset) this.reset();
    else if (preserveScale) this.map.setZoom(previousZoom, { animate: false });
    else this.setZoomPercent(position);
  }

  reset(center = this.bounds.getCenter()) {
    this.map.setView(center, this.minimumZoom, { animate: false });
  }

  setZoomPercent(percent) {
    const zoom = this.minimumZoom + (this.maximumZoom - this.minimumZoom) * percent / 100;
    this.map.setZoom(zoom, { animate: false });
    this.map.panInsideBounds(this.map.options.maxBounds, { animate: false });
  }

  getZoomPercent() {
    const span = this.maximumZoom - this.minimumZoom;
    if (!span) return 0;
    return Math.max(0, Math.min(100, 100 * (this.map.getZoom() - this.minimumZoom) / span));
  }

  getBounds() {
    const bounds = this.map.getBounds();
    return {
      south: bounds.getSouth(), north: bounds.getNorth(),
      west: bounds.getWest(), east: bounds.getEast(),
    };
  }

  widthMiles() {
    const bounds = this.getBounds();
    const latitude = (bounds.south + bounds.north) / 2;
    return this.map.distance([latitude, bounds.west], [latitude, bounds.east]) / 1609.344;
  }

  renderFires(points, minute = null, briefing) {
    const next = new Set(points);
    for (const [point, { marker }] of this.fireMarkers) {
      if (!next.has(point)) {
        this.fires.removeLayer(marker);
        this.fireMarkers.delete(point);
      }
    }
    for (const point of points) {
      const age = minute === null ? 0 : minute - point.minute;
      const opacity = age < 360 ? 1 : age < 1440 ? 0.72 : 0.48;
      const existing = this.fireMarkers.get(point);
      if (existing) {
        if (existing.opacity !== opacity) {
          existing.marker.setStyle({ fillOpacity: opacity, opacity });
          existing.opacity = opacity;
        }
        continue;
      }
      const marker = L.circleMarker([point.latitude, point.longitude], {
        pane: 'hotspots',
        radius: 5,
        color: '#ffffff',
        weight: 2,
        fillColor: '#e00023',
        fillOpacity: opacity,
        opacity,
      }).bindPopup(() => {
        const description = document.createElement('div');
        description.className = 'hotspot-brief';
        const header = document.createElement('strong');
        const time = `${point.time.slice(0, 2)}:${point.time.slice(2)} UTC`;
        header.textContent = `MODIS ${point.satellite} · ${point.date} ${time} · ${point.power} MW · confidence ${point.confidence}%`;
        description.append(header);
        briefing?.(description, point);
        return description;
      }, { autoPan: false, maxWidth: 360 }).addTo(this.fires);
      this.fireMarkers.set(point, { marker, opacity });
    }
  }

  render(cells, styleFor, popupFor) {
    this.cells.clearLayers();
    for (const cell of cells) {
      const appearance = styleFor(cell);
      L.polygon(cell.geometry, {
        pane: 'hexagons',
        color: appearance.missing ? '#737e7c' : '#374737',
        weight: 0.4,
        fillColor: appearance.color,
        fillOpacity: appearance.missing ? 0.25 : 1,
      }).bindPopup(() => popupFor(cell), { autoPan: false }).addTo(this.cells);
    }
  }
}

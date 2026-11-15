import { closestZoom } from '../domain/zoom-policy.js';

export class MapView {
  constructor(element, bounds, onViewChange) {
    this.bounds = L.latLngBounds(
      [bounds.south, bounds.west], [bounds.north, bounds.east],
    );
    this.map = L.map(element, {
      preferCanvas: true,
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
    // Match the study box's projected aspect ratio to show the whole box
    // at minimum zoom without adding a margin beyond the study area.
    this.projectedSize = L.bounds(
      this.map.project(this.bounds.getSouthWest(), 0),
      this.map.project(this.bounds.getNorthEast(), 0),
    ).getSize();
    this.map.getContainer().parentElement.style.aspectRatio =
      this.projectedSize.x / this.projectedSize.y;

    L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxNativeZoom: 19,
      maxZoom: 22,
      attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
    }).addTo(this.map);
    this.cells = L.layerGroup().addTo(this.map);
    this.map.on('moveend', onViewChange);
  }

  updateLimits(resolutionMeters, reset = false) {
    const position = reset ? 0 : this.getZoomPercent();
    this.map.invalidateSize({ pan: false });
    const size = this.map.getSize();
    // Compute directly in scale space. Leaflet's getBoundsZoom clamps to the
    // previous limits, which can trap the zoom range after a resize.
    const fitScale = Math.max(size.x / this.projectedSize.x, size.y / this.projectedSize.y);
    this.minimumZoom = Math.log2(fitScale);
    this.maximumZoom = Math.max(this.minimumZoom, Math.min(22, closestZoom(
      this.bounds.getNorth(), size.x, resolutionMeters,
    )));
    this.map.setMinZoom(this.minimumZoom);
    this.map.setMaxZoom(this.maximumZoom);
    this.setZoomPercent(position);
  }

  reset() {
    this.map.setView(this.bounds.getCenter(), this.minimumZoom, { animate: false });
  }

  setZoomPercent(percent) {
    if (percent <= 0) {
      this.reset();
      return;
    }
    const zoom = this.minimumZoom + (this.maximumZoom - this.minimumZoom) * percent / 100;
    this.map.setZoom(zoom, { animate: false });
    this.map.panInsideBounds(this.bounds, { animate: false });
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

  render(cells, styleFor, popupFor) {
    this.cells.clearLayers();
    for (const cell of cells) {
      const appearance = styleFor(cell);
      L.polygon(cell.geometry, {
        color: appearance.missing ? '#737e7c' : '#374737',
        weight: 0.65,
        fillColor: appearance.color,
        fillOpacity: appearance.missing ? 0.25 : 1,
      }).bindPopup(() => popupFor(cell, appearance), { autoPan: false }).addTo(this.cells);
    }
  }
}

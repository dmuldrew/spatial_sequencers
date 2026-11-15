import assert from 'node:assert/strict';
import test from 'node:test';

import { MapView } from '../public/midwest/js/infrastructure/map-view.js';

for (const [width, height] of [[0, 600], [900, 0], [0, 0]]) {
  test(`dashboard tab preserves map zoom through a ${width} by ${height} hidden resize`, () => {
    const container = { clientWidth: 900, clientHeight: 600 };
    let zoom = 10;
    const map = {
      options: { maxBounds: {} },
      getContainer: () => container,
      getSize: () => ({ x: container.clientWidth, y: container.clientHeight }),
      getZoom: () => zoom,
      invalidateSize() {},
      setMinZoom(value) { zoom = Math.max(zoom, value); },
      setMaxZoom(value) { zoom = Math.min(zoom, value); },
      setZoom(value) { assert.ok(Number.isFinite(value)); zoom = value; },
      panInsideBounds() {},
    };
    const view = Object.assign(Object.create(MapView.prototype), {
      map,
      bounds: { getNorth: () => 43 },
      projectedSize: { x: 3, y: 2 },
      minimumZoom: 9,
      maximumZoom: 14,
      roaming: true,
    });
    view.updateLimits(1000);
    view.setZoomPercent(60);
    const selectedZoom = zoom;

    container.clientWidth = width;
    container.clientHeight = height;
    view.updateLimits(1000);
    assert.equal(zoom, selectedZoom);

    container.clientWidth = 900;
    container.clientHeight = 600;
    view.updateLimits(1000);
    assert.equal(zoom, selectedZoom);
    assert.ok(Math.abs(view.getZoomPercent() - 60) < 1e-9);
  });
}

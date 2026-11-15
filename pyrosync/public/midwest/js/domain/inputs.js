/** A1 supplies the horizontal color axis. A2 supplies the vertical axis and the single-input fallback. */
export const INPUTS = Object.freeze({
  A1: {
    label: 'Daytime surface temperature',
    legendLabel: 'Temperature',
    product: 'MOD11A2',
    band: 'LST_Day_1km',
    units: '°C',
    resolutionMeters: 1000,
    compositeDays: 8,
    validRange: [-73.15, 126.85],
  },
  A2: {
    label: 'Vegetation index (NDVI)',
    legendLabel: 'NDVI',
    product: 'MOD13Q1',
    band: '250m_16_days_NDVI',
    units: 'NDVI',
    resolutionMeters: 250,
    compositeDays: 16,
    validRange: [-0.2, 1],
  },
});

// Use a manifest with matching A1 and A2 metadata. The optional map worker
// serves the default MODIS products, so disable it for other prepared datasets.
export const DATASET_SOURCE = Object.freeze({
  manifest: new URL('../../data/manifest.json', import.meta.url),
  useModisWorker: true,
});

export function coarsestResolution(inputs = INPUTS) {
  return Math.max(...Object.values(inputs).map(input => input.resolutionMeters));
}

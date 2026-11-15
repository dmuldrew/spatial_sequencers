/** Scientific inputs: redefine these without changing the map or appearance rule. */
export const INPUTS = Object.freeze({
  A1: {
    label: 'Daytime surface temperature',
    product: 'MOD11A2',
    band: 'LST_Day_1km',
    units: '°C',
    resolutionMeters: 1000,
    compositeDays: 8,
    validRange: [-73.15, 126.85],
  },
  A2: {
    label: 'Vegetation index (NDVI)',
    product: 'MOD13Q1',
    band: '250m_16_days_NDVI',
    units: 'NDVI',
    resolutionMeters: 250,
    compositeDays: 16,
    validRange: [-0.2, 1],
  },
});

export function coarsestResolution(inputs = INPUTS) {
  return Math.max(...Object.values(inputs).map(input => input.resolutionMeters));
}

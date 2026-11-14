/** Geography is independent of input definitions and rendering infrastructure. */
export const STUDY_AREA = Object.freeze({
  name: 'Central Iowa · American Midwest',
  latitude: 42.0,
  longitude: -93.5,
  widthMiles: 180,
  heightMiles: 120,
});

export function areaBounds(area = STUDY_AREA) {
  const radians = area.latitude * Math.PI / 180;
  const metersPerLatitude = 111132.92 - 559.82 * Math.cos(2 * radians)
    + 1.175 * Math.cos(4 * radians);
  const metersPerLongitude = 111412.84 * Math.cos(radians)
    - 93.5 * Math.cos(3 * radians);
  const halfHeight = area.heightMiles * 1609.344 / metersPerLatitude / 2;
  const halfWidth = area.widthMiles * 1609.344 / metersPerLongitude / 2;
  return {
    south: area.latitude - halfHeight,
    north: area.latitude + halfHeight,
    west: area.longitude - halfWidth,
    east: area.longitude + halfWidth,
  };
}

export function contains(bounds, latitude, longitude) {
  return latitude >= bounds.south && latitude <= bounds.north
    && longitude >= bounds.west && longitude <= bounds.east;
}

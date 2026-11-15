/** Ground-scale policy: at closest zoom, show at least 12 source pixels across. */
export const ZOOM_POLICY = Object.freeze({ minimumPixelsAcross: 12 });

export function closestZoom(latitude, viewportWidth, resolutionMeters) {
  const groundWidth = ZOOM_POLICY.minimumPixelsAcross * resolutionMeters;
  const metersPerScreenPixel = groundWidth / viewportWidth;
  return Math.log2(156543.033928 * Math.cos(latitude * Math.PI / 180)
    / metersPerScreenPixel);
}

export function preferredH3Resolution(resolutionMeters, h3) {
  // Do not imply cells finer than the coarsest input's nominal pixel area.
  const sourceArea = resolutionMeters ** 2;
  let resolution = 0;
  for (let candidate = 0; candidate <= 10; candidate += 1) {
    if (h3.getHexagonAreaAvg(candidate, 'm2') < sourceArea) break;
    resolution = candidate;
  }
  return resolution;
}

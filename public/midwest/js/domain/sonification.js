import { normalize } from './appearance.js';

/** Continuous temperature blend, with an equal mix when temperature is missing. */
export function sonifyCell(cell, ranges) {
  const heat = normalize(cell?.A1, ranges?.A1) ?? 0.5;
  return { heat, guitar: Math.sqrt(1 - heat), trumpet: Math.sqrt(heat) };
}

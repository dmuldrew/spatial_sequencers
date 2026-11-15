import { normalize } from './appearance.js';

/** Temperature controls harmonic tension. Cells with no temperature stay quiet. */
export function sonifyCell(cell, ranges) {
  return normalize(cell?.A1, ranges?.A1);
}

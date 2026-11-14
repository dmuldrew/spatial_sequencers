import { contains } from '../domain/study-area.js';

export function clipPolygon(vertices, bounds) {
  let result = vertices;
  const edges = [
    [0, bounds.south, true], [0, bounds.north, false],
    [1, bounds.west, true], [1, bounds.east, false],
  ];
  for (const [axis, edge, greater] of edges) {
    const input = result;
    result = [];
    if (!input.length) break;
    for (let index = 0; index < input.length; index += 1) {
      const start = input[index];
      const end = input[(index + 1) % input.length];
      const startInside = greater ? start[axis] >= edge : start[axis] <= edge;
      const endInside = greater ? end[axis] >= edge : end[axis] <= edge;
      if (startInside) result.push(start);
      if (startInside !== endInside) {
        const fraction = (edge - start[axis]) / (end[axis] - start[axis]);
        result.push([
          start[0] + fraction * (end[0] - start[0]),
          start[1] + fraction * (end[1] - start[1]),
        ]);
      }
    }
  }
  return result;
}

export function aggregateSamples(samples, resolution, studyBounds, h3) {
  const sums = new Map();
  for (const sample of samples) {
    if (!contains(studyBounds, sample.latitude, sample.longitude)) continue;
    const id = h3.latLngToCell(sample.latitude, sample.longitude, resolution);
    if (!sums.has(id)) sums.set(id, { A1: 0, A2: 0, A1Weight: 0, A2Weight: 0 });
    const cell = sums.get(id);
    for (const key of ['A1', 'A2']) {
      if (!Number.isFinite(sample[key])) continue;
      const weight = sample[`${key}Weight`] ?? 1;
      cell[key] += sample[key] * weight;
      cell[`${key}Weight`] += weight;
    }
  }
  return new Map([...sums].map(([id, cell]) => [id, {
    id,
    A1: cell.A1Weight ? cell.A1 / cell.A1Weight : null,
    A2: cell.A2Weight ? cell.A2 / cell.A2Weight : null,
  }]));
}

export function visibleGrid(viewBounds, studyBounds, resolution, aggregates, h3) {
  const bounds = {
    south: Math.max(viewBounds.south, studyBounds.south),
    north: Math.min(viewBounds.north, studyBounds.north),
    west: Math.max(viewBounds.west, studyBounds.west),
    east: Math.min(viewBounds.east, studyBounds.east),
  };
  if (bounds.south >= bounds.north || bounds.west >= bounds.east) return [];
  const polygon = [
    [bounds.south, bounds.west], [bounds.south, bounds.east],
    [bounds.north, bounds.east], [bounds.north, bounds.west],
  ];
  const centers = h3.polygonToCells(polygon, resolution);
  // Include edge intersections even when a zoomed viewport contains no cell center.
  for (const point of polygon) centers.push(h3.latLngToCell(...point, resolution));
  const ids = new Set(centers.flatMap(id => h3.gridDisk(id, 1)));
  const cells = [];
  for (const id of ids) {
    const boundary = h3.cellToBoundary(id);
    if (clipPolygon(boundary, bounds).length < 3) continue;
    const geometry = clipPolygon(boundary, studyBounds);
    const data = aggregates.get(id) || { id, A1: null, A2: null };
    cells.push({ ...data, geometry });
  }
  return cells;
}

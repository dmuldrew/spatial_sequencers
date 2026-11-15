import { INPUTS } from '../domain/inputs.js';

function inputValues(record) {
  const result = {};
  for (const key of ['A1', 'A2']) {
    const value = record[key];
    const [minimum, maximum] = INPUTS[key].validRange;
    result[key] = Number.isFinite(value) && value >= minimum && value <= maximum ? value : null;
    const weight = record[`${key}Weight`];
    result[`${key}Weight`] = Number.isFinite(weight) && weight > 0 ? weight : 1;
  }
  return result;
}

export function validateDataset(data) {
  if (data?.schemaVersion !== 1 || !data.inputs
    || (!Array.isArray(data.cells) && !Array.isArray(data.samples))) {
    throw new Error('Expected a version 1 map dataset with H3 cells or geographic samples.');
  }
  for (const key of ['A1', 'A2']) {
    const input = data.inputs[key];
    if (!input || input.product !== INPUTS[key].product
      || input.band !== INPUTS[key].band || input.units !== INPUTS[key].units
      || !Number.isFinite(input.resolutionMeters) || input.resolutionMeters <= 0) {
      throw new Error(`${INPUTS[key].product}: dataset metadata does not match the configured product, band and units.`);
    }
  }
  if (Array.isArray(data.cells)) {
    if (!Number.isInteger(data.h3Resolution) || data.h3Resolution < 0 || data.h3Resolution > 10) {
      throw new Error('An H3 dataset must declare a grid resolution from 0 to 10.');
    }
    const ids = new Set();
    const cells = data.cells.map(cell => {
      if (typeof cell?.id !== 'string' || !h3.isValidCell(cell.id)
        || h3.getResolution(cell.id) !== data.h3Resolution || ids.has(cell.id)) {
        throw new Error('The dataset contains an invalid, duplicate, or mismatched H3 cell.');
      }
      ids.add(cell.id);
      return { id: cell.id, ...inputValues(cell) };
    });
    return { ...data, cells };
  }

  const samples = data.samples.map(sample => {
    if (!Number.isFinite(sample?.latitude) || Math.abs(sample.latitude) > 90
      || !Number.isFinite(sample.longitude) || Math.abs(sample.longitude) > 180) {
      throw new Error('A sample contains invalid coordinates.');
    }
    return { ...sample, ...inputValues(sample) };
  });
  return { ...data, samples };
}

export async function loadDatasetFile(file) {
  if (file.size > 50 * 1024 * 1024) throw new Error('Use a prepared JSON file smaller than 50 MB.');
  return validateDataset(JSON.parse(await file.text()));
}

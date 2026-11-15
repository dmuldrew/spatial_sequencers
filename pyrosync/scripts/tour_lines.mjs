// Prints tour narration data from public/js/tour-content.js as JSON, for
// build_tour_narration.py:
//   node scripts/tour_lines.mjs stops               -> [{ id, name, lat, lon }]
//   node scripts/tour_lines.mjs lines data.json     -> every line the tour can speak
// data.json: { "startYear": "2001", "stops": { "<stopId>": { detections, trend_log2, peak_month } } }
import { readFileSync } from 'node:fs';
import { TOUR_STOPS, allTourLines } from '../public/js/tour-content.js';

const [mode, dataPath] = process.argv.slice(2);
if (mode === 'stops') {
  console.log(JSON.stringify(TOUR_STOPS.map(({ id, name, lat, lon }) => ({ id, name, lat, lon }))));
} else if (mode === 'lines') {
  const data = dataPath ? JSON.parse(readFileSync(dataPath, 'utf8')) : {};
  console.log(JSON.stringify(allTourLines(data.stops || {}, data.startYear || '2001')));
} else {
  console.error('usage: node scripts/tour_lines.mjs stops | lines <data.json>');
  process.exit(2);
}

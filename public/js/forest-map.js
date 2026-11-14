const d3 = window.d3;
const aliases = {
  Turkey: 'Turkiye', Vietnam: 'Viet Nam', Brunei: 'Brunei Darussalam',
  Somalia: 'Somalia, Fed. Rep.', Macedonia: 'North Macedonia',
  "Côte d'Ivoire": "Cote d'Ivoire",
  'United States of America': 'United States', 'Russia': 'Russian Federation',
  'Dem. Rep. Congo': 'Congo, Dem. Rep.', Congo: 'Congo, Rep.',
  'Central African Rep.': 'Central African Republic', 'Dominican Rep.': 'Dominican Republic',
  'Eq. Guinea': 'Equatorial Guinea', 'S. Sudan': 'South Sudan',
  'South Korea': 'Korea, Rep.', 'North Korea': "Korea, Dem. People's Rep.",
  Iran: 'Iran, Islamic Rep.', Egypt: 'Egypt, Arab Rep.', Venezuela: 'Venezuela, RB',
  Syria: 'Syrian Arab Republic', Yemen: 'Yemen, Rep.', Laos: 'Lao PDR',
  Slovakia: 'Slovak Republic', 'Kyrgyzstan': 'Kyrgyz Republic',
  'Czechia': 'Czechia', 'eSwatini': 'Eswatini', 'Gambia': 'Gambia, The',
  'Bahamas': 'Bahamas, The', 'Solomon Is.': 'Solomon Islands',
  'Bosnia and Herz.': 'Bosnia and Herzegovina', 'W. Sahara': 'Western Sahara'
};

// Cube-coordinate rounding assigns every point to its nearest pointy-top hex.
export function hexAddress(x, y, radius) {
  const q = (Math.sqrt(3) * x / 3 - y / 3) / radius;
  const r = 2 * y / (3 * radius);
  let a = Math.round(q), b = Math.round(r), c = Math.round(-q - r);
  const da = Math.abs(a - q), db = Math.abs(b - r), dc = Math.abs(c + q + r);
  if (da > db && da > dc) a = -b - c;
  else if (db > dc) b = -a - c;
  return [a, b];
}

async function initForestMap() {
  const detail = document.getElementById('forest-detail');
  try {
    const [forest, fires, topology] = await Promise.all([
      './data/forest_cover.json', './data/fire_weather_data.json', './vendor/countries-110m.json'
    ].map(async url => {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);
      return response.json();
    }));
    const countries = window.topojson.feature(topology, topology.objects.countries).features;
    const projection = d3.geoEqualEarth().fitExtent([[18, 15], [982, 495]], {type: 'Sphere'});
    const path = d3.geoPath(projection);
    const svg = d3.select('#forest-map');
    const fill = d3.scaleSequential(d3.interpolateRgb('#e2efcd', '#087f5b')).domain([0, 100]);
    const picker = document.getElementById('forest-cell-select');
    const toggle = document.getElementById('forest-fire-toggle');
    const dates = fires.hotspots.map(d => d.date).sort();
    const summary = `${fires.hotspots.length} sampled detections · ${dates[0] || 'No dates'} to ${dates.at(-1) || 'No dates'} · Forest coverage ${forest.year}.`;
    let selectedKey = null;

    function render() {
      const radius = Number(document.getElementById('forest-resolution').value);
      const cells = new Map();
      const center = (q, r) => [radius * Math.sqrt(3) * (q + r / 2), radius * 1.5 * r];
      function add(q, r) {
        const key = `${q},${r}`;
        if (cells.has(key)) return cells.get(key);
        const [x, y] = center(q, r);
        const coords = projection.invert([x, y]);
        const projected = coords && projection(coords);
        // Reject inversions outside the projection's geographic outline.
        if (!coords || !projected || Math.hypot(projected[0] - x, projected[1] - y) > 1) return null;
        const country = countries.find(c => d3.geoContains(c, coords));
        const name = country?.properties.name;
        const value = forest.countries[aliases[name] || name];
        const cell = {key, x, y, coords, name, cover: Number.isFinite(value) ? value : null, count: 0, frp: 0};
        cells.set(key, cell);
        return cell;
      }
      for (let r = 0; r <= 510 / (1.5 * radius); r++) {
        for (let q = Math.floor(-r / 2); q < 1000 / (Math.sqrt(3) * radius) - r / 2; q++) add(q, r);
      }
      for (const fire of fires.hotspots) {
        if (!Number.isFinite(fire.lon) || !Number.isFinite(fire.lat)) continue;
        const [x, y] = projection([fire.lon, fire.lat]);
        const cell = add(...hexAddress(x, y, radius));
        if (cell) { cell.count++; cell.frp += Number.isFinite(fire.frp) ? fire.frp : 0; }
      }
      const visible = [...cells.values()].filter(c => (c.name && c.name !== 'Antarctica') || c.count);
      const active = visible.filter(c => c.count).sort((a, b) => b.count - a.count);
      const fireRadius = d3.scaleSqrt().domain([0, d3.max(active, c => c.count) || 1]).range([0, radius * .82]);
      const hex = d3.range(6).map(i => {
        const angle = (i * 60 - 30) * Math.PI / 180;
        return [Math.cos(angle) * (radius - .7), Math.sin(angle) * (radius - .7)];
      });
      svg.selectAll('g').remove();
      const layer = svg.append('g');
      layer.append('path').datum({type: 'Sphere'}).attr('d', path).attr('fill', '#091b2c').attr('stroke', '#294357');
      const groups = layer.selectAll('g.hex-cell').data(visible).join('g')
        .attr('class', 'hex-cell').attr('transform', c => `translate(${c.x},${c.y})`);
      groups.append('polygon').attr('points', hex.map(p => p.join(',')).join(' '))
        .attr('fill', c => c.cover === null ? '#536575' : fill(c.cover));
      groups.append('circle').attr('class', 'hex-fire').attr('r', c => fireRadius(c.count))
        .attr('fill', '#ff8b38').attr('stroke', '#431d0e').attr('stroke-width', .7)
        .style('display', toggle.checked ? null : 'none').style('pointer-events', 'none');
      const describe = c => `${c.name || 'Coastal / unassigned cell'} · ${c.coords[1].toFixed(1)}°, ${c.coords[0].toFixed(1)}° · National forest area: ${c.cover === null ? 'no data' : `${c.cover.toFixed(1)}% (${forest.year})`} · ${c.count} sampled detections · ${c.frp.toFixed(1)} MW summed FRP.`;
      groups.append('title').text(describe);
      function select(cell) {
        selectedKey = cell?.key || null;
        groups.classed('selected', c => c.key === selectedKey);
        picker.value = cell?.count ? cell.key : '';
        detail.textContent = cell ? `${describe(cell)} ${summary}` : summary;
      }
      groups.on('click', (event, cell) => select(cell));
      picker.replaceChildren(new Option('Select a fire hex…', ''));
      active.forEach(c => picker.add(new Option(`${c.name || 'Coastal cell'} (${c.coords[1].toFixed(1)}°, ${c.coords[0].toFixed(1)}°) · ${c.count} detections`, c.key)));
      picker.onchange = () => select(cells.get(picker.value));
      select(cells.get(selectedKey));
    }
    document.getElementById('forest-resolution').addEventListener('change', () => { selectedKey = null; render(); });
    toggle.addEventListener('change', () => svg.selectAll('.hex-fire').style('display', toggle.checked ? null : 'none'));
    render();
  } catch (error) {
    detail.textContent = `Forest map unavailable: ${error.message}. Reload to try again.`;
    document.querySelectorAll('.forest-controls input, .forest-controls select').forEach(el => { el.disabled = true; });
    console.error('Forest map:', error);
  }
}

initForestMap();

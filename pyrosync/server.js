import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import https from 'node:https';
import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PUBLIC_DIR = path.join(__dirname, 'public');
const PORT = Number(process.env.PORT || 3000);

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

const VENDOR_ROUTES = {
  '/vendor/d3.min.js': path.join(__dirname, 'node_modules/d3/dist/d3.min.js'),
  '/vendor/Tone.js': path.join(__dirname, 'node_modules/tone/build/Tone.js'),
  '/vendor/d3-audio.js': path.join(__dirname, 'node_modules/d3-audio/dist/d3-audio.js'),
  '/vendor/three.module.min.js': path.join(__dirname, 'node_modules/three/build/three.module.min.js'),
  '/vendor/topojson-client.min.js': path.join(__dirname, 'node_modules/topojson-client/dist/topojson-client.min.js'),
  '/vendor/countries-110m.json': path.join(__dirname, 'node_modules/world-atlas/countries-110m.json')
};

function sendJson(res, statusCode, payload) {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-cache'
  });
  res.end(JSON.stringify(payload));
}

function serveFile(filePath, res) {
  const ext = path.extname(filePath).toLowerCase();
  const contentType = MIME_TYPES[ext] || 'application/octet-stream';

  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === 'ENOENT' ? 404 : 500, { 'Content-Type': 'text/plain' });
      res.end(err.code === 'ENOENT' ? '404 Not Found' : '500 Internal Server Error');
      return;
    }
    res.writeHead(200, {
      'Content-Type': contentType,
      'Cache-Control': 'no-cache'
    });
    res.end(data);
  });
}

function fetchHttpsText(url) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'SpatialSequencers/1.0' } }, (resp) => {
      if (resp.statusCode && resp.statusCode >= 400) {
        reject(new Error(`HTTP ${resp.statusCode}`));
        resp.resume();
        return;
      }
      let body = '';
      resp.setEncoding('utf8');
      resp.on('data', (chunk) => { body += chunk; });
      resp.on('end', () => resolve(body));
    }).on('error', reject);
  });
}

function parseModisCsvSample(csvText, limit = 300) {
  const lines = csvText.trim().split(/\r?\n/);
  if (lines.length < 2) return [];
  const headers = lines[0].split(',');
  const idx = Object.fromEntries(headers.map((h, i) => [h.trim(), i]));
  const rows = [];

  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(',');
    const conf = Number(cols[idx.confidence]);
    const frp = Number(cols[idx.frp]);
    const lat = Number(cols[idx.latitude]);
    const lon = Number(cols[idx.longitude]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || !Number.isFinite(frp) || conf < 50) continue;
    rows.push({
      lat: Number(lat.toFixed(3)),
      lon: Number(lon.toFixed(3)),
      frp: Number(frp.toFixed(1)),
      brightness: Number(Number(cols[idx.brightness]).toFixed(1)),
      date: cols[idx.acq_date],
      time: cols[idx.acq_time],
      conf
    });
  }
  rows.sort((a, b) => b.frp - a.frp);
  return {
    totalDetections: lines.length - 1,
    hotspots: rows.slice(0, limit)
  };
}

const server = http.createServer(async (req, res) => {
  const rawPath = decodeURI((req.url || '/').split('?')[0]);

  // Redirect directory roots without trailing slash so relative links resolve cleanly
  if (['/pyrosync', '/spaceship-flyby', '/space-jukebox', '/hub'].includes(rawPath)) {
    res.writeHead(301, { Location: `${rawPath}/` });
    res.end();
    return;
  }

  // Serve the Centralized Navigation Hub at / and /hub/
  if (rawPath === '/' || rawPath === '/index.html' || rawPath === '/hub/' || rawPath === '/hub/index.html') {
    return serveFile(path.join(PUBLIC_DIR, 'hub/index.html'), res);
  }

  const reqPath = rawPath
    .replace(/^\/hub\/(pyrosync|spaceship-flyby|space-jukebox)(?=\/|$)/, '/$1')
    .replace(/^\/pyrosync(?=\/|$)/, '') || '/';

  if (reqPath === '/api/health') {
    return sendJson(res, 200, { status: 'ok', service: 'pyrosync-spatial-sequencers' });
  }

  if (reqPath === '/api/live-modis') {
    try {
      const csvText = await fetchHttpsText(
        'https://firms.modaps.eosdis.nasa.gov/data/active_fire/modis-c6.1/csv/MODIS_C6_1_Global_24h.csv'
      );
      const parsed = parseModisCsvSample(csvText, 300);
      return sendJson(res, 200, {
        fetchedAt: new Date().toISOString(),
        source: 'NASA FIRMS MODIS C6.1 (Global 24h)',
        ...parsed
      });
    } catch (err) {
      return sendJson(res, 502, {
        error: 'Unable to reach NASA FIRMS live feed; bundled dataset remains active.',
        detail: err.message
      });
    }
  }

  if (VENDOR_ROUTES[reqPath]) {
    return serveFile(VENDOR_ROUTES[reqPath], res);
  }

  if (reqPath === '/space-jukebox/' || reqPath === '/space-jukebox/index.html') {
    return serveFile(path.join(PUBLIC_DIR, 'space-jukebox/fly.html'), res);
  }

  const normalized = reqPath === '/' ? '/index.html' : reqPath;
  const resolved = path.resolve(PUBLIC_DIR, `.${normalized}`);
  if (!resolved.startsWith(PUBLIC_DIR)) {
    res.writeHead(403, { 'Content-Type': 'text/plain' });
    res.end('403 Forbidden');
    return;
  }

  fs.stat(resolved, (err, stats) => {
    if (!err && stats.isDirectory()) {
      return serveFile(path.join(resolved, 'index.html'), res);
    }
    serveFile(resolved, res);
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`PyroSync Fire-Weather Observatory listening on http://localhost:${PORT}`);
});

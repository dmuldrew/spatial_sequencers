// Local preview of the Spatial Sequencers website.
//
// Serves the same layout GitHub Pages publishes:
//   /                -> site/index.html          (project hub)
//   /pyrosync/       -> pyrosync/public/         (PyroSync app; /pyrosync/vendor/*
//                                                  is served from pyrosync/node_modules)
//   /space-jukebox/  -> space-jukebox/           (Space Jukebox player + 3D flight)
//
// Usage:  node preview.js [port] [--no-open]     (default port 8080)
// Needs:  Node.js. For PyroSync's vendor libraries, run `npm install`
//         inside pyrosync/ once (preview.bat / preview.sh do it for you).

const http = require("http");
const fs = require("fs");
const path = require("path");
const { exec } = require("child_process");

const ROOT = __dirname;
const args = process.argv.slice(2);
const PORT = Number(args.find(a => /^\d+$/.test(a)) || process.env.PORT || 8080);
const NO_OPEN = args.includes("--no-open");

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".md": "text/plain; charset=utf-8",
  ".txt": "text/plain; charset=utf-8"
};

// Same vendor mapping as pyrosync/scripts/deploy-gh-pages.sh
const VENDOR = {
  "d3.min.js": "d3/dist/d3.min.js",
  "Tone.js": "tone/build/Tone.js",
  "d3-audio.js": "d3-audio/dist/d3-audio.js",
  "topojson-client.min.js": "topojson-client/dist/topojson-client.min.js",
  "countries-110m.json": "world-atlas/countries-110m.json"
};

function sendFile(res, filePath) {
  fs.readFile(filePath, (err, data) => {
    if (err) {
      res.writeHead(err.code === "ENOENT" ? 404 : 500, { "Content-Type": "text/plain" });
      res.end(err.code === "ENOENT" ? "404 Not Found" : "500 Internal Server Error");
      return;
    }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Cache-Control": "no-cache"
    });
    res.end(data);
  });
}

function serveFromDir(res, baseDir, rel) {
  const resolved = path.resolve(baseDir, "." + path.sep + rel);
  if (!resolved.startsWith(path.resolve(baseDir))) {
    res.writeHead(403, { "Content-Type": "text/plain" });
    res.end("403 Forbidden");
    return;
  }
  fs.stat(resolved, (err, stats) => {
    if (!err && stats.isDirectory()) return sendFile(res, path.join(resolved, "index.html"));
    sendFile(res, resolved);
  });
}

const server = http.createServer((req, res) => {
  const urlPath = decodeURI((req.url || "/").split("?")[0]);

  if (urlPath === "/" || urlPath === "/index.html") {
    return sendFile(res, path.join(ROOT, "site", "index.html"));
  }
  if (urlPath.startsWith("/pyrosync/vendor/")) {
    const name = urlPath.slice("/pyrosync/vendor/".length);
    const target = VENDOR[name];
    if (!target) {
      res.writeHead(404, { "Content-Type": "text/plain" });
      return res.end("404 Unknown vendor file");
    }
    return sendFile(res, path.join(ROOT, "pyrosync", "node_modules", target));
  }
  if (urlPath === "/pyrosync" || urlPath.startsWith("/pyrosync/")) {
    return serveFromDir(res, path.join(ROOT, "pyrosync", "public"), urlPath.slice("/pyrosync".length) || "/");
  }
  if (urlPath === "/space-jukebox" || urlPath.startsWith("/space-jukebox/")) {
    return serveFromDir(res, path.join(ROOT, "space-jukebox"), urlPath.slice("/space-jukebox".length) || "/");
  }
  res.writeHead(404, { "Content-Type": "text/plain" });
  res.end("404 Not Found\n\nThis preview serves:\n  /\n  /pyrosync/\n  /space-jukebox/\n");
});

server.listen(PORT, () => {
  const base = `http://localhost:${PORT}`;
  console.log("Spatial Sequencers — local preview");
  console.log(`  Hub:           ${base}/`);
  console.log(`  PyroSync:      ${base}/pyrosync/`);
  console.log(`  Space Jukebox: ${base}/space-jukebox/`);
  console.log(`  3D flight:     ${base}/space-jukebox/fly.html`);
  const d3 = path.join(ROOT, "pyrosync", "node_modules", "d3");
  if (!fs.existsSync(d3)) {
    console.log("\n  NOTE: PyroSync vendor libraries not installed yet.");
    console.log("  Run `npm install` inside the pyrosync/ folder once, then restart.");
  }
  console.log("\nPress Ctrl+C to stop.");
  if (!NO_OPEN) {
    const cmd = process.platform === "win32" ? `start "" "${base}"`
      : process.platform === "darwin" ? `open "${base}"`
      : `xdg-open "${base}"`;
    exec(cmd, () => { /* browser opening is best-effort */ });
  }
});

# spatial_sequencers

Team workspace for the 2026 NASA International Space Apps Challenge (Seattle).
Forked from dmuldrew/spatial_sequencers and restructured so each project
lives in its own subfolder.

## Sub-projects

### PyroSync — `pyrosync/`

Interactive NASA Fire-Weather Observatory & spatial audio-visual sequencer
(NASA FIRMS fire data; D3 + Tone.js + Three.js), featuring three tabbed views:
26-Year Wildfire Spiral (`/#spiral`), Central Iowa MODIS Hex Map (`/#iowa-map`),
and 3D Orbital Flyby (`/#flyby`).
Live demo: https://dmuldrew.github.io/spatial_sequencers/pyrosync/
Project hub: https://dmuldrew.github.io/spatial_sequencers/

Run locally:

    cd pyrosync
    npm install
    npm start

See [`pyrosync/README.md`](pyrosync/README.md) for architecture details,
sonification mappings, `raster_h3` Midwest GeoTIFF preparation, and challenge
summaries.

### Space Jukebox — `space-jukebox/`

Sonification of NASA/NOAA Earth data, built for blind and low-vision
listeners first (The Earth Information Jukebox challenge), including `fly.html`
("3D Fire Flight"). Live demo:
https://dmuldrew.github.io/spatial_sequencers/space-jukebox/

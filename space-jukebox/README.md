# Space Jukebox — 3D Fire Flight

A spaceship flies an auto-piloted tour of a 3D Earth while the data
underneath becomes sound — the ship is the playhead, and the map is
the score. Built for **The Earth Information Jukebox** challenge
(NASA Space Apps 2026) as the side project of **PyroSync**, and
designed audio-first for blind and low-vision listeners: narration
is on by default, so the whole flight works with your eyes closed.

**One subject — Earth. Any map as input.** The flight reads a point
dataset (position + intensity). The current dataset is wildfire; a
different map — a temperature grid, sea ice, city lights — plugs
into the same loop with no new machinery.

## Run it

From the repo root:

    npm run preview

then open http://localhost:8080/space-jukebox/ — or just open
`fly.html` in a browser. It is a single self-contained file; only
the 3D library loads from a CDN.

Live demo: https://dmuldrew.github.io/spatial_sequencers/space-jukebox/fly.html

## The flight

Six fire regions, west to east, ~80 seconds per loop: California
& W. US, Boreal N. America, Amazon & Cerrado, Sahel & N. Savanna,
Mediterranean Basin, Australian Outback. The dataset is the main
project's: 330 NASA FIRMS (MODIS) hotspots with fire radiative
power (FRP), embedded from PyroSync's bundled data.

## How it sounds

- **Continuous tone:** two detuned saws through a pitch-tracking
  lowpass filter. Pitch and brightness follow the FRP-weighted fire
  intensity near the ship (Gaussian falloff, ~16° radius) — calm
  ocean is a low hum; a fire region climbs.
- **Pings:** passing within ~5.5° of a major hotspot (FRP ≥ 280)
  strikes a note whose pitch and loudness scale with that fire's
  FRP. The loudest moment on the planet: Australia, FRP 5083.
- **Narration:** entering a region speaks its name, hotspot count,
  and strongest FRP. Toggle with the Narration button or the N key.

## Controls

Space play/pause · N narration · C chase/orbit camera · ↑/↓ speed.
The HUD shows the current region, a fire-intensity meter, and the
ship's coordinates; a screen-reader live region announces each
region as it is reached.

## Technical notes

- Single HTML file; Three.js (CDN) for the globe, the Web Audio
  API for synthesis, Speech Synthesis for narration. No build
  step, no backend, no runtime data fetches.
- The globe's land is a dot grid rasterized at build time from
  Natural Earth country borders (1.5° cells, ~8,300 dots) — no
  texture images.
- The ship follows a closed Catmull-Rom spline through the six
  region centers at fixed altitude; fire intensity is computed
  per frame from the embedded hotspot array.

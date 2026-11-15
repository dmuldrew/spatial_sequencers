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

then open http://localhost:8123/space-jukebox/ — or just open
`fly.html` in a browser. It is a single self-contained file; the
3D library is vendored with the repo, with a CDN fallback for when
the file is opened straight from disk.

Live demo: https://dmuldrew.github.io/spatial_sequencers/space-jukebox/fly.html

## The flight

Six fire regions, west to east, ~80 seconds per loop: California
& W. US, Boreal N. America, Amazon & Cerrado, Mediterranean Basin,
Sahel & N. Savanna, Australian Outback. The dataset is the main
project's: the 330 largest NASA FIRMS (MODIS) hotspots — selected
from 80,347 detections in the bundled 7-day set — with fire
radiative power (FRP), embedded from PyroSync's data.

## How it sounds

- **Continuous tone:** a bowed-string voice — two detuned saws with
  vibrato and a formant peak, through a pitch-tracking lowpass
  filter. Pitch and brightness follow the FRP-weighted fire
  intensity near the ship (Gaussian falloff, ~16° radius) — calm
  ocean is a low hum; a fire region climbs.
- **Pings:** passing within ~5.5° of a major hotspot (FRP ≥ 280)
  strikes a short pizzicato note whose pitch and loudness scale
  with that fire's FRP. The loudest moment on the planet:
  Australia, FRP 5083.
- **Narration:** before takeoff, the start screen speaks a short
  briefing (what a hotspot is, fire power in megawatts, the keys) —
  the Start button stays a Skip button until it finishes. In
  flight, entering a region speaks its name, hotspot count, total
  megawatts, strongest fire, and strength ranking; crossing open
  water names the ocean and the compass heading; a region's
  densest core gets a callout. Toggle with the Narration button
  or the N key.
- **On the map:** hotspot dots are sized by FRP as well as coloured,
  each fire flickers on its own phase, and the dots swell and
  brighten with the intensity under the ship. Every hotspot also
  wears a **bar of light** extruded from the surface — height on
  the same log FRP scale, so the strongest fires stand tallest.

## Controls

Space play/pause · S whereabouts · N narration · M mute · C
chase/orbit camera · G manual pilot · ↑/↓ speed. Shortcuts stand
down while a button has focus, so Space still activates the
control you are on.

The HUD shows the current region, a fire-intensity meter, the
ship's coordinates, and tour progress (which stop you are at, and
the next one); a screen-reader live region announces each region
as it is reached, and **S** speaks the current region (or the
ocean being crossed), the compass heading, and the live fire
intensity on demand. The intensity meter grows in height as well
as width. Hotspot pings are panned left/right toward the side the
fire is on.

## Manual pilot

The tour is auto-piloted, but you can take the controls: the
**Pilot** button (or the G key) switches to manual flight, and
switching back resumes the tour from wherever you left it. Mode
changes are announced aloud. Steer with the arrow keys or WASD
(↑/↓ set speed) — or plug in an **Xbox controller**: left stick
steers, pushing it forward (or the right trigger) speeds up, the
left trigger slows down, A pauses/resumes, Y narration, X mute,
B camera, bumpers set tour speed, and Start switches pilot mode.
Everything sonified keeps working in manual flight, because the
sound has always been driven by where the ship is, not by the
tour path. Switching to manual also flattens the globe into a
flat (equirectangular) map for the flight; flight on the map is
planar — straight lines stay straight, east holds your latitude,
the world loops at the left and right edges — and switching back
restores the sphere.

## Technical notes

- Single HTML file; Three.js for the globe, the Web Audio API for
  synthesis, Speech Synthesis for narration. No build step, no
  backend, no runtime data fetches. The 3D library is imported from
  the copy vendored with the repo (the same file PyroSync loads),
  so the flight works offline; the CDN is only a fallback for
  opening `fly.html` from disk.
- The globe's land is a dot grid rasterized at build time from
  Natural Earth country borders (1.5° cells, ~8,300 dots) — no
  texture images.
- The ship follows a closed Catmull-Rom spline through the six
  region centers, projected onto one constant-altitude shell so it
  flies exactly along the drawn path. Fire intensity and the ping
  proximity test share a single dot-product pass over the hotspot
  array, with far hotspots rejected before any trig.
- Continuous tone and pings duck under narration, the flight is
  silent while paused, and `prefers-reduced-motion` stills the
  hotspot pulse and the orbit camera.

# Space Jukebox — accessible sonification prototype

Built for **The Earth Information Jukebox** challenge (NASA Space Apps
2026): turn Earth data into sound so people can *hear* the planet
changing. Designed audio-first, for blind and low-vision listeners.

**One subject — Earth. Any map as input.** The two tracks below are
examples; the player underneath is data-agnostic. Any map — a gridded
dataset, a time series sampled from one, a layer from the Earth
Information Center catalog — can be fed in and played the same way.

## Run it

Open `index.html` in any browser — one file, no dependencies, no build.
Live demo: https://lanly-dev.github.io/spatial_sequencers/space-jukebox/

## Tracks

1. **Global temperature** — NASA GISS GISTEMP v4 annual anomalies, 1880–2025.
2. **Carbon dioxide** — NOAA Mauna Loa annual means (the Keeling Curve), 1959–2025.

## The 3D Fire Flight — `fly.html`

A second way to play a map: a spaceship flies an auto-piloted tour of a
3D dot globe while the data underneath becomes sound — here the ship is
the playhead, and the map is the score. The dataset is the main
project's: 330 NASA FIRMS hotspots across six fire regions (California
& W. US, Boreal N. America, Amazon & Cerrado, Sahel & N. Savanna,
Mediterranean Basin, Australian Outback), embedded from PyroSync's
bundled data.

- **Continuous tone:** pitch and brightness follow the FRP-weighted fire
  intensity near the ship (Gaussian falloff, ~16° radius).
- **Pings:** passing within ~5.5° of a major hotspot (FRP ≥ 280) strikes
  a note whose pitch and loudness scale with that fire's FRP.
- **Narration on by default:** each region is announced with its hotspot
  count and strongest FRP, so the flight works eyes-closed. Chase and
  orbit cameras, speed control, full keyboard control (Space, N, C,
  arrow keys).
- **The globe's land** is a dot grid rasterized at build time from
  Natural Earth country borders (1.5° cells) — no textures, no runtime
  data fetches.

Live: https://lanly-dev.github.io/spatial_sequencers/space-jukebox/fly.html

## How a map becomes a track (input model)

A track is just a value series plus a small mapping config:

| Field | Meaning |
|---|---|
| `values[]` | One number per time step (year, month, frame…) |
| `refVal` / `refFreq` | The value that sounds the home tone, and its frequency |
| `span` | How many value-units equal one octave |
| `unit` / formatter | How a value is spoken and displayed (e.g. “plus 0.61 degrees”) |

Any dataset that can be reduced to a series fits: global temperature,
CO₂, Arctic sea-ice extent, sea level, fire counts per season, ocean
current speeds along a path. New track = new series + four config
values; the instruments, playback, speech, and accessibility layers
are shared and unchanged.

## Technical notes

**Architecture.** A single self-contained HTML file — no dependencies,
no build step, no backend. All audio is synthesized live with the Web
Audio API; spoken scaffolding uses the Speech Synthesis API. Data is
embedded as arrays at build time (fetched once from the sources below),
so playback works offline and never waits on the network.

**Data sources.**
- Temperature: NASA Goddard Institute for Space Studies, GISTEMP v4
  global annual anomalies (`GLB.Ts+dSST.csv`), 1880–2025; 2026 excluded
  as an incomplete year.
- CO₂: NOAA Global Monitoring Laboratory, Mauna Loa annual mean
  concentrations (`co2_annmean_mlo.txt`), 1959–2025.

**Value → sound mapping.**
- *Violin (continuous):* pitch is exponential in the value —
  `freq = refFreq × 2^((value − refVal) / span)`. No scale quantization:
  the line bends exactly the way the data bends. Temperature uses
  ref 0.00 °C at E4 (329.63 Hz), span 1.5 °C/octave; CO₂ uses ref
  315.98 ppm at C4 (261.63 Hz), span 90 ppm/octave.
- *Pluck (discrete):* the same values are quantized to a pentatonic
  scale (C D E G A) — one note per year, the friendlier first listen.
- One year per step; tempo is user-adjustable. A full temperature
  track is 146 steps, about 37 seconds at the default rate.

**Violin synthesis.** Two detuned sawtooth oscillators feed a lowpass
filter whose cutoff tracks pitch (brighter as the line climbs).
Vibrato: 5.5 Hz LFO, ±15 cents, with a ~200 ms delayed onset per note.
Legato portamento (~100 ms glides) connects steps so the line sings
instead of hopping. A faint filtered-noise layer adds bow texture;
a master compressor keeps levels even.

**Speech & navigation scaffolding.** Every track ships a spoken
introduction (what you will hear, the start and end values), decade
markers during playback, and a spoken summary at the end. A reference
“home tone” can be replayed at any time (R key), and “Where am I?”
(W key) speaks the current year and value. A screen-reader live region
announces state changes, and the scrubber exposes each position as
text (“Year 1998, plus 0.61 degrees”).

## Accessibility features

- Spoken "how to listen" guide and a reference (home) tone per track
- Spoken introductions, decade markers, end-of-track summaries, "Where am I?"
- Full keyboard control (Space, arrow keys, 1/2, W, R, S)
- Screen-reader labels, live announcements, and a full data table per track
- Sound-first mode: chart hidden, oversized readout
- Instruments: continuous-glide synth violin, or pentatonic pluck

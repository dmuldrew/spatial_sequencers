# Spatial Sequencers — PyroSync Fire-Weather Observatory

**Live Demo:** **[https://dmuldrew.github.io/spatial_sequencers/](https://dmuldrew.github.io/spatial_sequencers/)**

An interactive **audio-visual NASA wildfire & meteorology observatory** built with **[d3-audio](https://github.com/dmuldrew/d3-audio)**, **D3.js v7**, and **Tone.js**, alongside research summaries for the **2026 NASA International Space Apps Challenge** tracks.

---

## PyroSync: Audio-Visual Fire-Weather Experience

**PyroSync** combines **26 years of NASA POWER monthly meteorology (2001–2026)**, a **30-year climatological baseline (1991–2020)**, **NASA EONET v3 wildfire outbreaks (2015–2026)**, and **NASA FIRMS MODIS C6.1 thermal hotspots** around a single unified audiovisual instrument:

- **26-Year Wildfire Climate Spiral** *(inspired by `d3-audio` Example 15 — Climate Rhythm Quest)*: Unrolls **309 monthly steps (`2001-01` → `2026-09`)** across six global fire biomes with a switchable radial axis (**Norm Deviation $\sigma$**, **Fosberg FWI**, **VPD Dryness (kPa)**, or **EONET Fire Counts**). Concentric risk threshold rings mark severity boundaries while golden/crimson flares highlight confirmed EONET wildfire outbreaks (`2015–2026`).
- **Centered 3D Geographic Globe Locator** *(inspired by `d3-audio` Example 13 — Seismic Simon)*: Nested inside the inner radius of the spiral, a live `d3.geoOrthographic()` 3D globe rotates smoothly to frame the active biome polygon and plot NASA FIRMS MODIS 7-day (or on-demand live 24-hour) thermal fire detections.
- **Harmonic Tension for Significant Norm Departure**: Rather than confusing normal seasonal summers with unprecedented extremes, `d3-audio` `scaleTension()` maps positive departure from the 1991–2020 normal (`0.0σ` → `+3.0σ`) from warm Consonant C-major chords (`C3 G3 C4 E4`) through Moderate/Tense intervals into Dissonant tritones (`C3 F#3 Bb3 Db4`), microtonal detuning (`0–60¢`), increased FM modulation grit, and coupled playback acceleration.
- **Climate Norm "What-If" Sandbox & Interactive `audioLegend()`**: Perturb temperature, humidity, or wind (`+18% Coastal Humidity`, `-45% Peak Wind Gusts`, `Rain / Moisture Pulse`, `+3.5 °C Heatwave`), watch the `zScore` recalculate live against the 1991–2020 baseline, and hear tritone dissonance resolve back into consonance.

### NASA Datasets Used

| Source | Coverage | Role in App |
| :--- | :--- | :--- |
| **[NASA POWER v2 Monthly](https://power.larc.nasa.gov/)** | `1991–2026` (`T2M_MAX`, `RH2M`, `WS10M`, `PRECTOTCORR`) | Computes 1991–2020 30-year seasonal normals & standardized monthly VPD/FFWI `zScore` departures (`2001–2026`) |
| **[NASA EONET v3](https://eonet.gsfc.nasa.gov/api/v3/events)** | `2015–2026` global wildfire events | Monthly wildfire outbreak flares overlaid onto the 2015–2026 spiral turns & telemetry table |
| **[NASA FIRMS MODIS C6.1](https://firms.modaps.eosdis.nasa.gov/)** | Global 7-day archive + Live 24h refresh (`/api/live-modis`) | Active thermal hotspot coordinates & Fire Radiative Power (`MW`) plotted on the central 3D globe |

### `d3-audio` Sonification Mapping

| Physical Variable | `d3-audio` Scaler | Meaningful Auditory Signal |
| :--- | :--- | :--- |
| **1991–2020 Norm Deviation (`σ`)** | `scaleTension()` (`Chords`, `Detune 0–60¢`, `FM Index`, `Tempo`) | Normal variability (`<+0.9σ`) stays warm and Consonant; statistically significant anomalies shift into Tense/Dissonant tritones and FM grit |
| **Anomaly & EONET Fire Intensity** | `scalePitch()` (`C3` → `E6`) + `scaleGain()` | Baseline months whisper in deep octaves; compounding heat/dryness departures and active wildfire months ring higher and louder |
| **Vapor Pressure Deficit (VPD)** | `scaleFilter()` (`320` → `8,800 Hz`) | Moist air sounds muffled and warm; arid, fuel-curing air opens the lowpass filter into crisp brightness |
| **10m Surface Wind Speed** | `scaleRhythm()` (`euclideanRhythm`) | Wind speed controls Bjorklund Euclidean ember pulse density |
| **Biome Longitude** | `scalePan()` (`-0.85` to `+0.85`) | Aligns stereo field with the centered 3D globe (Americas left, Europe/Africa center, Asia/Australia right) |

---

## How to Run the App

### Option 1: Docker Compose (Recommended)

Prerequisites: [Docker Desktop](https://www.docker.com/products/docker-desktop/) or Docker Engine with Compose v2.

```bash
# Build the image and start PyroSync in the background
docker compose up -d --build
```

Open **[http://localhost:3000](http://localhost:3000)** in your browser, then click **Enable Audio** (or **Play 2001–2026**) to unlock Web Audio.

Useful Docker Compose commands:

```bash
# Stream container logs
docker compose logs -f pyrosync

# Check container health status
docker compose ps

# Stop and remove the container
docker compose down
```

### Option 2: Docker CLI

```bash
# Build the Docker image
docker build -t spatial-sequencers-pyrosync:latest .

# Run on port 3000 (override PORT if needed)
docker run --rm -p 3000:3000 --name pyrosync-observatory spatial-sequencers-pyrosync:latest
```

### Option 3: Local Node.js (without Docker)

Requires **Node.js 20+** and `git` (for installing `d3-audio` from GitHub):

```bash
npm install
npm start
```

Then visit **[http://localhost:3000](http://localhost:3000)**.

### Option 4: Deploy to GitHub Pages

PyroSync uses relative asset paths (`./styles.css`, `./vendor/...`, `./data/...`) so it runs identically on GitHub Pages under `/spatial_sequencers/`.

#### Automated via GitHub Actions (Recommended)

This repository includes [.github/workflows/deploy-pages.yml](.github/workflows/deploy-pages.yml), which builds `./dist` on every push to `main` (reusing `./scripts/deploy-gh-pages.sh --build-only`) and deploys it via GitHub Pages.

1. On GitHub, open **Repository Settings → Pages**.
2. Under **Build and deployment**, set **Source** to **GitHub Actions**.
3. Push any commit to `main` (or click **Run workflow** in the **Actions** tab) to publish **`https://dmuldrew.github.io/spatial_sequencers/`**.

#### Manual Branch Deploy via Script

1. Run the deploy script from the repository root to build and push to `gh-pages`:
   ```bash
   # Preview/validate the static bundle locally without pushing (optional)
   ./scripts/deploy-gh-pages.sh --dry-run

   # Build and force-push the static bundle to origin/gh-pages
   ./scripts/deploy-gh-pages.sh
   ```
2. Under **Repository Settings → Pages**, set **Source** to **Deploy from a branch** → **`gh-pages`** → **`/ (root)`**, then click **Save**.

> Note: The **Live 24h** `/api/live-modis` proxy button requires the Node/Docker backend; on static GitHub Pages, the app gracefully stays on the bundled 7-day NASA FIRMS MODIS archive.

### Refreshing the Bundled NASA Dataset

A pre-fetched, verified NASA dataset is committed at [public/data/fire_weather_data.json](public/data/fire_weather_data.json) so the container runs immediately without external API delays. You can regenerate it from live NASA EONET, FIRMS MODIS, and POWER APIs anytime with Python 3 (standard library only):

```bash
python3 scripts/fetch_nasa_data.py
```

Inside the running web app, clicking **Live 24h** queries `/api/live-modis` on the Node server to pull fresh NASA FIRMS MODIS C6.1 global 24-hour thermal detections onto the 3D globe.

---

## Project Structure

```text
spatial_sequencers/
├── .github/workflows/
│   └── deploy-pages.yml        # GitHub Actions workflow deploying ./dist to GitHub Pages
├── Dockerfile                  # Node 22 Alpine container image
├── docker-compose.yml          # Compose service exposing port 3000
├── package.json                # Dependencies: d3, d3-audio, tone, topojson-client, world-atlas
├── server.js                   # Static + /vendor + /api/health + /api/live-modis proxy server
├── scripts/
│   ├── deploy-gh-pages.sh      # Stages public/ + vendor/ + .nojekyll and pushes to gh-pages
│   └── fetch_nasa_data.py      # Fetches & joins NASA EONET, FIRMS MODIS, and POWER data
└── public/
    ├── index.html              # Accessible semantic UI for the Wildfire Spiral + Center Globe
    ├── styles.css              # Dark/light color-scheme styles, responsive tables, reduced motion
    ├── data/
    │   └── fire_weather_data.json
    └── js/
        ├── enable-audio.js     # Web Audio & iOS unlock helper
        └── app.js              # 26-year Spiral, Centered 3D Globe & scaleTension() engine
```

---

## 2026 NASA Space Apps Challenge Summaries

### 1. [The Earth Information Jukebox](https://www.spaceappschallenge.org/2026/challenges/the-earth-information-jukebox/)

- **Subjects:** Arts & Multimedia, Earth Science, Software
- **Difficulty:** Beginner (Youth) / Intermediate
- **Problem:** NASA's Earth Information Center (EIC) produces rich visualizations of planetary changes (such as shifting temperatures, melting ice sheets, and oceanic currents), but relying solely on visual media limits accessibility for blind and low-vision audiences and narrows how users can engage with the data.
- **Goal:** Build an interactive "Earth Jukebox" (application, interface, or script) that translates sight into sound by pairing EIC visual frames with dynamic, real-time data sonifications.
- **Key Approaches:**
  - Map visual parameters—such as color spectra, pixel density, shapes, or time-series environmental metrics—to musical elements, frequencies, chords, rhythms, or synthesizer parameters.
  - Enable users to browse geographic regions or EIC datasets and experience corresponding auditory timelines and soundscapes.
  - Combine scientific rigor with artistic design to make Earth science more accessible and engaging.

### 2. [Dancing with the SARs](https://www.spaceappschallenge.org/2026/challenges/dancing-with-the-sars/)

- **Subjects:** Earth Science
- **Difficulty:** Intermediate / Advanced
- **Problem:** Earth's surface is constantly changing due to natural processes and human activities—including wetland loss, wildfires, earthquakes, agricultural shifts, and glacier movement—which can be difficult to track, interpret, and communicate clearly.
- **Goal:** Create an interactive application, tool, or visual narrative using radar remote sensing data from the **NASA-ISRO Synthetic Aperture Radar (NISAR)** mission to track and explain surface changes over time.
- **Key Approaches:**
  - Analyze SAR imagery across multiple dates, polarizations, and/or frequencies to detect surface changes.
  - Combine SAR time-series observations with ancillary datasets (such as vegetation cover or population density) to hypothesize and explain underlying physical or human drivers.
  - Present findings through interactive maps, image sliders, dashboards, story maps, reports, or multimedia presentations.

### 3. [Harmonization of MODIS and VIIRS Hot Spots](https://www.spaceappschallenge.org/2026/challenges/modis-and-viirs-hot-spots/)

- **Subjects:** Earth Science, Software / Web Development
- **Difficulty:** Intermediate / Advanced
- **Problem:** Satellites have monitored global active fire hotspots (wildfires, controlled burns, and agricultural burning) for over two decades using **MODIS** (~1 km resolution) and **VIIRS** (375 m resolution). Because the sensors differ in spatial resolution, sensitivity, and observation schedules, their raw hotspot records cannot be directly compared, leaving researchers and land managers without a consistent long-term baseline.
- **Goal:** Develop a web application and data pipeline that harmonizes MODIS and VIIRS active-fire records—such as datasets from **NASA FIRMS** (Fire Information for Resource Management System)—into a unified **"Burning Activity Calendar"** or standardized grid.
- **Key Approaches:**
  - Normalize cross-sensor discrepancies onto a common spatial and temporal framework.
  - Provide interactive maps, seasonal comparisons, and historical charts (e.g., comparing current-month burning against historical medians) for a user-selected area of interest.
  - Support scientists, land managers, and emergency responders in identifying unusual burning periods and long-term fire trends.

### Comparison at a Glance

| Challenge | Primary Data / Domain | Core Output | Difficulty |
| :--- | :--- | :--- | :--- |
| **The Earth Information Jukebox** | NASA Earth Information Center (EIC) visuals | Real-time visual-to-audio sonification tool | Beginner (Youth) / Intermediate |
| **Dancing with the SARs** | NISAR Synthetic Aperture Radar (SAR) | Interactive surface-change tracker & visual narrative | Intermediate / Advanced |
| **Harmonization of MODIS and VIIRS Hot Spots** | NASA FIRMS active fire hotspots (MODIS & VIIRS) | Harmonized Burning Activity Calendar & web dashboard | Intermediate / Advanced |

## Central Iowa MODIS hexagon map

The map below the PyroSync spiral covers a 180 × 120 mile study area centered
on 42°N, 93.5°W. The bundled July 11–26, 2024 Terra MODIS snapshot has
7,443 H3 cells with both inputs. This map has its own zoom slider and is also
available at `/midwest/map.html`. Use `/#iowa-map` to jump to it from the dashboard.

- **MOD11A2 daytime land surface temperature** (°C) is averaged from
  two quality-filtered 8-day composites. It controls hue from green to brown.
- **MOD13Q1 NDVI** comes from one quality-filtered 16-day composite. It
  controls saturation from 5% to 95%.
- Both inputs use the visible 5th–95th percentiles for color, with values
  outside those limits clipped to the endpoints. Views with fewer than 20
  observations per input use the full range. Gray cells are missing one or both inputs. Click a hexagon for raw and normalized values. The
  closest zoom depends on the coarser active input's source resolution.

The map's input definitions, appearance, zoom policy, and sonification extension
point live in `public/midwest/js/domain/`. The July snapshot and its source
provenance are in `public/midwest/data/midwest.json`. The existing PyroSync
spiral handles its own audio. To regenerate the map snapshot from the source
GeoTIFF bands, run `python3 scripts/prepare_midwest.py /path/to/geotiffs` with
Rasterio, NumPy, and H3 v4 installed.

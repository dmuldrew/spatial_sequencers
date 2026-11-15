# Combined Spaceship Flyby — `spaceship-flyby/`

A standalone website choice (`/spaceship-flyby/`) that unites the **3D Fire Flight** (`space-jukebox/fly.html`) sound landscape with the **PyroSync Fire-Weather Observatory** (`pyrosync/`) sound landscape and 3D planetary visualization.

## Unified Sound Landscape Layers

1. **Continuous Thermal Violin Line (from 3D Fire Flight):**
   - Two detuned sawtooth oscillators (`-6¢` / `+5¢`) with `5.5 Hz` vibrato LFO feeding a resonant lowpass filter (`Q = 2.1`).
   - Pitch (`110 Hz × 2^(norm × 2.1)`) and filter cutoff (`500–3100 Hz`) glide continuously with the Gaussian-weighted NASA FIRMS Fire Radiative Power (`FRP`) beneath the spacecraft.
2. **Harmonic Tension Chord Pad (from PyroSync Observatory):**
   - 4-voice polyphonic synth mapping the active month's (`2001-01` → `2026-09`) departure `zScore (σ)` from the 1991–2020 NASA POWER seasonal normal:
     - **Consonant (`< +0.9σ`):** C major (`C3 G3 C4 E4`, `0¢` detune)
     - **Moderate (`+0.9σ` to `+1.5σ`):** Cmaj9 (`C3 E3 G3 B3`, `6–14¢` detune)
     - **Tense (`+1.5σ` to `+2.2σ`):** C7#11 (`C3 E3 F#3 Bb3`, `18–30¢` detune)
     - **Extreme Dissonant (`≥ +2.2σ`):** Tritone cluster (`C3 F#3 Bb3 Db4`, up to `60¢` detune)
3. **Proximity Hotspot Bells & Central Iowa MODIS H3 Hex Plucks:**
   - Passing within `5.5°` of major FIRMS hotspots (`FRP ≥ 280 MW`) triggers a stereo-panned sine bell (`620–1500 Hz`).
   - Flying over the Central Iowa MODIS H3 hexagon patch (`7,443` cells) triggers pentatonic triangle plucks scaled to Land Surface Temperature.
4. **Euclidean Wind-Ember Pulses & Atmospheric Jet Stream:**
   - 16-step Bjorklund Euclidean rhythm generator driven by 10m wind speed (`WS10M`) and filtered by Vapor Pressure Deficit (`VPD kPa`), layered over a speed-responsive bandpass jet stream.
5. **Audio-First Spoken Narration, *Where Am I?*, & `0σ` Home Tone:**
   - Automatic Web Speech API region briefings announcing hotspot count, peak FRP, and climate departure `σ` + harmonic state.
   - Keyboard-accessible **Where Am I?** (`I` key) and **Home Tone (0σ)** (`R` key) landmarks.

const BEAT = 60 / 122;
const BEATS_PER_BAR = 4;
const TAU = 2 * Math.PI;

// "The Rakes of Mallow", O'Neill no. 1814, with the opening eight bars
// expanded from 2/4 to 4/4. Pitches are semitones from C4.
const F_SHARP = 6, G = 7, A = 9, B = 11, C = 12, D = 14;
const halfBeat = (...pitches) => pitches.map(pitch => [pitch, 0.5]);
const MELODY = [
  [G, B, G, B],
  [G, B, ...halfBeat(C, B, A, G)],
  [F_SHARP, A, F_SHARP, A],
  [F_SHARP, A, ...halfBeat(D, C, B, A)],
  [G, B, G, B],
  [G, B, D, B],
  halfBeat(C, B, A, G, F_SHARP, G, A, C),
  [B, G, G],
];
const ROOTS = [G, G, D % 12, D % 12, G, G, C % 12, G];

// One representative setting per d3-audio tension tier.
export const TENSION_PRESETS = [0, 0.45, 0.72, 1];

export function createVampScale(d3Audio) {
  return d3Audio.scaleTension()
    .domain([0, 1])
    .tempoRange([1, 1])
    .filterRange([350, 5000])
    .detuneRange([0, 60]);
}

export function renderVamp(guitar, sampleRate, tension, d3Audio) {
  const output = new Float32Array(Math.round(MELODY.length * BEATS_PER_BAR * BEAT * sampleRate));
  const intervals = tension.chord.map(note => d3Audio.parseNote(note).midi);
  const filterStep = 1 - Math.exp(-TAU * tension.filterCutoff / sampleRate);

  function pluck(pitch, beat, beats, level) {
    const start = Math.round(beat * BEAT * sampleRate);
    const count = Math.round(beats * BEAT * 0.9 * sampleRate);
    const step = (guitar.sampleRate / sampleRate) * (261.626 / 262.5) * 2 ** (pitch / 12);
    for (let i = 0; i < count; i++) {
      const position = i * step;
      const frame = Math.floor(position);
      if (frame + 1 >= guitar.pcm.length) break;
      const a = guitar.pcm[frame], b = guitar.pcm[frame + 1];
      const envelope = Math.min(1, i / (0.004 * sampleRate), (count - 1 - i) / (0.032 * sampleRate));
      output[start + i] += (a + (b - a) * (position - frame)) * envelope * level;
    }
  }

  function sustainChord(root, beat) {
    const start = Math.round(beat * BEAT * sampleRate);
    const count = Math.round(BEATS_PER_BAR * BEAT * 0.98 * sampleRate);
    for (const [index, midi] of intervals.entries()) {
      // Spread the detune across the chord so it changes the intervals.
      const offset = index === 0 ? 0 : (index % 2 === 0 ? -1 : 1) * index / (intervals.length - 1);
      const pitch = midi + root + offset * tension.detuneCents / 100;
      const phaseStep = TAU * d3Audio.midiToFrequency(pitch) / sampleRate;
      let filtered = 0;
      for (let i = 0; i < count; i++) {
        const phase = i * phaseStep;
        const tone = Math.sin(phase) + 0.32 * Math.sin(phase * 2)
          + 0.19 * Math.sin(phase * 3) + 0.10 * Math.sin(phase * 5);
        filtered += (tone - filtered) * filterStep;
        const envelope = Math.min(1, i / (0.045 * sampleRate), (count - 1 - i) / (0.12 * sampleRate));
        output[start + i] += filtered * envelope * 0.095;
      }
    }
  }

  for (const [bar, melody] of MELODY.entries()) {
    const start = bar * BEATS_PER_BAR;
    sustainChord(ROOTS[bar], start);
    let beat = start;
    for (const entry of melody) {
      const [pitch, beats] = Array.isArray(entry) ? entry : [entry, 1];
      pluck(pitch, beat, beats, beat % 2 === 0 ? 0.42 : 0.32);
      beat += beats;
    }
  }
  return output;
}

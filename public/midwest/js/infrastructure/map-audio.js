const BEAT = 60 / 122;
const BEATS_PER_BAR = 4;
const LEVEL = 0.5;

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
  [B, G, G], // Rest on the last beat.
];
const BASS = [G, G, D, D, G, G, C, G].map(pitch => pitch % 12);
const INSTRUMENTS = [
  { name: 'guitar', sampleHz: 262.5, attack: 0.004, gate: 0.96, level: 0.72 },
  { name: 'trumpet', sampleHz: 259.412, attack: 0.008, gate: 0.88, level: 0.9 },
];

async function renderVamp(context, instrument) {
  const response = await fetch(new URL(`../../audio/${instrument.name}.wav`, import.meta.url));
  if (!response.ok) throw new Error(`Could not load ${instrument.name}`);
  const sample = await context.decodeAudioData(await response.arrayBuffer());
  const sampleRate = context.sampleRate;
  const length = Math.round(MELODY.length * BEATS_PER_BAR * BEAT * sampleRate);
  const track = new OfflineAudioContext(1, length, sampleRate);

  function note(pitch, position, beats, level) {
    const source = track.createBufferSource();
    const envelope = track.createGain();
    const start = position * BEAT;
    const end = start + beats * BEAT * instrument.gate;
    source.buffer = sample;
    source.playbackRate.value = (261.626 / instrument.sampleHz) * 2 ** (pitch / 12);
    envelope.gain.setValueAtTime(0, start);
    envelope.gain.linearRampToValueAtTime(level * instrument.level, start + instrument.attack);
    envelope.gain.setValueAtTime(level * instrument.level, end - 0.035);
    envelope.gain.linearRampToValueAtTime(0, end);
    source.connect(envelope).connect(track.destination);
    source.start(start);
    source.stop(end);
  }

  for (const [bar, melody] of MELODY.entries()) {
    const start = bar * BEATS_PER_BAR;
    let position = start;
    for (const entry of melody) {
      const [pitch, beats] = Array.isArray(entry) ? entry : [entry, 1];
      note(pitch, position, beats, position % 2 === 0 ? 0.9 : 0.76);
      position += beats;
    }
    // A quiet root–fifth vamp underneath the same melody on both instruments.
    note(BASS[bar] - 12, start, 0.7, 0.22);
    note((BASS[bar] + 7) % 12 - 12, start + 2, 0.55, 0.18);
  }
  return track.startRendering();
}

export class MapAudio {
  enabled = false;
  pops = new Set();

  async setEnabled(enabled) {
    this.enabled = enabled;
    if (!enabled) {
      this.silence();
      return;
    }
    try {
      if (!this.context) {
        this.context = new AudioContext();
        this.master = this.context.createGain();
        const compressor = this.context.createDynamicsCompressor();
        compressor.threshold.value = -18;
        compressor.ratio.value = 12;
        this.master.connect(compressor).connect(this.context.destination);
        this.mix = INSTRUMENTS.map(() => {
          const gain = this.context.createGain();
          gain.gain.value = 0;
          gain.connect(this.master);
          return gain;
        });
      }
      await this.context.resume();
      this.updateHover();
    } catch (error) {
      this.enabled = false;
      this.silence();
      throw error;
    }
  }

  loadMusic() {
    this.musicPromise ??= Promise.all(INSTRUMENTS.map(instrument => renderVamp(this.context, instrument)))
      .then(buffers => {
        this.buffers = buffers;
        this.updateHover();
      }).catch(error => {
        this.musicPromise = null;
        throw error;
      });
    return this.musicPromise;
  }

  hover(blend) {
    if (this.blend?.heat === blend?.heat) return;
    this.blend = blend;
    this.updateHover();
  }

  updateHover() {
    clearTimeout(this.leaveTimer);
    if (!this.enabled || !this.buffers || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    const gains = this.blend ? [this.blend.guitar, this.blend.trumpet] : [0, 0];
    this.mix.forEach(({ gain }, index) => gain.setTargetAtTime(gains[index], now, 0.025));
    if (!this.blend) {
      this.leaveTimer = setTimeout(() => this.stopMusic(), 180);
      return;
    }
    this.master.gain.setTargetAtTime(LEVEL, now, 0.02);
    if (this.loops) return;
    const start = now + 0.015;
    this.loops = this.buffers.map((buffer, index) => {
      const source = this.context.createBufferSource();
      source.buffer = buffer;
      source.loop = true;
      source.connect(this.mix[index]);
      source.onended = () => source.disconnect();
      source.start(start);
      return source;
    });
  }

  pop(count) {
    if (!this.enabled || !count) return;
    const now = this.context.currentTime;
    this.master.gain.setTargetAtTime(LEVEL, now, 0.02);
    // Each new spot gets a voice; dense batches retain comfortable loudness.
    const level = 0.16 / Math.sqrt(count + this.pops.size);
    for (let index = 0; index < count; index++) {
      const source = this.context.createOscillator();
      const envelope = this.context.createGain();
      source.type = 'triangle';
      source.frequency.setValueAtTime(520 + (index % 7) * 23, now);
      source.frequency.exponentialRampToValueAtTime(130, now + 0.075);
      source.frequency.exponentialRampToValueAtTime(75, now + 1.5);
      envelope.gain.setValueAtTime(0, now);
      envelope.gain.linearRampToValueAtTime(level, now + 0.004);
      envelope.gain.exponentialRampToValueAtTime(level * 0.3, now + 0.1);
      envelope.gain.exponentialRampToValueAtTime(0.0001, now + 1.49);
      envelope.gain.linearRampToValueAtTime(0, now + 1.5);
      source.connect(envelope).connect(this.master);
      this.pops.add(source);
      source.onended = () => {
        source.disconnect();
        envelope.disconnect();
        this.pops.delete(source);
      };
      source.start(now);
      source.stop(now + 1.5);
    }
  }

  stopMusic(when = 0) {
    for (const source of this.loops ?? []) source.stop(when);
    this.loops = null;
  }

  silence() {
    clearTimeout(this.leaveTimer);
    if (!this.master) return;
    const now = this.context.currentTime;
    const stop = now + 0.04;
    this.master.gain.setTargetAtTime(0, now, 0.01);
    this.stopMusic(stop);
    for (const source of this.pops) source.stop(stop);
  }
}

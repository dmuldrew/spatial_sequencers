import { createVampScale, renderVamp, TENSION_PRESETS } from '../domain/folk-vamp.js';

const LEVEL = 0.5;

async function loadGuitar(context) {
  const response = await fetch(new URL('../../audio/guitar.wav', import.meta.url));
  if (!response.ok) throw new Error('Could not load guitar sample');
  const sample = await context.decodeAudioData(await response.arrayBuffer());
  return { pcm: sample.getChannelData(0), sampleRate: sample.sampleRate };
}

function loadD3Audio() {
  if (globalThis.d3Audio?.scaleTension) return Promise.resolve(globalThis.d3Audio);
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = new URL('../../../vendor/d3-audio.js', import.meta.url);
    script.onload = () => {
      if (globalThis.d3Audio?.scaleTension) resolve(globalThis.d3Audio);
      else reject(new Error('d3-audio did not provide scaleTension'));
    };
    script.onerror = () => {
      script.remove();
      reject(new Error('Could not load d3-audio'));
    };
    document.head.append(script);
  });
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
        this.mix = TENSION_PRESETS.map(() => {
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
    this.musicPromise ??= Promise.all([loadGuitar(this.context), loadD3Audio()])
      .then(([guitar, d3Audio]) => {
        const sampleRate = this.context.sampleRate;
        this.tension = createVampScale(d3Audio);
        const states = TENSION_PRESETS.map(heat => this.tension(heat));
        this.tiers = states.map(state => state.tier);
        this.buffers = states.map(state => {
          const pcm = renderVamp(guitar, sampleRate, state, d3Audio);
          const buffer = this.context.createBuffer(1, pcm.length, sampleRate);
          buffer.copyToChannel(pcm, 0);
          return buffer;
        });
        this.updateHover();
      }).catch(error => {
        this.musicPromise = null;
        throw error;
      });
    return this.musicPromise;
  }

  hover(heat) {
    if (this.heat === heat) return;
    this.heat = heat;
    this.updateHover();
  }

  updateHover() {
    clearTimeout(this.leaveTimer);
    if (!this.enabled || !this.buffers || this.context.state !== 'running') return;
    const now = this.context.currentTime;
    const hovering = Number.isFinite(this.heat);
    const tier = hovering ? this.tension(this.heat).tier : null;
    this.mix.forEach(({ gain }, index) => {
      gain.setTargetAtTime(this.tiers[index] === tier ? 1 : 0, now, 0.025);
    });
    if (!hovering) {
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

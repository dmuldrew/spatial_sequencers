// Universal Audio Activation Helper adapted for PyroSync & d3-audio
(function () {
  const isIOS =
    typeof navigator !== 'undefined' &&
    (/iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

  function playSilentAudioTag() {
    try {
      const audio = document.createElement('audio');
      audio.setAttribute('playsinline', '');
      audio.setAttribute('webkit-playsinline', '');
      audio.src = 'data:audio/wav;base64,UklGRigAAABXQVZFZm10IBIAAAABAAEARKwAAIhYAQACABAAAABkYXRhAgAAAAEA';
      audio.volume = 0.01;
      const p = audio.play();
      if (p && typeof p.then === 'function') {
        p.then(() => {
          setTimeout(() => {
            audio.pause();
            audio.remove();
          }, 80);
        }).catch(() => {});
      }
    } catch {
      // Ignore autoplay restriction errors
    }
  }

  function unlockRawContext(ctx) {
    if (!ctx) return;
    try {
      if (ctx.state === 'suspended' && typeof ctx.resume === 'function') {
        ctx.resume();
      }
      if (typeof ctx.createBuffer === 'function') {
        const buffer = ctx.createBuffer(1, 1, 22050);
        const source = ctx.createBufferSource();
        source.buffer = buffer;
        source.connect(ctx.destination);
        source.start(0);
      }
    } catch {
      // Ignore context unlock errors
    }
  }

  function updateButtons(isActive) {
    if (!isActive) return;
    document.querySelectorAll('#btn-audio-activate').forEach((btn) => {
      btn.textContent = '✓ Audio Active';
      btn.classList.add('is-active');
      btn.setAttribute('aria-pressed', 'true');
    });
  }

  async function activateAudio() {
    playSilentAudioTag();

    const rawCtx =
      (window.Tone && window.Tone.context && window.Tone.context.rawContext) ||
      (window.d3Audio && window.d3Audio.defaultEngine && window.d3Audio.defaultEngine.getAudioContext());
    unlockRawContext(rawCtx);

    try {
      if (window.Tone && typeof window.Tone.start === 'function') {
        await window.Tone.start();
      }
      if (window.Tone && window.Tone.context && window.Tone.context.state !== 'running') {
        await window.Tone.context.resume();
      }
      if (window.Tone && window.Tone.context && isIOS && window.Tone.context.lookAhead < 0.06) {
        window.Tone.context.lookAhead = 0.08;
      }
      if (window.d3Audio && window.d3Audio.defaultEngine) {
        await window.d3Audio.defaultEngine.start();
      }
      updateButtons(true);
    } catch (err) {
      console.warn('Audio activation notice:', err);
    }
  }

  function init() {
    const btn = document.getElementById('btn-audio-activate');
    if (btn) {
      btn.addEventListener('click', activateAudio);
    }

    const onFirstGesture = () => {
      if (window.Tone && window.Tone.context && window.Tone.context.state === 'running') {
        updateButtons(true);
        return;
      }
      playSilentAudioTag();
      if (window.d3Audio && window.d3Audio.defaultEngine) {
        window.d3Audio.defaultEngine.start().then(() => updateButtons(true)).catch(() => {});
      }
    };

    ['pointerdown', 'keydown'].forEach((ev) => {
      document.addEventListener(ev, onFirstGesture, { once: true, passive: true });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

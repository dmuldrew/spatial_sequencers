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

  // ---------------------------------------------------------------------------
  // Keep Web Audio alive alongside speech. On iOS (and some Android browsers) speaking
  // with speechSynthesis can interrupt or suspend the page's AudioContext, and it stays
  // silent unless the page resumes it; the ringer switch can also mute Web Audio unless
  // the page declares itself a media player.
  // ---------------------------------------------------------------------------
  let activated = false;
  let keepAliveStarted = false;
  let speechPrimed = false;

  function getRawContext() {
    return (window.Tone && window.Tone.context && window.Tone.context.rawContext) ||
      (window.d3Audio && window.d3Audio.defaultEngine && window.d3Audio.defaultEngine.getAudioContext &&
        window.d3Audio.defaultEngine.getAudioContext()) || null;
  }

  // Safari 17+ Audio Session API: 'playback' plays through the ringer switch and is
  // treated as media rather than ambient sound.
  function setPlaybackSession() {
    try {
      if (navigator.audioSession && navigator.audioSession.type !== 'playback') {
        navigator.audioSession.type = 'playback';
      }
    } catch {
      // Not supported
    }
  }

  // iOS only lets speech start from a user gesture once; speak a silent utterance
  // inside the Enable Audio tap so later narration lines are allowed.
  function primeSpeech() {
    if (speechPrimed || !('speechSynthesis' in window)) return;
    speechPrimed = true;
    try {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      window.speechSynthesis.speak(u);
    } catch {
      // Ignore
    }
  }

  // Resume the AudioContext if speech (or the OS) interrupted or suspended it.
  function resumeContext() {
    if (!activated) return;
    const ctx = getRawContext();
    if (!ctx || ctx.state === 'running' || ctx.state === 'closed') return;
    try {
      const p = ctx.resume();
      if (p && typeof p.catch === 'function') p.catch(() => {});
    } catch {
      // Retried by the keep-alive timer
    }
  }

  function startKeepAlive() {
    if (keepAliveStarted) return;
    keepAliveStarted = true;
    const ctx = getRawContext();
    if (ctx && typeof ctx.addEventListener === 'function') {
      ctx.addEventListener('statechange', () => {
        if (ctx.state !== 'running') resumeContext();
      });
    }
    setInterval(resumeContext, 1000);
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) resumeContext();
    });
    window.addEventListener('pageshow', resumeContext);
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
    setPlaybackSession();
    primeSpeech();
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
      activated = true;
      startKeepAlive();
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

  // app.js calls PyroAudioUnlock.enableAudio(); the flyby narrator calls resumeContext()
  // around each spoken line.
  window.PyroAudioUnlock = { enableAudio: activateAudio, resumeContext, primeSpeech };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();

import { MINUTES_PER_SECOND, timeAt } from '../domain/fire-timeline.js';

const format = new Intl.DateTimeFormat('en-US', {
  month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
  hourCycle: 'h23', timeZone: 'UTC',
});

export class TimelinePlayer {
  constructor({ slider, replay, clock, onSeek, onPlay }) {
    this.slider = slider;
    this.replayButton = replay;
    this.clock = clock;
    this.onSeek = onSeek;
    this.onPlay = onPlay;
    this.frame = null;
    slider.addEventListener('input', () => {
      this.pause();
      this.seek(Number(slider.value));
    });
    replay.addEventListener('click', () => this.replay());
  }

  install(timeline) {
    const sameWindow = this.timeline?.startTime === timeline.startTime
      && this.timeline.lastMinute === timeline.lastMinute;
    this.timeline = timeline;
    if (!sameWindow) {
      this.pause();
      this.slider.max = timeline.lastMinute;
    }
    this.slider.disabled = this.replayButton.disabled = false;
    this.seek(sameWindow ? this.minute : timeline.lastMinute);
  }

  clear() {
    this.pause();
    this.timeline = null;
    this.slider.disabled = this.replayButton.disabled = true;
    this.slider.max = this.slider.value = 0;
    this.slider.removeAttribute('aria-valuetext');
    this.clock.removeAttribute('datetime');
    this.clock.textContent = '';
  }

  seek(minute, playback = false, previousMinute = this.minute) {
    if (!this.timeline) return;
    this.minute = Math.max(0, Math.min(this.timeline.lastMinute, minute));
    const time = timeAt(this.timeline, this.minute);
    const text = `${format.format(time)} UTC`;
    this.slider.value = this.minute;
    this.slider.setAttribute('aria-valuetext', text);
    this.clock.dateTime = time.toISOString();
    this.clock.textContent = text;
    this.onSeek({ playback, previousMinute });
  }

  replay() {
    if (this.replayButton.disabled || !this.timeline) return;
    this.pause();
    this.onPlay();
    this.seek(0, true, -1);
    const start = performance.now();
    const step = now => {
      const minute = Math.min(this.timeline.lastMinute,
        Math.floor((now - start) * MINUTES_PER_SECOND / 1000));
      if (minute !== this.minute) this.seek(minute, true);
      if (minute < this.timeline.lastMinute) this.frame = requestAnimationFrame(step);
      else this.pause();
    };
    this.frame = requestAnimationFrame(step);
  }

  pause() {
    if (this.frame !== null) cancelAnimationFrame(this.frame);
    this.frame = null;
  }
}

const SLOW_DOWNLOAD_SECONDS = 10;
const LARGE_DOWNLOAD_BYTES = 200_000_000;
export const SMALL_DOWNLOAD_BYTES = 1_000_000;

export class DownloadGate {
  constructor(totalBytes, onPrompt, { rate = 250_000, threshold = SLOW_DOWNLOAD_SECONDS } = {}) {
    this.totalBytes = totalBytes;
    this.rate = rate;
    this.threshold = threshold;
    this.onPrompt = onPrompt;
    this.start = performance.now();
    this.completedBytes = 0;
    this.controller = new AbortController();
    this.signal = this.controller.signal;
    this.timer = setTimeout(() => this.prompt(), threshold * 1000);
    this.checkEstimate();
  }

  get elapsed() {
    return (performance.now() - this.start) / 1000;
  }

  checkEstimate() {
    const rate = this.completedBytes > 0 && this.elapsed >= 0.25
      ? this.completedBytes / this.elapsed : this.rate;
    const estimated = this.elapsed + (this.totalBytes - this.completedBytes) / rate;
    if (this.totalBytes > LARGE_DOWNLOAD_BYTES || estimated > this.threshold) this.prompted = true;
    this.report();
  }

  prompt() {
    if (this.prompted) return;
    this.prompted = true;
    this.report();
  }

  report() {
    if (this.prompted && !this.dismissed && !this.signal.aborted) {
      this.onPrompt({ total: this.totalBytes, completed: this.completedBytes });
    }
  }

  beforeBlock(bytes) {
    this.signal.throwIfAborted();
    if (bytes > SMALL_DOWNLOAD_BYTES) this.prompt();
  }

  addEstimate(bytes) {
    this.totalBytes += bytes;
    this.checkEstimate();
  }

  completed(bytes) {
    this.completedBytes += bytes;
    this.checkEstimate();
  }

  beforeCommit() {
    this.finish();
    this.signal.throwIfAborted();
  }

  dismiss() {
    this.dismissed = true;
    this.finish();
  }

  cancel() {
    this.controller.abort();
    this.finish();
  }

  finish() {
    clearTimeout(this.timer);
  }
}

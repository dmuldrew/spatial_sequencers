export const APPROVAL_SECONDS = 10;
export const APPROVAL_BYTES = 200_000_000;
// While approval is pending, finish small blocks within this allowance.
export const PREVIEW_BYTES = 1_000_000;

export class DownloadGate {
  constructor(totalBytes, onPrompt, { rate = 250_000, threshold = APPROVAL_SECONDS } = {}) {
    this.totalBytes = totalBytes;
    this.rate = rate;
    this.threshold = threshold;
    this.onPrompt = onPrompt;
    this.start = performance.now();
    this.completedBytes = 0;
    this.previewBytes = 0;
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
    if (this.totalBytes > APPROVAL_BYTES || estimated > this.threshold) this.prompt();
  }

  prompt() {
    if (this.signal.aborted || this.decision) return;
    this.decision = new Promise(resolve => { this.resolveDecision = resolve; });
    this.report();
  }

  report() {
    if (this.decision && !this.approved && !this.signal.aborted) {
      this.onPrompt({ total: this.totalBytes, completed: this.completedBytes, paused: !!this.paused, ready: !!this.ready });
    }
  }

  async beforeBlock(bytes) {
    this.signal.throwIfAborted();
    if (bytes > PREVIEW_BYTES) this.prompt();
    if (this.decision && !this.approved) {
      if (this.previewBytes + bytes > PREVIEW_BYTES) {
        this.paused = true;
        this.report();
        await this.decision;
      } else {
        this.previewBytes += bytes;
      }
    }
    this.signal.throwIfAborted();
  }

  addEstimate(bytes) {
    this.totalBytes += bytes;
    this.checkEstimate();
    this.report();
  }

  completed(bytes) {
    this.completedBytes += bytes;
    this.checkEstimate();
    this.report();
  }

  async beforeCommit() {
    this.finish();
    if (this.decision && !this.approved) {
      this.ready = true;
      this.report();
      await this.decision;
    }
    this.signal.throwIfAborted();
  }

  allow() {
    this.approved = true;
    this.resolveDecision?.();
  }

  cancel() {
    this.controller.abort();
    this.resolveDecision?.();
    this.finish();
  }

  finish() {
    clearTimeout(this.timer);
  }
}

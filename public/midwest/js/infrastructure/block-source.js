import { validateDataset } from './data-source.js';
import { BlockCache, blocksInView, cacheWindow } from './block-cache.js';
import { DownloadGate, PREVIEW_BYTES } from './download-gate.js';
import { enableDynamicBlocks, fetchRemoteBlock, planRemoteBlock } from './dynamic-blocks.js';

const MANIFEST = new URL('../../data/manifest.json', import.meta.url);

async function readJSON(response, limit) {
  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || `Map data request failed (HTTP ${response.status}).`);
  }
  if (!response.body) throw new Error('There is no map data in the response.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > limit) throw new Error('Map data exceeded its advertised size.');
      text += decoder.decode(value, { stream: true });
    }
    return JSON.parse(text + decoder.decode());
  } finally {
    await reader.cancel().catch(() => {});
  }
}

function validBounds(bounds) {
  return bounds && ['west', 'south', 'east', 'north'].every(key => Number.isFinite(bounds[key]))
    && bounds.west < bounds.east && bounds.south < bounds.north;
}

export async function loadManifest(signal) {
  const response = await fetch(MANIFEST, { signal, cache: 'no-cache' });
  const manifest = await readJSON(response, PREVIEW_BYTES);
  validateDataset({ ...manifest, cells: [] });
  if (manifest.blockSchema !== 1 || !manifest.cacheKey || !validBounds(manifest.coverage)
    || !manifest.blocks || !Object.keys(manifest.blocks).length) {
    throw new Error('Invalid map block manifest.');
  }
  for (const key of ['A1', 'A2']) {
    const breaks = manifest.colorBreaks?.[key];
    if (!Array.isArray(breaks) || breaks.length !== 2 || !breaks.every(Number.isFinite)
      || breaks[0] > breaks[1]) throw new Error('Invalid map color breaks.');
  }
  for (const tile of Object.values(manifest.blocks)) {
    if (!validBounds(tile.bounds) || !Number.isSafeInteger(tile.bytes) || tile.bytes <= 0
      || typeof tile.url !== 'string') throw new Error('Invalid map block entry.');
    const url = new URL(tile.url, MANIFEST);
    if (url.origin !== MANIFEST.origin || !url.pathname.startsWith(new URL('./blocks/', MANIFEST).pathname)) {
      throw new Error('Invalid map block URL.');
    }
  }
  return enableDynamicBlocks(manifest, signal);
}

export class BlockSource {
  constructor(manifest, status, prompt) {
    this.manifest = manifest;
    this.cache = new BlockCache(manifest);
    this.status = status;
    this.prompt = prompt;
  }

  restore() {
    return this.cache.restore();
  }

  cancel() {
    this.active?.cancel();
  }

  allow() {
    this.active?.allow();
    this.prompt(null);
  }

  stop() {
    this.prefetching?.abort();
    this.active?.cancel();
    this.active = null;
    this.requestKey = null;
    this.prompt(null);
  }

  async fetchBlock(id, signal, sourceBytes = 0) {
    const entry = this.manifest.blocks[id];
    const response = entry.dynamic
      ? await fetchRemoteBlock(id, sourceBytes, signal)
      : await fetch(new URL(entry.url, MANIFEST), { signal, cache: 'no-store' });
    const block = await readJSON(response, entry.bytes);
    if (block.id !== id) throw new Error('The map block does not match the requested area.');
    return validateDataset({ ...this.manifest, cells: block.cells }).cells;
  }

  async prefetch(ids, targets) {
    if (!ids.length) return;
    const controller = new AbortController();
    this.prefetching = controller;
    const { signal } = controller;
    let remaining = PREVIEW_BYTES;
    for (const id of ids.slice(0, 2)) {
      try {
        const cost = this.manifest.blocks[id].dynamic ? await planRemoteBlock(id, signal) : 0;
        if (cost > remaining) continue;
        remaining -= cost;
        const cells = await this.fetchBlock(id, signal, cost);
        signal.throwIfAborted();
        await this.cache.replace(targets, new Map([[id, cells]]), true);
      } catch {
        if (signal.aborted) break;
      }
    }
  }

  async update(bounds, retry = false) {
    const required = blocksInView(this.manifest.blocks, bounds);
    const key = required.join(',');
    if (key === this.requestKey && !retry) return;
    this.stop();
    this.requestKey = key;
    if ((this.cache.blocks.size === 9 || this.manifest.cacheKey.endsWith('-dynamic-v1'))
      && required.every(id => this.cache.blocks.has(id))) {
      this.status('', false);
      return;
    }
    const target = cacheWindow(this.manifest.blocks, required, this.cache.blocks, bounds);
    if (!target) {
      this.status('Zoom in to fit the nine-block cache.', false);
      return;
    }
    const visible = required.filter(id => !this.cache.blocks.has(id));
    const neighbors = target.filter(id => !required.includes(id) && !this.cache.blocks.has(id));
    const staged = [...visible, ...neighbors].some(id => this.manifest.blocks[id].dynamic);
    const missing = staged ? visible : [...visible, ...neighbors];
    const bytes = missing.reduce((sum, id) => sum + (this.manifest.blocks[id].dynamic ? 150_000 : this.manifest.blocks[id].bytes), 0);
    const gate = new DownloadGate(bytes, details => this.prompt(details));
    this.active = gate;
    this.status(`Loading ${missing.length} map block${missing.length === 1 ? '' : 's'}…`, false, true);
    try {
      const downloaded = new Map();
      for (const id of missing) {
        const entry = this.manifest.blocks[id];
        const delivery = entry.dynamic ? 150_000 : entry.bytes;
        const rawBytes = entry.dynamic ? await planRemoteBlock(id, gate.signal) : 0;
        if (rawBytes) gate.addEstimate(rawBytes);
        await gate.beforeBlock(delivery + rawBytes);
        downloaded.set(id, await this.fetchBlock(id, gate.signal, rawBytes));
        gate.completed(delivery + rawBytes);
      }
      await gate.beforeCommit();
      await this.cache.replace(target, downloaded, staged);
      if (this.active === gate) {
        this.status('', false);
        if (staged) void this.prefetch(neighbors, target);
      }
    } catch (error) {
      if (this.active === gate) {
        this.status(gate.signal.aborted ? 'Download canceled.' : error.message, true);
      }
    } finally {
      gate.finish();
      if (this.active === gate) {
        this.active = null;
        this.prompt(null);
      }
    }
  }
}

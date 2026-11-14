import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

import { areaBounds } from '../public/midwest/js/domain/study-area.js';
import { blocksInView, cacheWindow } from '../public/midwest/js/infrastructure/block-cache.js';
import { BlockSource } from '../public/midwest/js/infrastructure/block-source.js';
import { DownloadGate, PREVIEW_BYTES } from '../public/midwest/js/infrastructure/download-gate.js';

const dataFolder = new URL('../public/midwest/data/', import.meta.url);
const manifest = JSON.parse(readFileSync(new URL('manifest.json', dataFolder)));
const home = areaBounds();
const east = { ...home, west: -92.4, east: -89.2 };
const homeBlocks = blocksInView(manifest.blocks, home);
const eastBlocks = blocksInView(manifest.blocks, east);

globalThis.h3 = vm.runInNewContext(
  readFileSync(new URL('../public/midwest/vendor/h3.js', import.meta.url), 'utf8') + ';h3',
  {},
);

test('manifest files match byte estimates and retain matching values across boundaries', () => {
  const seen = new Map();
  assert.equal(Object.keys(manifest.blocks).length, 25);
  for (const [id, entry] of Object.entries(manifest.blocks)) {
    const bytes = readFileSync(new URL(entry.url, dataFolder));
    assert.equal(bytes.length, entry.bytes);
    const block = JSON.parse(bytes);
    assert.equal(block.id, id);
    assert.ok(block.cells.some(cell => cell.A1 !== null && cell.A2 !== null));
    for (const cell of block.cells) {
      if (seen.has(cell.id)) assert.deepEqual(seen.get(cell.id), cell);
      seen.set(cell.id, cell);
    }
  }
});

test('a full viewport fits in a 3 by 3 window anywhere in the archive', () => {
  assert.equal(homeBlocks.length, 9);
  const width = home.east - home.west;
  const mercatorY = value => Math.asinh(Math.tan(value * Math.PI / 180));
  const latitudeAt = value => Math.atan(Math.sinh(value)) * 180 / Math.PI;
  const bottom = mercatorY(manifest.coverage.south);
  const top = mercatorY(manifest.coverage.north);
  const height = mercatorY(home.north) - mercatorY(home.south);
  for (let i = 0; i <= 10; i += 1) {
    for (let j = 0; j <= 10; j += 1) {
      const west = manifest.coverage.west
        + (manifest.coverage.east - manifest.coverage.west - width) * i / 10;
      const y = bottom + (top - bottom - height) * j / 10;
      const bounds = { west, east: west + width, south: latitudeAt(y), north: latitudeAt(y + height) };
      const required = blocksInView(manifest.blocks, bounds);
      assert.ok(required.length <= 9);
      assert.equal(cacheWindow(manifest.blocks, required, new Map(), bounds)?.length, 9);
    }
  }
});

test('moving east reuses six blocks and imports only three', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async url => {
    calls.push(url.pathname);
    return new Response(readFileSync(new URL(url.pathname.split('/data/').at(-1), dataFolder)));
  });
  const source = new BlockSource(manifest, () => {}, () => {});
  await source.update(home);
  assert.equal(calls.length, 9);
  await source.update(east);
  assert.equal(calls.length, 12);
  assert.equal(source.cache.blocks.size, 9);
  assert.equal(homeBlocks.filter(id => source.cache.blocks.has(id)).length, 6);
  assert.ok(eastBlocks.every(id => source.cache.blocks.has(id)));
  await source.update(east);
  assert.equal(calls.length, 12);
});

test('cancel aborts a pending block, preserves the old cache, and permits retry', async t => {
  let hold = false;
  const states = [];
  let started;
  const pending = new Promise(resolve => { started = resolve; });
  t.mock.method(globalThis, 'fetch', async (url, { signal }) => {
    if (hold) {
      started();
      return new Promise((_, reject) => {
        signal.addEventListener('abort', () => reject(signal.reason), { once: true });
      });
    }
    return new Response(readFileSync(new URL(url.pathname.split('/data/').at(-1), dataFolder)));
  });
  const source = new BlockSource(manifest, (...args) => states.push(args), () => {});
  await source.update(home);
  hold = true;
  const move = source.update(east);
  await pending;
  source.cancel();
  await move;
  assert.deepEqual(states.at(-1), ['Download canceled.', true]);
  assert.ok(homeBlocks.every(id => source.cache.blocks.has(id)));
  hold = false;
  await source.update(east, true);
  assert.ok(eastBlocks.every(id => source.cache.blocks.has(id)));
});

test('projected or elapsed slow loads prompt, allow a preview, and wait for approval', async () => {
  const prompts = [];
  const gate = new DownloadGate(10_000_000, details => prompts.push(details));
  assert.equal(prompts.length, 1);
  await gate.beforeBlock(PREVIEW_BYTES);
  gate.completed(PREVIEW_BYTES);
  const next = gate.beforeBlock(1);
  assert.equal(prompts.at(-1).paused, true);
  gate.allow();
  await next;
  await gate.beforeCommit();

  const timed = new DownloadGate(100, details => prompts.push(details), { threshold: 0.02 });
  await new Promise(resolve => setTimeout(resolve, 35));
  assert.ok(timed.decision);
  const finish = timed.beforeCommit();
  assert.equal(prompts.at(-1).ready, true);
  timed.cancel();
  await assert.rejects(finish, { name: 'AbortError' });
});

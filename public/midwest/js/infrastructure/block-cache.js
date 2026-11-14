import { coordinates } from './dynamic-blocks.js';

const MAX_BLOCKS = 9;
const STORE = 'blocks';

function archiveDatabase() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open('earth-atlas-roaming', 1);
    request.onupgradeneeded = () => request.result.createObjectStore(STORE);
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function transaction(database, mode, action) {
  return new Promise((resolve, reject) => {
    const tx = database.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request?.result);
    tx.onabort = tx.onerror = () => reject(tx.error);
  });
}

export function blocksInView(blocks, bounds) {
  // Ignore numerical noise on shared edges. A full view spans two block
  // widths, so even a view that straddles edges intersects at most nine.
  const epsilon = 1e-7;
  return Object.keys(blocks).filter(id => {
    const block = blocks[id].bounds;
    return block.west < bounds.east - epsilon && block.east > bounds.west + epsilon
      && block.south < bounds.north - epsilon && block.north > bounds.south + epsilon;
  });
}

export function cacheWindow(blocks, required, cached, bounds) {
  const longitude = (bounds.west + bounds.east) / 2;
  const latitude = (bounds.south + bounds.north) / 2;
  const candidates = [];
  for (const start of Object.keys(blocks)) {
    const [column, row] = coordinates(start);
    const ids = [];
    for (let y = row; y < row + 3; y += 1) {
      for (let x = column; x < column + 3; x += 1) ids.push(`${x}-${y}`);
    }
    if (!ids.every(id => Object.hasOwn(blocks, id)) || !required.every(id => ids.includes(id))) {
      continue;
    }
    const center = blocks[ids[4]].bounds;
    const distance = ((center.west + center.east) / 2 - longitude) ** 2
      * Math.cos(latitude * Math.PI / 180) ** 2
      + ((center.south + center.north) / 2 - latitude) ** 2;
    const reuse = ids.filter(id => cached.has(id)).length;
    candidates.push({ ids, distance, reuse });
  }
  candidates.sort((a, b) => b.reuse - a.reuse || a.distance - b.distance);
  return candidates[0]?.ids ?? null;
}

export class BlockCache {
  constructor(manifest) {
    this.manifest = manifest;
    this.blocks = new Map();
  }

  async restore() {
    try {
      this.database = await archiveDatabase();
      const saved = await transaction(this.database, 'readonly', store => store.getAll());
      for (const entry of saved) {
        if (entry.key === this.manifest.cacheKey && Object.hasOwn(this.manifest.blocks, entry.id)
          && Array.isArray(entry.cells) && this.blocks.size < MAX_BLOCKS) {
          this.blocks.set(entry.id, entry.cells);
        }
      }
    } catch {
      this.database = null;
    }
  }

  async replace(ids, downloaded, allowPartial = false) {
    const available = new Map([...this.blocks, ...downloaded]);
    if (ids.length !== MAX_BLOCKS || (!allowPartial && !ids.every(id => available.has(id)))) {
      throw new Error('The nine-block cache is incomplete.');
    }
    const next = new Map(ids.filter(id => available.has(id)).map(id => [id, available.get(id)]));
    this.blocks = next;
    if (!this.database) return;

    // Save the additions and evictions in one transaction. Keep the in-memory
    // cache usable when storage is disabled, full, or cleared by the browser.
    try {
      await transaction(this.database, 'readwrite', store => {
        const request = store.getAll();
        request.onsuccess = () => {
          const current = new Map(request.result.map(entry => [entry.id, entry]));
          for (const id of current.keys()) {
            if (!next.has(id)) store.delete(id);
          }
          for (const [id, cells] of next) {
            if (downloaded.has(id) || current.get(id)?.key !== this.manifest.cacheKey) {
              store.put({ key: this.manifest.cacheKey, id, cells }, id);
            }
          }
        };
      });
    } catch {
      this.database = null;
    }
  }

  cells() {
    const merged = new Map();
    const entries = [...this.blocks.entries()].sort(([a], [b]) =>
      Number(this.manifest.blocks[b].dynamic || false) - Number(this.manifest.blocks[a].dynamic || false)
      || a.localeCompare(b));
    for (const [, cells] of entries) {
      for (const cell of cells) merged.set(cell.id, cell);
    }
    return merged;
  }
}

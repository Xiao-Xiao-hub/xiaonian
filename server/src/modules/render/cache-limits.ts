// Age-based pruning retains at least a day. Capacity eviction is strict LRU:
// recent images may be evicted under pressure so new formulas still render.
export const FORMULA_CACHE_GRACE_MS = 24 * 60 * 60 * 1000;
export const FORMULA_CACHE_FILES = 20_000;
export const FORMULA_CACHE_BYTES = 512 * 1024 * 1024;

import { CoreStore } from './core-store.mjs';

/**
 * DEV repository boundary. Future Core/API code depends on this factory,
 * never on the physical SQLite file or on tables directly.
 */
export function createDevRepository(dbPath) {
  return new CoreStore(dbPath);
}

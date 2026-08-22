import { config } from '../config.js';
import { IIdentityStore } from './types.js';
import { MemoryIdentityStore } from './memoryIdentityStore.js';

export * from './types.js';
export { MemoryIdentityStore } from './memoryIdentityStore.js';

/**
 * Build the persistent identity store for the current environment.
 *
 * - test  → in-memory (hermetic; never touches disk, never loads the native driver)
 * - dev / production → SQLite (`better-sqlite3`), imported lazily here so the native
 *   addon is only loaded when actually needed.
 *
 * Mirrors how `buildApp` selects the ephemeral session store.
 */
export async function createIdentityStore(): Promise<IIdentityStore> {
  if (config.NODE_ENV === 'test') {
    const store = new MemoryIdentityStore();
    await store.init();
    return store;
  }

  const { SqliteIdentityStore } = await import('./sqliteIdentityStore.js');
  const store = new SqliteIdentityStore(config.IDENTITY_DB_PATH);
  await store.init();
  return store;
}

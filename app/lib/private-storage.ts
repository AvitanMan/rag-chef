type StorageReads = { forWrite: (key: string) => string | null; discardPending: (key: string) => string | null };
const storageReads = new WeakMap<object, StorageReads>();

/** Compare against another tab's changes without discarding this tab's draft. */
export function readStorageForWrite(storage: Pick<Storage, "getItem">, key: string): string | null {
  const reads = storageReads.get(storage);
  return reads ? reads.forWrite(key) : storage.getItem(key);
}

/** An explicit choice of saved progress also discards any memory-only copy. */
export function discardPendingStorageItem(storage: Pick<Storage, "getItem">, key: string): string | null {
  const reads = storageReads.get(storage);
  return reads ? reads.discardPending(key) : storage.getItem(key);
}

/** A Storage facade whose enumeration, reads and writes stay inside one account. */
export function scopedStorage(source: () => Storage, prefix = "", active: () => boolean = () => true): Storage {
  const keys = () => {
    if (!active()) return [];
    const storage = source();
    return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null && key.startsWith(prefix));
  };
  const storage: Storage = {
    get length() { return keys().length; },
    key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem(key) { return active() ? source().getItem(prefix + key) : null; },
    setItem(key, value) { if (active()) source().setItem(prefix + key, value); },
    removeItem(key) { if (active()) source().removeItem(prefix + key); },
    clear() { for (const key of keys()) source().removeItem(key); },
  };
  storageReads.set(storage, {
    forWrite: key => active() ? readStorageForWrite(source(), prefix + key) : null,
    discardPending: key => active() ? discardPendingStorageItem(source(), prefix + key) : null,
  });
  return storage;
}

export function accountStoragePrefix(userId: string, householdId: string): string {
  return `rag-chef-account:${encodeURIComponent(userId)}:${encodeURIComponent(householdId)}:`;
}

export const SECURE_LOCAL_PREFIX = "rag-chef-secure-local:";

/** Keep the latest draft in this tab even when browser persistence is denied.
 * Writes still throw so callers never describe a memory-only copy as durable. */
export function mirroredStorage(source: () => Storage, memory: Map<string, string>): Storage {
  const pending = new Map<string, string | null | undefined>();
  const beginWrite = (key: string) => {
    if (pending.has(key)) return;
    try { pending.set(key, source().getItem(key)); }
    catch { pending.set(key, undefined); }
  };
  const keys = () => {
    const result = new Set(memory.keys());
    try { const storage = source(); for (let i = 0; i < storage.length; i++) { const key = storage.key(i); if (key !== null) result.add(key); } } catch { /* Memory remains available. */ }
    return [...result];
  };
  const storage: Storage = {
    get length() { return keys().length; },
    key: index => keys()[index] ?? null,
    getItem(key) {
      if (pending.has(key)) return memory.get(key) ?? null;
      try { const value = source().getItem(key); if (value !== null) memory.set(key, value); else memory.delete(key); return value; }
      catch { return memory.get(key) ?? null; }
    },
    setItem(key, value) { beginWrite(key); memory.set(key, value); source().setItem(key, value); pending.delete(key); },
    removeItem(key) { beginWrite(key); memory.delete(key); source().removeItem(key); pending.delete(key); },
    clear() { memory.clear(); pending.clear(); source().clear(); },
  };
  storageReads.set(storage, {
    forWrite(key) {
      if (!pending.has(key)) return storage.getItem(key);
      let saved: string | null;
      try { saved = source().getItem(key); }
      catch { return memory.get(key) ?? null; }
      // A null baseline is safe for a previously unreadable, empty key too.
      return saved === (pending.get(key) ?? null) ? memory.get(key) ?? null : saved;
    },
    discardPending(key) {
      const saved = source().getItem(key);
      pending.delete(key);
      if (saved === null) memory.delete(key); else memory.set(key, saved);
      return saved;
    },
  });
  return storage;
}

export function clearStoragePrefix(storage: Storage, prefix: string): void {
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index));
  for (const key of keys) if (key?.startsWith(prefix)) storage.removeItem(key);
}

/** This is only called after authentication; retain theme and unrelated keys. */
export function migrateSecureLocalStorage(storage: Storage): void {
  if (storage.getItem(`${SECURE_LOCAL_PREFIX}migrated`) === "1") return;
  const keys = Array.from({ length: storage.length }, (_, index) => storage.key(index)).filter((key): key is string => Boolean(key && isLegacyPrivateKey(key)));
  for (const key of keys) {
    const value = storage.getItem(key);
    if (value !== null && storage.getItem(SECURE_LOCAL_PREFIX + key) === null) storage.setItem(SECURE_LOCAL_PREFIX + key, value);
  }
  for (const key of keys) storage.removeItem(key);
  storage.setItem(`${SECURE_LOCAL_PREFIX}migrated`, "1");
}

function isLegacyPrivateKey(key: string): boolean {
  return /^(?:rag-chef-(?:kitchen-v2|cooking-v1|preferences-v2|prototype-v1)(?::|$)|rag-chef-(?:navigation|history|chef)(?::|-))/.test(key);
}

/** Each mounted identity gets a new capability, even when returning to the same account. */
export function browserScope(identity: string) {
  let active = true;
  let controller = new AbortController();
  return {
    identity,
    get signal() { return controller.signal; },
    isActive: () => active,
    activate: () => { active = true; if (controller.signal.aborted) controller = new AbortController(); },
    revoke: () => { active = false; controller.abort(); },
  };
}

export function clearAccountStorage(storage: Storage, userId: string): void {
  const prefix = `rag-chef-account:${encodeURIComponent(userId)}:`;
  const keys = Array.from({ length: storage.length }, (_, i) => storage.key(i));
  for (const key of keys) if (key?.startsWith(prefix)) storage.removeItem(key);
}

export function householdDate(timezone?: string, now = new Date()): string {
  const parts = new Intl.DateTimeFormat("en-CA", { ...(timezone ? { timeZone: timezone } : {}), year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(now);
  return ["year", "month", "day"].map(type => parts.find(part => part.type === type)!.value).join("-");
}

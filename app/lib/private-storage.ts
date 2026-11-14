/** A Storage facade whose enumeration, reads and writes stay inside one account. */
export function scopedStorage(source: () => Storage, prefix = "", active: () => boolean = () => true): Storage {
  const keys = () => {
    if (!active()) return [];
    const storage = source();
    return Array.from({ length: storage.length }, (_, i) => storage.key(i)).filter((key): key is string => key !== null && key.startsWith(prefix));
  };
  return {
    get length() { return keys().length; },
    key(index) { return keys()[index]?.slice(prefix.length) ?? null; },
    getItem(key) { return active() ? source().getItem(prefix + key) : null; },
    setItem(key, value) { if (active()) source().setItem(prefix + key, value); },
    removeItem(key) { if (active()) source().removeItem(prefix + key); },
    clear() { for (const key of keys()) source().removeItem(key); },
  };
}

export function accountStoragePrefix(userId: string, householdId: string): string {
  return `rag-chef-account:${encodeURIComponent(userId)}:${encodeURIComponent(householdId)}:`;
}

/** Each mounted identity gets a new capability, even when returning to the same account. */
export function browserScope(identity: string) {
  let active = true;
  return { identity, isActive: () => active, activate: () => { active = true; }, revoke: () => { active = false; } };
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

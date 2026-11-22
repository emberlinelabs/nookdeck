/**
 * Keys renamed with the Nookdeck rename: [old, new]. The deck's own keys are all `pd.*` and never contained the product name,
 * so nothing is renamed today and a phone paired under PhoneDesk keeps its token as is. Add a pair here if a key is ever renamed.
 */
export const RENAMED_KEYS: Array<[string, string]> = []

export interface KeyStore {
  get(k: string): string | null
  set(k: string, v: string): void
}

/** Copy each old key to its new key when the new one is missing. Old keys are never deleted, so a downgrade still works. Returns the copied new keys. */
export function migrateKeys(store: KeyStore, pairs: Array<[string, string]>): string[] {
  const copied: string[] = []
  for (let i = 0; i < pairs.length; i++) {
    const oldK = pairs[i][0]
    const newK = pairs[i][1]
    if (oldK === newK) continue
    let cur: string | null = null
    let old: string | null = null
    try {
      cur = store.get(newK)
      old = store.get(oldK)
    } catch (e) {
      continue
    }
    if (cur === null && old !== null) {
      try {
        store.set(newK, old)
        copied.push(newK)
      } catch (e) {
        /* private mode or full: skip */
      }
    }
  }
  return copied
}

/** Run once at boot, before anything reads localStorage. */
export function migrateStorage(): string[] {
  if (RENAMED_KEYS.length === 0) return []
  try {
    return migrateKeys({ get: (k) => window.localStorage.getItem(k), set: (k, v) => window.localStorage.setItem(k, v) }, RENAMED_KEYS)
  } catch (e) {
    return []
  }
}

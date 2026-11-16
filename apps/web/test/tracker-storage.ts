import { expect, vi } from 'vitest';

export type StoredIdentity = {
  visitor: { id: string; expires: number };
  visit: {
    id: string;
    last: number;
    visitor_id: string;
    type: string;
    attribution: Record<string, string>;
  };
};

export async function identityRecord(
  scope: string,
  update?: (record: StoredIdentity | undefined) => StoredIdentity | undefined,
): Promise<StoredIdentity | undefined> {
  return new Promise((resolve, reject) => {
    const opening = indexedDB.open('app-health-identity', 1);
    opening.onupgradeneeded = () => opening.result.createObjectStore('scopes');
    opening.onerror = () => reject(opening.error);
    opening.onsuccess = () => {
      const db = opening.result;
      const tx = db.transaction('scopes', update ? 'readwrite' : 'readonly');
      const store = tx.objectStore('scopes');
      const request = store.get(scope);
      let value: StoredIdentity | undefined;
      request.onsuccess = () => {
        value = request.result;
        if (update) {
          value = update(value);
          if (value) store.put(value, scope);
          else store.delete(scope);
        }
      };
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error);
      };
    };
  });
}

export async function committedIdentity(scope: string) {
  let value: StoredIdentity | undefined;
  await vi.waitFor(async () => {
    value = await identityRecord(scope);
    expect(value).toBeDefined();
  });
  return value!;
}

export function holdIdentityOpen() {
  const open = indexedDB.open.bind(indexedDB);
  const pending: Array<() => void> = [];
  const spy = vi.spyOn(indexedDB, 'open').mockImplementation((...args) => {
    const request = open(...args);
    let success: IDBOpenDBRequest['onsuccess'];
    Object.defineProperty(request, 'onsuccess', {
      configurable: true,
      get: () => (event: Event) => pending.push(() => success?.call(request, event)),
      set: (handler) => {
        success = handler;
      },
    });
    return request;
  });
  return {
    spy,
    waiting: () => pending.length,
    release: () => {
      spy.mockRestore();
      pending.splice(0).forEach((finish) => finish());
    },
  };
}

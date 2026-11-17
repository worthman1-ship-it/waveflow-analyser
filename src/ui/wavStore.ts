// Keeps the WAV file behind each source node in IndexedDB so a reload can restore it.
// Records are keyed by node id; the file name guards against a different graph reusing an id.
const DB = 'waveflow';
const STORE = 'wavs';

export interface StoredWav { name: string; buffer: ArrayBuffer }

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, f: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = f(db.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  } finally {
    db.close();
  }
}

export const putWav = (nodeId: string, name: string, buffer: ArrayBuffer) =>
  tx('readwrite', (s) => s.put({ name, buffer } satisfies StoredWav, nodeId)).catch(() => undefined);

export const getWav = (nodeId: string) =>
  tx<StoredWav | undefined>('readonly', (s) => s.get(nodeId)).catch(() => undefined);

export const deleteWav = (nodeId: string) =>
  tx('readwrite', (s) => s.delete(nodeId)).catch(() => undefined);

export const allWavKeys = () =>
  tx<IDBValidKey[]>('readonly', (s) => s.getAllKeys()).catch(() => [] as IDBValidKey[]);

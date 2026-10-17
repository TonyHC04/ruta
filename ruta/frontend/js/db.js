/**
 * Wrapper mínimo de IndexedDB con promesas.
 *
 * Stores:
 *  - cache            Copias de lecturas GET (productos, tiendas, dashboard...). key = URL.
 *  - pending_actions  Cola de escrituras por enviar. key = seq autoincremental (= orden).
 *  - failed_actions   Escrituras que el servidor rechazó (4xx). Se revisan a mano.
 *  - meta             Datos internos, p. ej. el mapa de IDs temporales -> reales.
 */
const DB_NAME = "ruta-manifiesto";
const DB_VERSION = 1;

export const STORES = Object.freeze({
  cache: "cache",
  queue: "pending_actions",
  failed: "failed_actions",
  meta: "meta",
});

let dbPromise = null;

function openDB() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORES.cache)) db.createObjectStore(STORES.cache, { keyPath: "key" });
      if (!db.objectStoreNames.contains(STORES.queue)) db.createObjectStore(STORES.queue, { keyPath: "seq", autoIncrement: true });
      if (!db.objectStoreNames.contains(STORES.failed)) db.createObjectStore(STORES.failed, { keyPath: "seq" });
      if (!db.objectStoreNames.contains(STORES.meta)) db.createObjectStore(STORES.meta, { keyPath: "key" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => { dbPromise = null; reject(req.error); };
  });
  return dbPromise;
}

async function run(storeName, mode, operation) {
  const db = await openDB();
  const tx = db.transaction(storeName, mode);
  const done = new Promise((resolve, reject) => {
    tx.oncomplete = resolve;
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
  const req = operation(tx.objectStore(storeName));
  const result = await new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  await done;
  return result;
}

export const idb = {
  get: (store, key) => run(store, "readonly", (s) => s.get(key)),
  getAll: (store) => run(store, "readonly", (s) => s.getAll()),   // ordenado por key
  count: (store) => run(store, "readonly", (s) => s.count()),
  put: (store, value) => run(store, "readwrite", (s) => s.put(value)),
  delete: (store, key) => run(store, "readwrite", (s) => s.delete(key)),

  /** Mueve un registro entre stores en una sola transacción (no se pierde si falla a medias). */
  async move(from, to, key, transform = (v) => v) {
    const db = await openDB();
    const tx = db.transaction([from, to], "readwrite");
    const src = tx.objectStore(from);
    const getReq = src.get(key);
    getReq.onsuccess = () => {
      if (!getReq.result) return;
      tx.objectStore(to).put(transform(getReq.result));
      src.delete(key);
    };
    return new Promise((resolve, reject) => {
      tx.oncomplete = resolve;
      tx.onerror = () => reject(tx.error);
    });
  },
};

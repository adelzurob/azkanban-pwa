// In-memory state + IndexedDB cache for boards data.
//
// IndexedDB holds exactly one record: the last-fetched boards.json plus its
// eTag. This lets us render instantly on cold start and work offline. Edits
// are also queued in IndexedDB while offline and replayed when the network
// returns.

const DB_NAME = "azkanban-pwa";
const DB_VERSION = 1;
const STORE_SNAPSHOT = "snapshot";   // single-row: the last fetched data + eTag
const STORE_QUEUE = "edit_queue";    // queued edits to replay when online

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) {
        db.createObjectStore(STORE_SNAPSHOT, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "queuedAt" });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

function tx(storeName, mode = "readonly") {
  return openDb().then((db) => db.transaction(storeName, mode).objectStore(storeName));
}

/** Save the current snapshot (data + eTag) to IndexedDB. */
export async function persistSnapshot(data, eTag) {
  const store = await tx(STORE_SNAPSHOT, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put({ id: "current", data, eTag, savedAt: Date.now() });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Load the last persisted snapshot, or null. */
export async function loadSnapshot() {
  const store = await tx(STORE_SNAPSHOT, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get("current");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Queue an offline edit (full snapshot replacement) for replay. */
export async function queueEdit(data, baseETag) {
  const store = await tx(STORE_QUEUE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.put({ queuedAt: Date.now(), data, baseETag });
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** List queued edits in chronological order. */
export async function listQueuedEdits() {
  const store = await tx(STORE_QUEUE, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

/** Remove a queued edit by its queuedAt key. */
export async function removeQueuedEdit(queuedAt) {
  const store = await tx(STORE_QUEUE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete(queuedAt);
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Clear all queued edits — used after a successful conflict-discard. */
export async function clearQueue() {
  const store = await tx(STORE_QUEUE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.clear();
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/* ──────────────────────────────────────────────────────────────────────────
   In-memory current-state container. Subscribers receive updates whenever
   the snapshot changes. Used by the UI layer to re-render reactively.
   ────────────────────────────────────────────────────────────────────────── */

const subscribers = new Set();
let currentData = null;
let currentETag = null;

export function getState() {
  return { data: currentData, eTag: currentETag };
}

export function setState(data, eTag) {
  currentData = data;
  currentETag = eTag;
  for (const cb of subscribers) {
    try {
      cb({ data: currentData, eTag: currentETag });
    } catch (err) {
      console.error("Subscriber threw:", err);
    }
  }
}

export function subscribe(cb) {
  subscribers.add(cb);
  return () => subscribers.delete(cb);
}

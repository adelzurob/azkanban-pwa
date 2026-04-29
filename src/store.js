// In-memory state + IndexedDB cache for boards data.
//
// IndexedDB holds exactly one record: the last-fetched boards.json plus its
// eTag. This lets us render instantly on cold start and work offline. Edits
// are also queued in IndexedDB while offline and replayed when the network
// returns.

const DB_NAME = "azkanban-pwa";
// Bump on schema change. v2: queue store changed from per-edit rows
// (keyPath "queuedAt") to a single-row "pending" snapshot (keyPath "id"),
// because for a single user we only ever need the latest unsaved snapshot.
const DB_VERSION = 2;
const STORE_SNAPSHOT = "snapshot";   // single-row: the last fetched data + eTag
const STORE_QUEUE = "edit_queue";    // single-row "pending": data + baseETag

let dbPromise = null;

function openDb() {
  if (dbPromise) return dbPromise;
  dbPromise = new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (evt) => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE_SNAPSHOT)) {
        db.createObjectStore(STORE_SNAPSHOT, { keyPath: "id" });
      }
      // v1 -> v2: drop the old per-edit queue store and recreate with the
      // simpler single-row schema. Any half-applied old queued edits are
      // discarded (acceptable — no v1 ever shipped a working offline path).
      if (evt.oldVersion < 2 && db.objectStoreNames.contains(STORE_QUEUE)) {
        db.deleteObjectStore(STORE_QUEUE);
      }
      if (!db.objectStoreNames.contains(STORE_QUEUE)) {
        db.createObjectStore(STORE_QUEUE, { keyPath: "id" });
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

/**
 * Save the current pending (offline-unsaved) snapshot. baseETag is the eTag
 * the file had the last time we successfully read or wrote — we'll send it
 * as If-Match when we replay. If an entry already exists, the existing
 * baseETag is preserved so subsequent offline edits don't accidentally
 * overwrite the conflict-detection anchor.
 */
export async function queuePending(data, baseETag) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE_QUEUE, "readwrite");
    const store = t.objectStore(STORE_QUEUE);
    const getReq = store.get("pending");
    getReq.onsuccess = () => {
      const existing = getReq.result;
      const finalBase = existing && existing.baseETag !== undefined
        ? existing.baseETag
        : baseETag;
      const putReq = store.put({
        id: "pending",
        data,
        baseETag: finalBase,
        queuedAt: existing ? existing.queuedAt : Date.now(),
        updatedAt: Date.now(),
      });
      putReq.onsuccess = () => resolve();
      putReq.onerror = () => reject(putReq.error);
    };
    getReq.onerror = () => reject(getReq.error);
  });
}

/** Load the pending unsaved snapshot, or null if nothing is queued. */
export async function loadPending() {
  const store = await tx(STORE_QUEUE, "readonly");
  return new Promise((resolve, reject) => {
    const req = store.get("pending");
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

/** Drop the pending snapshot — call after a successful save or a discard. */
export async function clearPending() {
  const store = await tx(STORE_QUEUE, "readwrite");
  return new Promise((resolve, reject) => {
    const req = store.delete("pending");
    req.onsuccess = () => resolve();
    req.onerror = () => reject(req.error);
  });
}

/** Quick boolean check used by the UI for "pending sync" badging. */
export async function hasPending() {
  const p = await loadPending();
  return !!p;
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

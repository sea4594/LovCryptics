const DB_NAME = "cryptic-cache-db";
const DB_VER = 1;

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VER);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains("puzzles")) {
        db.createObjectStore("puzzles", { keyPath: "key" }); // key = `${psid}|${date}`
      }
      if (!db.objectStoreNames.contains("progress")) {
        db.createObjectStore("progress", { keyPath: "key" }); // same key
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function tx(storeName, mode, fn) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(storeName, mode);
    const store = t.objectStore(storeName);
    const out = fn(store);
    t.oncomplete = () => resolve(out);
    t.onerror = () => reject(t.error);
  });
}

export async function put(store, value) {
  return tx(store, "readwrite", (s) => s.put(value));
}
export async function get(store, key) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = t.objectStore(store).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}
export async function del(store, key) {
  return tx(store, "readwrite", (s) => s.delete(key));
}
export async function getAll(store) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const t = db.transaction(store, "readonly");
    const req = t.objectStore(store).getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}

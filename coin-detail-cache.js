(function(root) {
  'use strict';
  const database = 'blockscope-coin-details-v1';
  let opening = null, generation = 0;
  function open() {
    if (!root.indexedDB) return Promise.resolve(null);
    if (!opening) opening = new Promise(resolve => {
      let request;
      try { request = root.indexedDB.open(database, 1); } catch (_) { resolve(null); return; }
      request.onupgradeneeded = () => request.result.createObjectStore('entries');
      request.onsuccess = () => {
        const db = request.result;
        db.onversionchange = () => { db.close(); opening = null; };
        resolve(db);
      };
      request.onerror = request.onblocked = () => { opening = null; resolve(null); };
    });
    return opening;
  }
  async function read(key, owner, maxAge, allowed) {
    const epoch = generation, db = await open();
    if (!db || !owner || epoch !== generation || !allowed()) return null;
    return new Promise(resolve => {
      let request;
      try { request = db.transaction('entries').objectStore('entries').get(owner + ':' + key); }
      catch (_) { resolve(null); return; }
      request.onerror = () => resolve(null);
      request.onsuccess = () => {
        const value = request.result, now = Date.now();
        resolve(epoch === generation && allowed() && value?.owner === owner && now < value.expiresAt
          && now >= value.at && now - value.at < maxAge ? value : null);
      };
    });
  }
  async function write(key, owner, payload, at, expiresAt, allowed) {
    const epoch = generation, db = await open();
    if (!db || !owner || epoch !== generation || !allowed() || !(expiresAt > Date.now())) return false;
    return new Promise(resolve => {
      let transaction;
      try {
        transaction = db.transaction('entries', 'readwrite');
        const store = transaction.objectStore('entries');
        store.put({ owner, payload, at, expiresAt }, owner + ':' + key);
        const keys = store.getAllKeys();
        keys.onsuccess = () => {
          const current = owner + ':' + key;
          for (const old of keys.result.filter(item => item !== current && item !== owner + ':introductions')
            .slice(0, Math.max(0, keys.result.length - 32))) store.delete(old);
        };
      } catch (_) { resolve(false); return; }
      transaction.oncomplete = () => resolve(epoch === generation && allowed());
      transaction.onerror = transaction.onabort = () => resolve(false);
    });
  }
  async function clear() {
    generation++;
    const db = await open();
    if (!db) return;
    return new Promise(resolve => {
      try {
        const transaction = db.transaction('entries', 'readwrite');
        transaction.objectStore('entries').clear();
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      } catch (_) { resolve(); }
    });
  }
  async function removePrefix(owner, prefix) {
    const db = await open();
    if (!db) return;
    return new Promise(resolve => {
      try {
        const transaction = db.transaction('entries', 'readwrite'), store = transaction.objectStore('entries');
        const keys = store.getAllKeys();
        keys.onsuccess = () => { for (const key of keys.result) if (key.startsWith(owner + ':' + prefix)) store.delete(key); };
        transaction.oncomplete = transaction.onerror = transaction.onabort = () => resolve();
      } catch (_) { resolve(); }
    });
  }
  root.BlockscopeCoinDetailCache = { read, write, clear, removePrefix };
})(window);

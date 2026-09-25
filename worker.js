'use strict';

// 批量写入 Worker：只负责打开数据库、分块写入、上报进度与错误。
const DB_NAME = 'batch-write-demo';
const STORE = 'records';
const VERSION = 1;
const CHUNK = 100;

let db = null;
let stopped = false;

function makeRecord(id) {
  return {
    id: id,
    name: 'record-' + id,
    createdAt: Date.now(),
    payload: ('payload-' + id + '-').repeat(8)
  };
}

function isDbGone(err) {
  return !!err && (err.name === 'InvalidStateError' || err.name === 'DatabaseClosedError');
}

function openDB() {
  return new Promise(function (resolve, reject) {
    if (typeof indexedDB === 'undefined') {
      reject(new Error('NO_IDB'));
      return;
    }
    const req = indexedDB.open(DB_NAME, VERSION);
    req.onupgradeneeded = function () {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id' });
      }
    };
    req.onsuccess = function () {
      db = req.result;
      // 数据库被删除或被更高版本打开时触发
      db.onversionchange = function () {
        try { db.close(); } catch (e) {}
        stopped = true;
        postMessage({ type: 'db-deleted' });
      };
      resolve();
    };
    req.onerror = function () { reject(req.error); };
    req.onblocked = function () { postMessage({ type: 'open-blocked' }); };
  });
}

function putOne(record) {
  return new Promise(function (resolve, reject) {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch (e) {
      reject(e);
      return;
    }
    tx.objectStore(STORE).put(record);
    tx.oncomplete = function () { resolve(); };
    tx.onabort = function () { reject(tx.error || new Error('AbortError')); };
    tx.onerror = function () { reject(tx.error || new Error('TransactionError')); };
  });
}

// 一个事务写入一块；simulateAbort 时随机中断事务以模拟故障
function writeChunk(ids, simulateAbort) {
  return new Promise(function (resolve) {
    let tx;
    try {
      tx = db.transaction(STORE, 'readwrite');
    } catch (e) {
      resolve({ chunkError: e });
      return;
    }
    let lastReq = null;
    for (let i = 0; i < ids.length; i++) {
      lastReq = tx.objectStore(STORE).put(makeRecord(ids[i]));
    }
    if (simulateAbort && Math.random() < 0.05 && lastReq) {
      lastReq.onsuccess = function () {
        try { tx.abort(); } catch (e) {}
      };
    }
    tx.oncomplete = function () { resolve({ okIds: ids.slice(), failIds: [] }); };
    tx.onabort = function () { resolve({ aborted: true, error: tx.error }); };
    tx.onerror = function () { resolve({ aborted: true, error: tx.error }); };
  });
}

async function run(ids, simulateAbort, isRetry) {
  stopped = false;
  if (!db) {
    try {
      await openDB();
    } catch (e) {
      if (e && e.message === 'NO_IDB') {
        postMessage({ type: 'no-idb' });
      } else if (e && e.name === 'VersionError') {
        postMessage({ type: 'version-conflict' });
      } else {
        postMessage({ type: 'open-error', name: e && e.name, message: e && e.message });
      }
      return;
    }
  }

  for (let i = 0; i < ids.length && !stopped; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    let res = await writeChunk(slice, simulateAbort && !isRetry);

    if (res.chunkError) {
      if (isDbGone(res.chunkError)) {
        postMessage({ type: 'db-deleted' });
        return;
      }
      res = { aborted: true };
    }

    if (res.aborted && res.error && res.error.name === 'QuotaExceededError') {
      postMessage({ type: 'quota' });
      postMessage({ type: 'progress', okIds: [], failIds: [], lastId: isRetry ? null : slice[0] - 1 });
      return;
    }

    let okIds = [];
    let failIds = [];
    if (res.aborted) {
      // 事务中断：逐条重试，隔离出真正的失败项
      for (let j = 0; j < slice.length && !stopped; j++) {
        const id = slice[j];
        try {
          await putOne(makeRecord(id));
          okIds.push(id);
        } catch (e) {
          if (e && e.name === 'QuotaExceededError') {
            postMessage({ type: 'quota' });
            postMessage({
              type: 'progress',
              okIds: okIds,
              failIds: failIds,
              lastId: isRetry ? null : (okIds.length ? okIds[okIds.length - 1] : slice[0] - 1)
            });
            return;
          }
          if (isDbGone(e)) {
            postMessage({ type: 'db-deleted' });
            postMessage({
              type: 'progress',
              okIds: okIds,
              failIds: failIds,
              lastId: isRetry ? null : (okIds.length ? okIds[okIds.length - 1] : slice[0] - 1)
            });
            return;
          }
          failIds.push(id);
        }
      }
    } else {
      okIds = res.okIds;
      failIds = res.failIds;
    }

    postMessage({
      type: 'progress',
      okIds: okIds,
      failIds: failIds,
      lastId: isRetry ? null : slice[slice.length - 1]
    });
  }
  postMessage({ type: 'done' });
}

onmessage = function (e) {
  const d = e.data;
  if (d.type === 'run') {
    run(d.ids, !!d.simulateAbort, !!d.isRetry);
  }
};

'use strict';

const DB_NAME = 'batch-write-demo';
const STORE = 'records';
const META = 'meta';
const BATCH_SIZE = 500;

let db = null;
let memoryMode = false;
const memStore = new Map();

let job = null; // { total, failRate, done:Set, failed:Set, status }

function makeRecord(id) {
  return {
    id,
    name: 'record-' + id,
    value: (id * 7919) % 100000,
    createdAt: 1700000000000 + id * 1000,
    payload: ('payload-' + id.toString(36) + '-').repeat(4)
  };
}

function postState(status) {
  postMessage({
    type: 'progress',
    total: job ? job.total : 0,
    done: job ? job.done.size : 0,
    failed: job ? job.failed.size : 0,
    status: status || (job ? job.status : 'idle')
  });
}

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(STORE)) d.createObjectStore(STORE, { keyPath: 'id' });
      if (!d.objectStoreNames.contains(META)) d.createObjectStore(META, { keyPath: 'key' });
    };
    req.onsuccess = () => {
      db = req.result;
      db.onversionchange = () => {
        try { db.close(); } catch (e) { /* ignore */ }
        db = null;
        postMessage({ type: 'notice', kind: 'version-conflict', message: '数据库在其他上下文被升级（版本冲突），连接已关闭，请重新初始化。' });
      };
      resolve();
    };
    req.onerror = () => reject(req.error || new Error('open failed'));
    req.onblocked = () => postMessage({ type: 'notice', kind: 'blocked', message: '数据库升级被其他连接阻塞。' });
  });
}

function loadMeta() {
  return new Promise((resolve) => {
    if (memoryMode || !db) return resolve(null);
    try {
      const tx = db.transaction(META, 'readonly');
      const req = tx.objectStore(META).get('job');
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = () => resolve(null);
    } catch (e) {
      resolve(null);
    }
  });
}

function persistMeta() {
  if (memoryMode || !db) return Promise.resolve();
  return new Promise((resolve, reject) => {
    let tx;
    try {
      tx = db.transaction(META, 'readwrite');
    } catch (e) { return reject(e); }
    tx.objectStore(META).put({
      key: 'job',
      total: job.total,
      failRate: job.failRate,
      done: Array.from(job.done),
      failed: Array.from(job.failed),
      status: job.status,
      updatedAt: Date.now()
    });
    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => reject(tx.error || new Error('meta persist aborted'));
  });
}

function processBatch(keys) {
  const good = [];
  const bad = [];
  for (const k of keys) {
    (Math.random() < job.failRate ? bad : good).push(k);
  }

  if (memoryMode) {
    for (const k of good) memStore.set(k, makeRecord(k));
    good.forEach(k => { job.done.add(k); job.failed.delete(k); });
    bad.forEach(k => job.failed.add(k));
    return Promise.resolve();
  }

  return new Promise((resolve, reject) => {
    if (!db) return reject(Object.assign(new Error('db closed'), { name: 'InvalidStateError' }));
    let tx;
    try {
      tx = db.transaction([STORE, META], 'readwrite');
    } catch (e) { return reject(e); }

    const rs = tx.objectStore(STORE);
    for (const k of good) rs.put(makeRecord(k));

    good.forEach(k => { job.done.add(k); job.failed.delete(k); });
    bad.forEach(k => job.failed.add(k));

    tx.objectStore(META).put({
      key: 'job',
      total: job.total,
      failRate: job.failRate,
      done: Array.from(job.done),
      failed: Array.from(job.failed),
      status: job.status,
      updatedAt: Date.now()
    });

    tx.oncomplete = () => resolve();
    tx.onabort = tx.onerror = () => {
      good.forEach(k => job.done.delete(k));
      bad.forEach(k => job.failed.delete(k));
      reject(tx.error || Object.assign(new Error('transaction aborted'), { name: 'AbortError' }));
    };
  });
}

function classifyError(err) {
  const name = (err && err.name) || '';
  if (name === 'QuotaExceededError' || name === 'NS_ERROR_DOM_QUOTA_REACHED') return 'quota';
  if (name === 'AbortError') return 'tx-abort';
  if (name === 'InvalidStateError' || name === 'UnknownError' || name === 'NotFoundError') return 'db-gone';
  return 'unknown';
}

async function runKeys(keys) {
  job.status = 'running';
  postState();
  for (let i = 0; i < keys.length; i += BATCH_SIZE) {
    if (job.status !== 'running') break;
    const batch = keys.slice(i, i + BATCH_SIZE);
    try {
      await processBatch(batch);
    } catch (err) {
      const kind = classifyError(err);
      if (kind === 'quota') {
        batch.forEach(k => job.failed.add(k));
        job.status = 'paused';
        try { await persistMeta(); } catch (e) { /* best effort */ }
        postMessage({ type: 'error', kind: 'quota', message: '存储配额不足（QuotaExceededError）。已暂停写入，本批计入失败，可释放空间后重试失败项。' });
        postState();
        return;
      }
      if (kind === 'tx-abort') {
        batch.forEach(k => job.failed.add(k));
        postMessage({ type: 'notice', kind: 'tx-abort', message: '一个事务被中断（AbortError），该批 ' + batch.length + ' 条计入失败，可重试。' });
        try { await persistMeta(); } catch (e) { /* best effort */ }
        postState();
        continue;
      }
      if (kind === 'db-gone') {
        job.status = 'paused';
        postMessage({ type: 'error', kind: 'db-deleted', message: '数据库连接失效（可能已被删除或在隐私模式下受限）。请重新初始化。' });
        postState();
        return;
      }
      batch.forEach(k => job.failed.add(k));
      postMessage({ type: 'notice', kind: 'unknown', message: '未知错误：' + (err && err.message) });
      try { await persistMeta(); } catch (e) { /* best effort */ }
      postState();
      continue;
    }
    postState();
  }
  if (job.status === 'running') {
    job.status = (job.done.size + job.failed.size >= job.total) ? 'done' : 'paused';
    try { await persistMeta(); } catch (e) { /* best effort */ }
    postState();
    if (job.status === 'done') postMessage({ type: 'complete', done: job.done.size, failed: job.failed.size, total: job.total });
  }
}

function remainingKeys() {
  const keys = [];
  for (let i = 0; i < job.total; i++) {
    if (!job.done.has(i) && !job.failed.has(i)) keys.push(i);
  }
  return keys;
}

async function init() {
  memoryMode = false;
  memStore.clear();
  job = null;
  try {
    await openDB();
  } catch (err) {
    memoryMode = true;
    postMessage({
      type: 'ready',
      degraded: true,
      message: 'IndexedDB 不可用（可能是浏览器隐私/无痕模式）：' + ((err && err.message) || err) + '。已降级为内存模拟写入，刷新后不保留。'
    });
    return;
  }

  let quotaWarning = null;
  try {
    if (navigator.storage && navigator.storage.estimate) {
      const est = await navigator.storage.estimate();
      if (est.quota && est.quota < 50 * 1024 * 1024) {
        quotaWarning = '检测到可用存储配额较小（约 ' + Math.round(est.quota / 1024 / 1024) + ' MB，可能处于隐私模式），写入可能触发配额不足。';
      }
    }
  } catch (e) { /* ignore */ }

  const meta = await loadMeta();
  let resume = null;
  if (meta && meta.status !== 'done' && (meta.done.length + meta.failed.length) < meta.total) {
    resume = { total: meta.total, done: meta.done.length, failed: meta.failed.length };
    job = {
      total: meta.total,
      failRate: meta.failRate || 0,
      done: new Set(meta.done),
      failed: new Set(meta.failed),
      status: 'paused'
    };
  } else if (meta && meta.status !== 'done' && meta.failed.length > 0) {
    resume = { total: meta.total, done: meta.done.length, failed: meta.failed.length, onlyRetry: true };
    job = {
      total: meta.total,
      failRate: meta.failRate || 0,
      done: new Set(meta.done),
      failed: new Set(meta.failed),
      status: 'paused'
    };
  }
  postMessage({ type: 'ready', degraded: false, quotaWarning, resume });
  if (job) postState();
}

onmessage = async (e) => {
  const msg = e.data;
  try {
    switch (msg.type) {
      case 'init':
        await init();
        break;
      case 'start': {
        job = {
          total: msg.total,
          failRate: Math.min(Math.max(msg.failRate || 0, 0), 1),
          done: new Set(),
          failed: new Set(),
          status: 'running'
        };
        const keys = [];
        for (let i = 0; i < job.total; i++) keys.push(i);
        await runKeys(keys);
        break;
      }
      case 'resume': {
        if (!job) { postMessage({ type: 'notice', kind: 'info', message: '没有可恢复的任务。' }); break; }
        await runKeys(remainingKeys());
        break;
      }
      case 'retry': {
        if (!job || job.failed.size === 0) { postMessage({ type: 'notice', kind: 'info', message: '没有失败项可重试。' }); break; }
        const keys = Array.from(job.failed);
        await runKeys(keys);
        break;
      }
      case 'close':
        if (db) { try { db.close(); } catch (err) { /* ignore */ } db = null; }
        postMessage({ type: 'closed' });
        break;
      case 'reset':
        job = null;
        memStore.clear();
        postMessage({ type: 'progress', total: 0, done: 0, failed: 0, status: 'idle' });
        break;
    }
  } catch (err) {
    postMessage({ type: 'error', kind: 'fatal', message: String((err && err.message) || err) });
  }
};

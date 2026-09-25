'use strict';

// 主线程：状态管理、Canvas 进度渲染、localStorage 断点恢复、异常提示与降级。
const TOTAL = 10000;
const STATE_KEY = 'idb-batch-state-v1';
const DB_NAME = 'batch-write-demo';

const canvas = document.getElementById('progress-canvas');
const statDone = document.getElementById('stat-done');
const statSuccess = document.getElementById('stat-success');
const statFailed = document.getElementById('stat-failed');
const statPct = document.getElementById('stat-pct');
const msgBox = document.getElementById('msg');
const logList = document.getElementById('log');
const btnStart = document.getElementById('btn-start');
const btnRetry = document.getElementById('btn-retry');
const btnReset = document.getElementById('btn-reset');
const btnDelDb = document.getElementById('btn-deldb');
const btnBump = document.getElementById('btn-bump');
const chkAbort = document.getElementById('chk-abort');

let worker = null;
let running = false;
let memoryMode = false;
let bumpedDb = null;
const memoryStore = new Map();

function freshState() {
  return { nextIndex: 0, failedIds: [], success: 0, failed: 0, total: TOTAL };
}

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

let state = loadState() || freshState();

function saveState() {
  if (memoryMode) return; // 内存降级模式下数据本身不持久化，状态也不保存
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch (e) {}
}

function showMsg(text, level) {
  msgBox.textContent = text || '';
  msgBox.className = 'msg' + (text ? ' show ' + (level || 'info') : '');
}

function log(text) {
  const li = document.createElement('li');
  li.textContent = new Date().toLocaleTimeString() + '  ' + text;
  logList.insertBefore(li, logList.firstChild);
  while (logList.children.length > 30) logList.removeChild(logList.lastChild);
}

// ---------- Canvas 进度环 ----------
function render() {
  const done = state.success + state.failed;
  const pct = done / state.total;
  statDone.textContent = done + ' / ' + state.total;
  statSuccess.textContent = String(state.success);
  statFailed.textContent = String(state.failed);
  statPct.textContent = (pct * 100).toFixed(1) + '%';

  const ctx = canvas.getContext('2d');
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(w, h) / 2 - 16;
  const start = -Math.PI / 2;
  ctx.clearRect(0, 0, w, h);

  ctx.lineWidth = 18;
  ctx.lineCap = 'round';

  // 剩余（灰）
  ctx.strokeStyle = '#e5e7eb';
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();

  // 成功（绿）
  if (state.success > 0) {
    ctx.strokeStyle = '#22c55e';
    ctx.beginPath();
    ctx.arc(cx, cy, r, start, start + (state.success / state.total) * Math.PI * 2);
    ctx.stroke();
  }
  // 失败（红）
  if (state.failed > 0) {
    ctx.strokeStyle = '#ef4444';
    ctx.beginPath();
    const s = start + (state.success / state.total) * Math.PI * 2;
    ctx.arc(cx, cy, r, s, s + (state.failed / state.total) * Math.PI * 2);
    ctx.stroke();
  }

  ctx.fillStyle = '#111827';
  ctx.font = 'bold 26px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText((pct * 100).toFixed(1) + '%', cx, cy - 8);
  ctx.font = '13px system-ui, sans-serif';
  ctx.fillStyle = '#6b7280';
  ctx.fillText(done + ' / ' + state.total, cx, cy + 18);

  btnRetry.disabled = running || state.failedIds.length === 0;
  btnStart.disabled = running || state.nextIndex >= state.total;
}

// ---------- 进度应用 ----------
function applyProgress(okIds, failIds, lastId) {
  state.success += okIds.length;
  state.failed += failIds.length;
  if (failIds.length) state.failedIds = state.failedIds.concat(failIds);
  if (lastId !== null && lastId !== undefined && lastId + 1 > state.nextIndex) {
    state.nextIndex = lastId + 1;
  }
  saveState();
  render();
}

// ---------- Worker ----------
function ensureWorker() {
  if (worker) return worker;
  worker = new Worker('worker.js');
  worker.onmessage = function (e) {
    const d = e.data;
    switch (d.type) {
      case 'progress':
        applyProgress(d.okIds, d.failIds, d.lastId);
        break;
      case 'done':
        running = false;
        if (state.failedIds.length) {
          showMsg('写入完成，存在 ' + state.failedIds.length + ' 条失败，可点击“重试失败项”。', 'warn');
        } else if (state.nextIndex >= state.total) {
          showMsg('全部 ' + state.total + ' 条写入完成。', 'ok');
        }
        log('一轮写入结束：成功 ' + state.success + '，失败 ' + state.failed);
        render();
        break;
      case 'quota':
        running = false;
        showMsg('存储配额不足（QuotaExceededError）：已停止写入并保存进度。请清理空间或减小数据量后重试。', 'error');
        log('配额不足，写入降级停止');
        render();
        break;
      case 'db-deleted':
        running = false;
        showMsg('数据库已被删除或发生版本变更，写入已停止。请重置或刷新后重试。', 'error');
        log('数据库连接被关闭（删除/版本变更）');
        render();
        break;
      case 'version-conflict':
        running = false;
        showMsg('版本冲突（VersionError）：数据库版本高于应用版本，请升级应用或重置数据库。', 'error');
        log('打开数据库遇到版本冲突');
        render();
        break;
      case 'open-blocked':
        showMsg('数据库打开被阻塞：请关闭其他打开本页面的标签页。', 'warn');
        break;
      case 'no-idb':
      case 'open-error':
        // 隐私模式 / 受限环境：降级为内存写入，不崩溃
        enterMemoryMode(d.name, d.message);
        break;
    }
  };
  worker.onerror = function () {
    running = false;
    showMsg('Worker 运行出错，写入停止。', 'error');
    render();
  };
  return worker;
}

function startRun() {
  if (running) return;
  if (state.nextIndex >= state.total) {
    showMsg('初始写入已完成，可使用“重试失败项”或“重置”。', 'info');
    return;
  }
  const ids = [];
  for (let i = state.nextIndex; i < state.total; i++) ids.push(i);
  running = true;
  showMsg('正在写入…', 'info');
  log('开始写入 ' + ids.length + ' 条（从 #' + state.nextIndex + ' 起）');
  if (memoryMode) {
    memoryRun(ids, false);
  } else {
    ensureWorker().postMessage({ type: 'run', ids: ids, simulateAbort: chkAbort.checked, isRetry: false });
  }
  render();
}

function retryFailed() {
  if (running || state.failedIds.length === 0) return;
  const ids = state.failedIds.slice();
  state.failedIds = [];
  state.failed = 0;
  saveState();
  running = true;
  showMsg('正在重试 ' + ids.length + ' 条失败项…', 'info');
  log('重试失败项 ' + ids.length + ' 条');
  if (memoryMode) {
    memoryRun(ids, true);
  } else {
    ensureWorker().postMessage({ type: 'run', ids: ids, simulateAbort: false, isRetry: true });
  }
  render();
}

// ---------- 隐私模式降级：内存写入 ----------
function enterMemoryMode(name, message) {
  if (memoryMode) return;
  memoryMode = true;
  if (worker) { worker.terminate(); worker = null; }
  showMsg('当前环境不可用 IndexedDB（可能为隐私/受限模式：' + (name || '') + ' ' + (message || '') + '）。已降级为内存写入，刷新后数据将丢失。', 'warn');
  log('IndexedDB 不可用，降级为内存模式');
  // 继续当前未完成的写入
  if (state.nextIndex < state.total) {
    running = true;
    const ids = [];
    for (let i = state.nextIndex; i < state.total; i++) ids.push(i);
    memoryRun(ids, false);
  }
  render();
}

async function memoryRun(ids, isRetry) {
  running = true;
  for (let i = 0; i < ids.length; i += 200) {
    const slice = ids.slice(i, i + 200);
    await new Promise(function (r) { setTimeout(r, 10); });
    const okIds = [];
    for (let j = 0; j < slice.length; j++) {
      memoryStore.set(slice[j], { id: slice[j] });
      okIds.push(slice[j]);
    }
    applyProgress(okIds, [], isRetry ? null : slice[slice.length - 1]);
  }
  running = false;
  showMsg('（内存模式）写入完成：成功 ' + state.success + '，失败 ' + state.failed + '。', 'ok');
  render();
}

// ---------- 故障模拟 ----------
function simulateDeleteDb() {
  if (typeof indexedDB === 'undefined') {
    showMsg('当前环境无 IndexedDB，无法模拟删除。', 'warn');
    return;
  }
  const req = indexedDB.deleteDatabase(DB_NAME);
  req.onsuccess = function () { log('数据库已删除（模拟）'); };
  req.onblocked = function () { log('删除被阻塞：等待其他连接关闭'); };
  req.onerror = function () { showMsg('删除数据库失败：' + req.error, 'error'); };
}

function simulateVersionBump() {
  if (typeof indexedDB === 'undefined') {
    showMsg('当前环境无 IndexedDB，无法模拟版本冲突。', 'warn');
    return;
  }
  const req = indexedDB.open(DB_NAME, 2); // 以更高版本打开
  req.onupgradeneeded = function () {};
  req.onsuccess = function () {
    bumpedDb = req.result;
    showMsg('数据库已被外部升级到 v2。再次点击“开始写入”将触发版本冲突提示。', 'warn');
    log('模拟外部升级数据库到 v2');
  };
  req.onerror = function () { showMsg('升级模拟失败：' + req.error, 'error'); };
}

function resetAll() {
  running = false;
  if (worker) { worker.terminate(); worker = null; }
  if (bumpedDb) { try { bumpedDb.close(); } catch (e) {} bumpedDb = null; }
  memoryStore.clear();
  try { localStorage.removeItem(STATE_KEY); } catch (e) {}
  state = freshState();
  if (typeof indexedDB !== 'undefined') {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = function () { log('数据库已重置'); };
  }
  showMsg('已重置。', 'info');
  render();
}

// ---------- 启动：刷新恢复 ----------
btnStart.addEventListener('click', startRun);
btnRetry.addEventListener('click', retryFailed);
btnReset.addEventListener('click', resetAll);
btnDelDb.addEventListener('click', simulateDeleteDb);
btnBump.addEventListener('click', simulateVersionBump);

render();
if (state.nextIndex < state.total || state.failedIds.length > 0) {
  showMsg('检测到未完成的写入任务（页面刷新后恢复），即将自动继续…', 'warn');
  log('从断点恢复：nextIndex=' + state.nextIndex + '，失败 ' + state.failedIds.length + ' 条');
  setTimeout(function () {
    if (state.nextIndex < state.total) startRun();
    else render();
  }, 400);
} else if (state.success > 0) {
  showMsg('上次任务已完成：成功 ' + state.success + ' 条。', 'ok');
}

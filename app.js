'use strict';

const TOTAL = 10000;
const DB_NAME = 'batch-write-demo';

const worker = new Worker('worker.js');

const el = {
  canvas: document.getElementById('progress-canvas'),
  statDone: document.getElementById('stat-done'),
  statFailed: document.getElementById('stat-failed'),
  statPending: document.getElementById('stat-pending'),
  statStatus: document.getElementById('stat-status'),
  startBtn: document.getElementById('btn-start'),
  retryBtn: document.getElementById('btn-retry'),
  resumeBtn: document.getElementById('btn-resume'),
  deleteDbBtn: document.getElementById('btn-delete-db'),
  conflictBtn: document.getElementById('btn-conflict'),
  reinitBtn: document.getElementById('btn-reinit'),
  failRate: document.getElementById('fail-rate'),
  failRateLabel: document.getElementById('fail-rate-label'),
  banner: document.getElementById('banner'),
  resumeBar: document.getElementById('resume-bar'),
  resumeInfo: document.getElementById('resume-info'),
  log: document.getElementById('log')
};

const ctx = el.canvas.getContext('2d');
const state = { total: 0, done: 0, failed: 0, status: 'idle' };

const STATUS_TEXT = {
  idle: '空闲',
  running: '写入中…',
  paused: '已暂停（可恢复/重试）',
  done: '已完成'
};

function log(message, level) {
  const line = document.createElement('div');
  line.className = 'log-line ' + (level || 'info');
  line.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
  el.log.prepend(line);
}

function showBanner(text, kind) {
  el.banner.textContent = text;
  el.banner.className = 'banner show ' + (kind || 'warn');
}

function hideBanner() {
  el.banner.className = 'banner';
}

function drawProgress() {
  const w = el.canvas.width;
  const h = el.canvas.height;
  ctx.clearRect(0, 0, w, h);

  ctx.fillStyle = '#e5e7eb';
  ctx.fillRect(0, 0, w, h);

  const total = state.total || 1;
  const doneW = (state.done / total) * w;
  const failedW = (state.failed / total) * w;

  ctx.fillStyle = '#22c55e';
  ctx.fillRect(0, 0, doneW, h);
  ctx.fillStyle = '#ef4444';
  ctx.fillRect(doneW, 0, failedW, h);

  ctx.strokeStyle = '#9ca3af';
  ctx.strokeRect(0.5, 0.5, w - 1, h - 1);

  const processed = state.done + state.failed;
  const pct = state.total ? ((processed / state.total) * 100).toFixed(1) : '0.0';
  ctx.fillStyle = '#111827';
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(pct + '%  (' + processed + ' / ' + state.total + ')', w / 2, h / 2);
}

function render() {
  el.statDone.textContent = state.done;
  el.statFailed.textContent = state.failed;
  el.statPending.textContent = Math.max(state.total - state.done - state.failed, 0);
  el.statStatus.textContent = STATUS_TEXT[state.status] || state.status;
  el.retryBtn.disabled = state.failed === 0 || state.status === 'running';
  el.startBtn.disabled = state.status === 'running';
  el.resumeBtn.disabled = state.status === 'running';
  drawProgress();
}

worker.onmessage = (e) => {
  const msg = e.data;
  switch (msg.type) {
    case 'ready':
      if (msg.degraded) {
        showBanner(msg.message, 'error');
        log(msg.message, 'error');
      } else {
        log('IndexedDB 初始化成功。');
        if (msg.quotaWarning) {
          showBanner(msg.quotaWarning, 'warn');
          log(msg.quotaWarning, 'warn');
        }
      }
      if (msg.resume) {
        el.resumeInfo.textContent =
          '检测到未完成任务：共 ' + msg.resume.total + ' 条，已成功 ' + msg.resume.done +
          ' 条，失败 ' + msg.resume.failed + ' 条。';
        el.resumeBar.classList.add('show');
        log('检测到未完成任务（页面刷新后可恢复）。', 'warn');
      } else {
        el.resumeBar.classList.remove('show');
      }
      break;
    case 'progress':
      state.total = msg.total;
      state.done = msg.done;
      state.failed = msg.failed;
      state.status = msg.status;
      render();
      break;
    case 'complete':
      log('写入完成：成功 ' + msg.done + ' / ' + msg.total + '，失败 ' + msg.failed + '。', msg.failed ? 'warn' : 'ok');
      break;
    case 'notice':
      log(msg.message, 'warn');
      if (msg.kind === 'version-conflict') showBanner(msg.message, 'error');
      break;
    case 'error':
      log(msg.message, 'error');
      if (msg.kind === 'quota') showBanner(msg.message, 'error');
      else if (msg.kind === 'db-deleted') showBanner(msg.message, 'error');
      else showBanner(msg.message, 'error');
      break;
    case 'closed':
      log('Worker 已关闭数据库连接。');
      break;
  }
};

worker.onerror = (err) => {
  log('Worker 异常：' + err.message, 'error');
};

el.startBtn.addEventListener('click', () => {
  hideBanner();
  el.resumeBar.classList.remove('show');
  log('开始写入 ' + TOTAL + ' 条记录（模拟失败率 ' + el.failRate.value + '%）…');
  worker.postMessage({ type: 'start', total: TOTAL, failRate: Number(el.failRate.value) / 100 });
});

el.retryBtn.addEventListener('click', () => {
  log('重试 ' + state.failed + ' 条失败记录…');
  worker.postMessage({ type: 'retry' });
});

el.resumeBtn.addEventListener('click', () => {
  el.resumeBar.classList.remove('show');
  log('恢复未完成的写入任务…');
  worker.postMessage({ type: 'resume' });
});

el.reinitBtn.addEventListener('click', () => {
  hideBanner();
  log('重新初始化数据库…');
  worker.postMessage({ type: 'init' });
});

el.deleteDbBtn.addEventListener('click', () => {
  log('请求删除数据库…');
  worker.postMessage({ type: 'close' });
  const waitClosed = new Promise((resolve) => {
    const handler = (e) => {
      if (e.data.type === 'closed') {
        worker.removeEventListener('message', handler);
        resolve();
      }
    };
    worker.addEventListener('message', handler);
    setTimeout(resolve, 1000);
  });
  waitClosed.then(() => {
    const req = indexedDB.deleteDatabase(DB_NAME);
    req.onsuccess = () => {
      worker.postMessage({ type: 'reset' });
      el.resumeBar.classList.remove('show');
      showBanner('数据库已被删除。后续写入会失败并提示，可点击「重新初始化」重建。', 'warn');
      log('数据库已删除。', 'warn');
    };
    req.onerror = () => log('删除数据库失败：' + req.error, 'error');
    req.onblocked = () => log('删除被阻塞：仍有其他连接未关闭。', 'warn');
  });
});

el.conflictBtn.addEventListener('click', () => {
  const probe = indexedDB.open(DB_NAME);
  probe.onsuccess = () => {
    const version = probe.result.version;
    probe.result.close();
    const upgrade = indexedDB.open(DB_NAME, version + 1);
    upgrade.onupgradeneeded = () => log('主线程触发版本升级 v' + version + ' → v' + (version + 1) + '（模拟版本冲突）。', 'warn');
    upgrade.onsuccess = () => {
      upgrade.result.close();
      log('升级完成，Worker 侧连接已收到 onversionchange 并关闭。', 'warn');
    };
    upgrade.onerror = () => log('模拟版本冲突失败：' + upgrade.error, 'error');
  };
  probe.onerror = () => log('无法打开数据库以模拟版本冲突。', 'error');
});

el.failRate.addEventListener('input', () => {
  el.failRateLabel.textContent = el.failRate.value + '%';
});

render();
worker.postMessage({ type: 'init' });

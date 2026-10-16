'use strict';

function displayWidth(text) {
  let width = 0;
  for (const char of text) width += char.codePointAt(0) > 0xff ? 2 : 1;
  return width;
}

function screen(title, rows, color) {
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  const labelWidth = Math.max(...rows.map(([label]) => displayWidth(label)));
  const body = rows.map(([label, value]) => {
    const gap = ' '.repeat(labelWidth - displayWidth(label));
    return `  ${paint('2', label)}${gap}  ${value}`;
  });
  return [paint('1', title), ...body].join('\n');
}

function startScreen(port, sessionID, color = process.stdout.isTTY && !process.env.NO_COLOR) {
  return screen('copilot-gateway', [
    ['API Base', `http://127.0.0.1:${port}/zen/go/v1`],
    ['健康檢查', `http://127.0.0.1:${port}/healthz`],
    ['Session', sessionID],
    ['停止', 'Ctrl+C'],
  ], color);
}

function failureScreen(rows) {
  return screen('copilot-gateway', rows, process.stderr.isTTY && !process.env.NO_COLOR);
}

const SLOW_HEADER_MS = 2000;
const RECENT_WINDOW = 20;

function formatDuration(durationMs) {
  if (durationMs < 1000) return `${Math.round(durationMs)}ms`;
  return `${(durationMs / 1000).toFixed(1)}s`;
}

function phaseText(label, durationMs, paint) {
  if (!Number.isFinite(durationMs) || durationMs < 0) return `${label} —`;
  const slow = durationMs >= SLOW_HEADER_MS;
  const tone = slow ? '33' : '32';
  const pace = slow ? `慢 ${formatDuration(durationMs)}` : formatDuration(durationMs);
  return `${label} ${paint(tone, pace)}`;
}

function median(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) return sorted[mid];
  return (sorted[mid - 1] + sorted[mid]) / 2;
}

function createLiveStatus({
  write = (text) => process.stdout.write(text),
  color = false,
  intervalMs = 120,
  clock = () => new Date().toLocaleTimeString('zh-TW', { hour12: false }),
} = {}) {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  const paint = (code, text) => (color ? `\x1b[${code}m${text}\x1b[0m` : text);
  let frame = 0;
  let fault = null;
  let timer = null;
  let forwarded = 0;
  let inflight = 0;
  let timeouts = 0;
  let aborts = 0;
  let lastStatus = null;
  let lastPhases = null;
  let lastTransfer = null;
  const outcomes = [];
  const phaseSamples = { connectMs: [], uploadMs: [], upstreamMs: [] };

  function remember(ok, phases) {
    outcomes.push(ok);
    if (outcomes.length > RECENT_WINDOW) outcomes.shift();
    if (!phases) return;
    lastPhases = phases;
    for (const key of Object.keys(phaseSamples)) {
      const value = phases[key];
      if (!Number.isFinite(value) || value < 0) continue;
      phaseSamples[key].push(value);
      if (phaseSamples[key].length > RECENT_WINDOW) phaseSamples[key].shift();
    }
  }

  function render() {
    const time = clock();
    const tone = fault ? '33' : '32';
    const statusTone = lastStatus >= 500 ? '31' : '32';
    const phases = lastPhases
      ? `  ${phaseText('連線', lastPhases.connectMs, paint)}  ${phaseText('上傳', lastPhases.uploadMs, paint)}  ${phaseText('上游', lastPhases.upstreamMs, paint)}`
      : '';
    const traffic = lastStatus === null
      ? '轉送 0'
      : `轉送 ${forwarded}  最近 ${paint(statusTone, String(lastStatus))}${phases}`;
    const succeeded = outcomes.filter(Boolean).length;
    const failed = outcomes.length - succeeded;
    const failureTone = failed > 0 ? '31' : '32';
    const timeoutTone = timeouts > 0 ? '31' : '32';
    const medianText = ['連線', '上傳', '上游'].map((label, index) => {
      const key = ['connectMs', 'uploadMs', 'upstreamMs'][index];
      return phaseText(label, median(phaseSamples[key]), paint);
    }).join(' ');
    const running = `${paint(tone, frames[frame % frames.length])} ${paint(tone, '服務運作中')}  ${traffic}  進行中 ${paint('2', String(inflight))}  ${paint('2', time)}`;
    const recent = `近20筆 成功 ${paint('32', String(succeeded))} 失敗 ${paint(failureTone, String(failed))}  中位 ${medianText}  逾時 ${paint(timeoutTone, String(timeouts))}  中斷 ${paint('2', String(aborts))}`;
    frame += 1;
    const transfer = lastTransfer
      ? `  最近串流 首塊 ${lastTransfer.firstByteMs === null ? '—' : formatDuration(lastTransfer.firstByteMs)}  總計 ${lastTransfer.totalMs === null ? '—' : formatDuration(lastTransfer.totalMs)}  ${lastTransfer.totalMs === null ? '傳送中' : lastTransfer.completed ? '完成' : '未完成'}`
      : '';
    const detail = (fault
      ? `${paint('31', '!')} ${paint('31', '最近異常')}  ${fault.message}  ${paint('2', fault.time)}`
      : `${paint('32', '最近異常')}  ${paint('32', '無')}`) + transfer;
    write(`\x1b[3A\x1b[2K${running}\n\x1b[2K${recent}\n\x1b[2K${detail}\n`);
  }

  function noteFault(err) {
    fault = {
      message: String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 120),
      time: clock(),
    };
  }

  function refresh() {
    // 動態模式由定時器統一繪製，避免轉送事件同步寫入終端機。
    if (intervalMs <= 0) render();
  }

  return {
    start() {
      write('\n\n\n');
      render();
      if (intervalMs > 0) {
        timer = setInterval(render, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    begin() {
      inflight += 1;
      refresh();
    },
    record(statusCode, durationMs, phases) {
      forwarded += 1;
      lastStatus = statusCode;
      remember(statusCode < 500, phases);
      if (statusCode < 500) fault = null;
      refresh();
    },
    firstByte(durationMs) {
      lastTransfer = { firstByteMs: durationMs, totalMs: null };
      refresh();
    },
    complete(timing) {
      if (inflight > 0) inflight -= 1;
      lastTransfer = timing;
      refresh();
    },
    disconnect(err, phases) {
      if (inflight > 0) inflight -= 1;
      remember(false, phases);
      noteFault(err);
      refresh();
    },
    timeout(err, phases) {
      timeouts += 1;
      if (inflight > 0) inflight -= 1;
      remember(false, phases);
      noteFault(err);
      refresh();
    },
    abort(pending) {
      aborts += 1;
      if (pending && inflight > 0) inflight -= 1;
      refresh();
    },
    fault(err) {
      noteFault(err);
      refresh();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createLiveStatus, failureScreen, startScreen };

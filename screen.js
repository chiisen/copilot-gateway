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

function speedLabel(durationMs, paint) {
  const slow = durationMs >= SLOW_HEADER_MS;
  const tone = slow ? '33' : '32';
  const pace = slow ? '慢' : '快';
  return `速度 ${paint(tone, pace)} ${formatDuration(durationMs)}`;
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
  let lastDurationMs = null;
  const outcomes = [];
  const durations = [];

  function remember(ok, durationMs) {
    outcomes.push(ok);
    if (outcomes.length > RECENT_WINDOW) outcomes.shift();
    if (Number.isFinite(durationMs) && durationMs >= 0) {
      durations.push(durationMs);
      if (durations.length > RECENT_WINDOW) durations.shift();
    }
  }

  function render() {
    const time = clock();
    const tone = fault ? '33' : '32';
    const statusTone = lastStatus >= 500 ? '31' : '32';
    const speed = lastDurationMs === null ? '' : `  ${speedLabel(lastDurationMs, paint)}`;
    const traffic = lastStatus === null
      ? '轉送 0'
      : `轉送 ${forwarded}  最近 ${paint(statusTone, String(lastStatus))}${speed}`;
    const succeeded = outcomes.filter(Boolean).length;
    const failed = outcomes.length - succeeded;
    const failureTone = failed > 0 ? '31' : '32';
    const timeoutTone = timeouts > 0 ? '31' : '32';
    const headerWait = median(durations);
    const waitText = headerWait === null ? '—' : formatDuration(headerWait);
    const running = `${paint(tone, frames[frame % frames.length])} ${paint(tone, '服務運作中')}  ${traffic}  進行中 ${paint('2', String(inflight))}  ${paint('2', time)}`;
    const recent = `近20筆 成功 ${paint('32', String(succeeded))} 失敗 ${paint(failureTone, String(failed))}  等待中位 ${waitText}  逾時 ${paint(timeoutTone, String(timeouts))}  中斷 ${paint('2', String(aborts))}`;
    frame += 1;
    const detail = fault
      ? `${paint('31', '!')} ${paint('31', '最近異常')}  ${fault.message}  ${paint('2', fault.time)}`
      : `${paint('32', '最近異常')}  ${paint('32', '無')}`;
    write(`\x1b[3A\x1b[2K${running}\n\x1b[2K${recent}\n\x1b[2K${detail}\n`);
  }

  function noteFault(err) {
    fault = {
      message: String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 120),
      time: clock(),
    };
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
      render();
    },
    record(statusCode, durationMs) {
      forwarded += 1;
      if (inflight > 0) inflight -= 1;
      lastStatus = statusCode;
      if (Number.isFinite(durationMs) && durationMs >= 0) lastDurationMs = durationMs;
      remember(statusCode < 500, durationMs);
      if (statusCode < 500) fault = null;
      render();
    },
    disconnect(err) {
      if (inflight > 0) inflight -= 1;
      remember(false);
      noteFault(err);
      render();
    },
    timeout(err) {
      timeouts += 1;
      if (inflight > 0) inflight -= 1;
      remember(false);
      noteFault(err);
      render();
    },
    abort(pending) {
      aborts += 1;
      if (pending && inflight > 0) inflight -= 1;
      render();
    },
    fault(err) {
      noteFault(err);
      render();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createLiveStatus, failureScreen, startScreen };

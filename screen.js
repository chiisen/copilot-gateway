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
  let lastStatus = null;

  function render() {
    const time = clock();
    const tone = fault ? '33' : '32';
    const statusTone = lastStatus >= 500 ? '31' : '32';
    const activity = lastStatus === null
      ? '轉送 0'
      : `轉送 ${forwarded}  最近 ${paint(statusTone, String(lastStatus))}`;
    const running = `${paint(tone, frames[frame % frames.length])} ${paint(tone, '服務運作中')}  ${activity}  ${paint('2', time)}`;
    frame += 1;
    const detail = fault
      ? `${paint('31', '!')} ${paint('31', '最近異常')}  ${fault.message}  ${paint('2', fault.time)}`
      : `${paint('32', '最近異常')}  ${paint('32', '無')}`;
    write(`\x1b[2A\x1b[2K${running}\n\x1b[2K${detail}\n`);
  }

  return {
    start() {
      write('\n\n');
      render();
      if (intervalMs > 0) {
        timer = setInterval(render, intervalMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
    },
    record(statusCode) {
      forwarded += 1;
      lastStatus = statusCode;
      if (statusCode < 500) fault = null;
      render();
    },
    fault(err) {
      fault = {
        message: String(err && err.message ? err.message : err).replace(/\s+/g, ' ').slice(0, 120),
        time: clock(),
      };
      render();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = null;
    },
  };
}

module.exports = { createLiveStatus, failureScreen, startScreen };

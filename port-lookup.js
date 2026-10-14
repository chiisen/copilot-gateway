'use strict';

const { execFileSync } = require('node:child_process');

function parseLsofFields(output) {
  let current = null;
  for (const line of String(output).split('\n')) {
    if (!line) continue;
    const kind = line[0];
    const value = line.slice(1);
    if (kind === 'p') current = { pid: value, command: '' };
    else if (kind === 'c' && current && !current.command) current.command = value;
    if (current && current.command && /^\d+$/.test(current.pid)) return current;
  }
  return null;
}

function parseWindowsListener(output) {
  const line = String(output).trim().split('\n').find((item) => item.trim());
  if (!line) return null;
  const match = line.trim().match(/^(.*) (\d+)$/);
  if (!match || !match[1]) return null;
  return { command: match[1], pid: match[2] };
}

const portListeners = {
  win32(port, execFile) {
    const script = [
      `$c = Get-NetTCPConnection -LocalPort ${port} -State Listen -ErrorAction SilentlyContinue | Select-Object -First 1`,
      'if ($c) { $p = Get-Process -Id $c.OwningProcess -ErrorAction SilentlyContinue; if ($p) { Write-Output ($p.ProcessName + \' \' + $c.OwningProcess) } }',
    ].join('; ');
    return parseWindowsListener(execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 2000,
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  },
  default(port, execFile) {
    return parseLsofFields(execFile('lsof', ['-nP', '-Fpc', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  },
};

function lookupPortListener(port, execFile = execFileSync, platform = process.platform) {
  if (!Number.isInteger(port)) return null;
  const lookup = portListeners[platform] || portListeners.default;
  try {
    return lookup(port, execFile);
  } catch {
    return null;
  }
}

module.exports = { lookupPortListener };

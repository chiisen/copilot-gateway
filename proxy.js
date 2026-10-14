'use strict';

const http = require('node:http');
const https = require('node:https');
const { execFileSync } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const DEFAULT_PORT = 43187;
const sessionID = 'vscode-copilot-' + randomUUID();
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

const hopByHopHeaders = new Set([
  'connection',
  'keep-alive',
  'proxy-authenticate',
  'proxy-authorization',
  'proxy-connection',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
]);

function endToEndHeaders(headers) {
  const filtered = { ...headers };
  const connectionTokens = String(headers.connection || '')
    .split(',')
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean);

  for (const name of new Set([...hopByHopHeaders, ...connectionTokens])) {
    delete filtered[name];
  }
  return filtered;
}

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

function lookupPortListener(port, execFile = execFileSync, platform = process.platform) {
  if (!Number.isInteger(port)) return null;
  try {
    if (platform === 'win32') {
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
    }
    return parseLsofFields(execFile('lsof', ['-nP', '-Fpc', `-iTCP:${port}`, '-sTCP:LISTEN'], {
      encoding: 'utf8',
      timeout: 2000,
      stdio: ['ignore', 'pipe', 'ignore'],
    }));
  } catch {
    return null;
  }
}

function portInUseMessage(port, execFile = execFileSync, platform = process.platform) {
  const listener = lookupPortListener(port, execFile, platform);
  const occupant = listener ? `占用程序：${listener.command}（pid ${listener.pid}）。` : '';
  return `[啟動失敗] 連接埠 ${port} 已被占用。${occupant}請設定 COPILOT_GATEWAY_PORT 改用其他連接埠，或先停止占用該連接埠的程序。`;
}

function createProxy(request = https.request) {
  return http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/healthz') {
      res.writeHead(200, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok' }));
      return;
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...corsHeaders,
        'Access-Control-Allow-Headers': req.headers['access-control-request-headers'] || 'Authorization, Content-Type',
        Vary: 'Origin, Access-Control-Request-Headers, Access-Control-Request-Method',
      });
      res.end();
      return;
    }

    const proxyReq = request({
      hostname: 'opencode.ai',
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        ...endToEndHeaders(req.headers),
        host: 'opencode.ai',
        'x-opencode-session': req.headers['x-opencode-session'] || sessionID,
        'user-agent': req.headers['user-agent'] || 'copilot-gateway/1.0',
      },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { ...endToEndHeaders(proxyRes.headers), ...corsHeaders });
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    });

    proxyReq.on('error', (err) => {
      if (res.destroyed) return;
      console.error('[Proxy 錯誤]:', err.message);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy forwarding failed' }));
    });
    req.on('aborted', () => proxyReq.destroy());
    req.on('error', () => proxyReq.destroy());
    res.on('close', () => {
      if (!res.writableFinished) proxyReq.destroy();
    });
    req.pipe(proxyReq);
  });
}

if (require.main === module) {
  const configuredPort = process.env.COPILOT_GATEWAY_PORT || DEFAULT_PORT;
  const port = Number(configuredPort);
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error('[設定錯誤] COPILOT_GATEWAY_PORT 必須是 1 到 65535 之間的整數。');
    process.exitCode = 1;
  } else {
    const server = createProxy();
    server.on('error', (err) => {
      if (err.code === 'EADDRINUSE') {
        console.error(portInUseMessage(port));
      } else {
        console.error('[啟動失敗]:', err.message);
      }
      process.exitCode = 1;
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(`[Proxy] 本次啟動的備援 Session ID: ${sessionID}`);
      console.log(`API Base: http://127.0.0.1:${port}/zen/go/v1`);
      console.log(`健康檢查: http://127.0.0.1:${port}/healthz`);
    });
  }
}

module.exports = { createProxy, lookupPortListener, portInUseMessage };

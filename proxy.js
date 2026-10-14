'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');
const { lookupPortListener } = require('./port-lookup');
const { createLiveStatus, failureScreen, startScreen } = require('./screen');

const DEFAULT_PORT = 43187;
const DEFAULT_HEADER_TIMEOUT_MS = 60_000;
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

function portInUseMessage(port, execFile, platform) {
  const listener = lookupPortListener(port, execFile, platform);
  const occupant = listener ? `占用程序：${listener.command}（pid ${listener.pid}）。` : '';
  return failureScreen([
    ['原因', `連接埠 ${port} 已被占用。${occupant}`],
    ['下一步', '請設定 COPILOT_GATEWAY_PORT 改用其他連接埠，或先停止占用該連接埠的程序。'],
  ]);
}

function createProxy(request = https.request, options = {}) {
  const headerTimeoutMs = options.headerTimeoutMs ?? DEFAULT_HEADER_TIMEOUT_MS;
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
      if (typeof proxyReq.setTimeout === 'function') proxyReq.setTimeout(0);
      res.writeHead(proxyRes.statusCode, { ...endToEndHeaders(proxyRes.headers), ...corsHeaders });
      if (typeof options.onProxyResult === 'function') options.onProxyResult(proxyRes.statusCode);
      if (proxyRes.statusCode >= 500 && typeof options.onProxyError === 'function') {
        options.onProxyError(new Error(`上游回應 ${proxyRes.statusCode}`));
      }
      proxyRes.on('error', () => res.destroy());
      proxyRes.pipe(res);
    });

    if (headerTimeoutMs > 0 && typeof proxyReq.setTimeout === 'function') {
      proxyReq.setTimeout(headerTimeoutMs, () => proxyReq.destroy());
    }
    proxyReq.on('error', (err) => {
      if (res.destroyed) return;
      if (typeof options.onProxyError === 'function') options.onProxyError(err);
      else console.error('[Proxy 錯誤]:', err.message);
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
    console.error(failureScreen([
      ['原因', 'COPILOT_GATEWAY_PORT 必須是 1 到 65535 之間的整數。'],
      ['下一步', '請改為有效連接埠後重新啟動。'],
    ]));
    process.exitCode = 1;
  } else {
    const live = process.stdout.isTTY
      ? createLiveStatus({ color: !process.env.NO_COLOR })
      : null;
    const server = createProxy(https.request, {
      onProxyResult(statusCode) {
        if (live) live.record(statusCode);
      },
      onProxyError(err) {
        if (live) live.fault(err);
        else console.error('[Proxy 錯誤]:', err.message);
      },
    });
    server.on('error', (err) => {
      if (live) live.stop();
      if (err.code === 'EADDRINUSE') {
        console.error(portInUseMessage(port));
      } else {
        console.error('[啟動失敗]:', err.message);
      }
      process.exitCode = 1;
    });
    process.once('SIGINT', () => {
      if (live) live.stop();
      console.log('已停止');
      process.exit(0);
    });
    server.listen(port, '127.0.0.1', () => {
      console.log(startScreen(port, sessionID));
      if (live) live.start();
    });
  }
}

module.exports = { createProxy, createLiveStatus, lookupPortListener, portInUseMessage };

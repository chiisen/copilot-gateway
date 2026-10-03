'use strict';

const http = require('node:http');
const https = require('node:https');
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
        console.error(`[啟動失敗] 連接埠 ${port} 已被占用。請設定 COPILOT_GATEWAY_PORT 改用其他連接埠，或先停止占用該連接埠的程序。`);
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

module.exports = { createProxy };

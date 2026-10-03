'use strict';

const http = require('node:http');
const https = require('node:https');
const { randomUUID } = require('node:crypto');

const sessionID = 'vscode-copilot-' + randomUUID();
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
};

function createProxy(request = https.request) {
  return http.createServer((req, res) => {
    if (req.method === 'OPTIONS') {
      res.writeHead(204, corsHeaders);
      res.end();
      return;
    }

    const proxyReq = request({
      hostname: 'opencode.ai',
      port: 443,
      path: req.url,
      method: req.method,
      headers: {
        ...req.headers,
        host: 'opencode.ai',
        'x-opencode-session': req.headers['x-opencode-session'] || sessionID,
        'user-agent': req.headers['user-agent'] || 'copilot-gateway/1.0',
      },
    }, (proxyRes) => {
      res.writeHead(proxyRes.statusCode, { ...proxyRes.headers, ...corsHeaders });
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
  const server = createProxy();
  server.on('error', (err) => {
    console.error('[啟動失敗]:', err.message);
    process.exitCode = 1;
  });
  server.listen(43187, '127.0.0.1', () => {
    console.log(`[Proxy] 本次啟動的備援 Session ID: ${sessionID}`);
    console.log('API Base: http://127.0.0.1:43187/zen/go/v1');
  });
}

module.exports = { createProxy };

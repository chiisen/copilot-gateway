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

    const startedAt = Date.now();
    let connectedAt = null;
    let uploadedAt = null;
    let settled = false;
    let headersSeen = false;
    let timedOut = false;
    let firstByteMs = null;
    const markConnected = () => {
      if (connectedAt === null) connectedAt = Date.now();
    };
    const phaseSnapshot = (now = Date.now()) => {
      const connectMs = connectedAt === null ? null : connectedAt - startedAt;
      if (connectedAt === null) return { connectMs, uploadMs: null, upstreamMs: null };
      if (uploadedAt === null) {
        return { connectMs, uploadMs: Math.max(0, now - connectedAt), upstreamMs: null };
      }
      return {
        connectMs,
        uploadMs: Math.max(0, uploadedAt - connectedAt),
        upstreamMs: Math.max(0, now - uploadedAt),
      };
    };
    const settle = () => {
      if (settled) return false;
      settled = true;
      return true;
    };
    if (typeof options.onProxyStart === 'function') options.onProxyStart();
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
      headersSeen = true;
      settle();
      if (typeof proxyReq.setTimeout === 'function') proxyReq.setTimeout(0);
      res.writeHead(proxyRes.statusCode, { ...endToEndHeaders(proxyRes.headers), ...corsHeaders });
      res.flushHeaders();
      if (typeof options.onProxyResult === 'function') {
        options.onProxyResult(proxyRes.statusCode, Date.now() - startedAt, phaseSnapshot());
      }
      if (proxyRes.statusCode >= 500 && typeof options.onProxyError === 'function') {
        options.onProxyError(new Error(`上游回應 ${proxyRes.statusCode}`), 'status');
      }
      proxyRes.on('error', () => res.destroy());
      proxyRes.once('data', () => {
        firstByteMs = Date.now() - startedAt;
        if (typeof options.onFirstByte === 'function') options.onFirstByte(firstByteMs);
      });
      proxyRes.pipe(res);
    });

    if (headerTimeoutMs > 0 && typeof proxyReq.setTimeout === 'function') {
      proxyReq.setTimeout(headerTimeoutMs, () => {
        timedOut = true;
        proxyReq.destroy();
      });
    }
    proxyReq.on('error', (err) => {
      const pending = !headersSeen && settle();
      const clientAlreadyLeft = !headersSeen && !pending;
      if (!clientAlreadyLeft && pending && timedOut && typeof options.onHeaderTimeout === 'function') {
        options.onHeaderTimeout(new Error('上游標頭逾時'), phaseSnapshot());
      } else if (!clientAlreadyLeft && typeof options.onProxyError === 'function') {
        options.onProxyError(err, pending ? 'connect' : 'late', phaseSnapshot());
      } else if (!clientAlreadyLeft) console.error('[Proxy 錯誤]:', err.message);
      if (res.destroyed || clientAlreadyLeft) return;
      if (res.headersSent) {
        res.destroy();
        return;
      }
      res.writeHead(502, { ...corsHeaders, 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy forwarding failed' }));
    });
    req.on('aborted', () => {
      const pending = !headersSeen && settle();
      if (typeof options.onClientAbort === 'function') options.onClientAbort(pending);
      proxyReq.destroy();
    });
    req.on('error', () => proxyReq.destroy());
    proxyReq.on('socket', (socket) => {
      if (socket.encrypted) {
        if (socket.authorized) markConnected();
        else socket.once('secureConnect', markConnected);
        return;
      }
      if (socket.connecting) socket.once('connect', markConnected);
      else markConnected();
    });
    proxyReq.on('finish', () => {
      if (uploadedAt === null) uploadedAt = Date.now();
    });
    res.on('close', () => {
      if (!res.writableFinished) proxyReq.destroy();
      if (headersSeen && typeof options.onTransferComplete === 'function') {
        options.onTransferComplete({
          firstByteMs,
          totalMs: Date.now() - startedAt,
          completed: res.writableFinished,
        });
      }
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
    const live = process.stdout.isTTY && process.env.COPILOT_GATEWAY_LIVE_STATUS !== '0'
      ? createLiveStatus({ color: !process.env.NO_COLOR })
      : null;
    const server = createProxy(https.request, {
      onProxyStart() {
        if (live) live.begin();
      },
      onProxyResult(statusCode, durationMs, phases) {
        if (live) live.record(statusCode, durationMs, phases);
      },
      onFirstByte(durationMs) {
        if (live) live.firstByte(durationMs);
      },
      onTransferComplete(timing) {
        if (live) live.complete(timing);
      },
      onHeaderTimeout(err, phases) {
        if (live) live.timeout(err, phases);
        else console.error('[Proxy 錯誤]:', err.message);
      },
      onClientAbort(pending) {
        if (live) live.abort(pending);
      },
      onProxyError(err, reason, phases) {
        if (!live) {
          console.error('[Proxy 錯誤]:', err.message);
          return;
        }
        if (reason === 'connect') live.disconnect(err, phases);
        else live.fault(err);
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

'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createProxy } = require('./proxy');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

test('補入穩定 Session、保留既有標頭並轉發串流', async () => {
  const received = [];
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      received.push({ headers: req.headers, path: req.url, body });
      res.writeHead(201, { 'Content-Type': 'text/event-stream' });
      res.write('data: hello\n\n');
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise((resolve) => upstream.listen(0, '127.0.0.1', resolve));
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback));
  await new Promise((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const url = `http://127.0.0.1:${proxy.address().port}/zen/go/v1/chat/completions`;
  try {
    for (const headers of [{}, {}, { 'x-opencode-session': 'conversation-123' }]) {
      const response = await fetch(url, {
        method: 'POST', headers: { ...headers, Authorization: 'Bearer test-only' }, body: '{"stream":true}',
      });
      assert.equal(response.status, 201);
      assert.equal(await response.text(), 'data: hello\n\ndata: [DONE]\n\n');
    }
    assert.match(received[0].headers['x-opencode-session'], /^vscode-copilot-/);
    assert.equal(received[0].headers['x-opencode-session'], received[1].headers['x-opencode-session']);
    assert.equal(received[2].headers['x-opencode-session'], 'conversation-123');
    assert.equal(received[0].headers.host, 'opencode.ai');
    assert.equal(received[0].headers.authorization, 'Bearer test-only');
    assert.equal(received[0].path, '/zen/go/v1/chat/completions');
    assert.equal(received[0].body, '{"stream":true}');
    assert.equal((await fetch(url, { method: 'OPTIONS' })).status, 204);
    assert.equal(received.length, 3);
  } finally {
    await Promise.all([new Promise((resolve) => proxy.close(resolve)), new Promise((resolve) => upstream.close(resolve))]);
  }
});

test('健康檢查與 CORS 預檢不會轉送至上游', async () => {
  let forwarded = false;
  const proxy = createProxy(() => {
    forwarded = true;
    throw new Error('不應轉送健康檢查或預檢請求');
  });
  await listen(proxy);
  const baseURL = `http://127.0.0.1:${proxy.address().port}`;
  try {
    const health = await fetch(`${baseURL}/healthz`);
    assert.equal(health.status, 200);
    assert.deepEqual(await health.json(), { status: 'ok' });

    const preflight = await fetch(`${baseURL}/zen/go/v1/chat/completions`, {
      method: 'OPTIONS',
      headers: {
        Origin: 'vscode-webview://test',
        'Access-Control-Request-Method': 'POST',
        'Access-Control-Request-Headers': 'authorization, content-type, x-opencode-session',
      },
    });
    assert.equal(preflight.status, 204);
    assert.equal(preflight.headers.get('access-control-allow-headers'), 'authorization, content-type, x-opencode-session');
    assert.match(preflight.headers.get('vary'), /Access-Control-Request-Headers/i);
    assert.equal(forwarded, false);
  } finally {
    await close(proxy);
  }
});

test('逐跳標頭及 Connection 指定標頭不會跨越代理轉送', async () => {
  let forwardedHeaders;
  const upstream = http.createServer((req, res) => {
    forwardedHeaders = req.headers;
    res.writeHead(200, {
      Connection: 'keep-alive, X-Private-Response',
      'X-Private-Response': 'secret',
      'Content-Type': 'text/plain',
    });
    res.end('ok');
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback));
  await listen(proxy);
  try {
    const result = await new Promise((resolve, reject) => {
      const request = http.request({
        hostname: '127.0.0.1',
        port: proxy.address().port,
        path: '/test',
        method: 'POST',
        headers: {
          Connection: 'keep-alive, X-Private-Request',
          'X-Private-Request': 'secret',
        },
      }, (response) => {
        let body = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => { body += chunk; });
        response.on('end', () => resolve({ status: response.statusCode, headers: response.headers, body }));
      });
      request.on('error', reject);
      request.end('payload');
    });
    assert.equal(result.status, 200);
    assert.equal(result.body, 'ok');
    assert.equal(forwardedHeaders['x-private-request'], undefined);
    assert.equal(result.headers['x-private-response'], undefined);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('上游連線失敗時回傳 502 JSON', async () => {
  const unavailable = http.createServer();
  await listen(unavailable);
  const port = unavailable.address().port;
  await close(unavailable);

  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port,
  }, callback));
  await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/test`, {
      method: 'POST', body: 'payload',
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Proxy forwarding failed' });
  } finally {
    await close(proxy);
  }
});

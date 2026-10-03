'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { createProxy } = require('./proxy');

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
}

function close(server) {
  return new Promise((resolve) => server.close(resolve));
}

function launchProxy(port) {
  const child = spawn(process.execPath, [require.resolve('./proxy')], {
    env: { ...process.env, COPILOT_GATEWAY_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk; });
  child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk; });
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout: () => stdout, stderr: () => stderr }));
  });
  return { child, exited, stdout: () => stdout, stderr: () => stderr };
}

function waitForOutput(processHandle, text) {
  if (processHandle.stdout().includes(text)) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onData = () => {
      if (!processHandle.stdout().includes(text)) return;
      processHandle.child.stdout.off('data', onData);
      resolve();
    };
    processHandle.child.stdout.on('data', onData);
    processHandle.child.once('close', () => reject(new Error(`Proxy terminated before output: ${text}`)));
  });
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

test('拒絕超出範圍或非整數的連接埠設定', async () => {
  const processHandle = launchProxy('not-a-port');
  const result = await processHandle.exited;
  assert.equal(result.code, 1);
  assert.match(result.stderr(), /COPILOT_GATEWAY_PORT 必須是 1 到 65535 之間的整數/);
});

test('連接埠被占用時顯示可操作的錯誤', async () => {
  const occupied = http.createServer();
  await listen(occupied);
  const processHandle = launchProxy(occupied.address().port);
  try {
    const result = await processHandle.exited;
    assert.equal(result.code, 1);
    assert.match(result.stderr(), /連接埠 .* 已被占用/);
    assert.match(result.stderr(), /COPILOT_GATEWAY_PORT/);
  } finally {
    await close(occupied);
  }
});

test('使用指定連接埠啟動並印出 API 與健康檢查網址', async () => {
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);

  const processHandle = launchProxy(port);
  try {
    await waitForOutput(processHandle, `健康檢查: http://127.0.0.1:${port}/healthz`);
    assert.match(processHandle.stdout(), new RegExp(`API Base: http://127\\.0\\.0\\.1:${port}/zen/go/v1`));
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    processHandle.child.kill();
    await processHandle.exited;
  }
});

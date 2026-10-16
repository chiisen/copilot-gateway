'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { PassThrough } = require('node:stream');
const { createProxy, createLiveStatus, lookupPortListener, portInUseMessage } = require('./proxy');

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

test('上游在標頭逾時前未回應時回傳 502', async () => {
  let destroyed = false;
  const upstream = http.createServer((req) => {
    req.on('close', () => { destroyed = true; });
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback), { headerTimeoutMs: 50 });
  await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/test`, {
      method: 'POST', body: 'payload',
    });
    assert.equal(response.status, 502);
    assert.deepEqual(await response.json(), { error: 'Proxy forwarding failed' });
    assert.equal(destroyed, true);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('收到上游標頭後的串流不受標頭逾時限制', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.flushHeaders();
    setTimeout(() => res.end('late'), 120);
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback), { headerTimeoutMs: 40 });
  await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/test`, {
      method: 'POST', body: 'payload',
    });
    assert.equal(response.status, 200);
    assert.equal(await response.text(), 'late');
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

test('Windows 連接埠占用時解析程序名稱與 pid', () => {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    return 'Code - Insiders 4321\r\n';
  };
  assert.deepEqual(lookupPortListener(43187, execFile, 'win32'), {
    command: 'Code - Insiders',
    pid: '4321',
  });
  assert.equal(calls[0].command, 'powershell.exe');
  assert.match(calls[0].args.at(-1), /LocalPort 43187/);
  assert.equal(calls[0].options.timeout, 2000);
  assert.match(portInUseMessage(43187, execFile, 'win32'), /占用程序：Code - Insiders（pid 4321）/);

  const fallback = portInUseMessage(43187, () => {
    throw new Error('powershell unavailable');
  }, 'win32');
  assert.match(fallback, /連接埠 43187 已被占用/);
  assert.match(fallback, /COPILOT_GATEWAY_PORT/);
  assert.equal(fallback.includes('占用程序'), false);
});

test('lsof 欄位輸出保留完整程序名稱並在逾時時退回一般提示', () => {
  const calls = [];
  const execFile = (command, args, options) => {
    calls.push({ command, args, options });
    return 'p4242\nccom.docker.backend\n';
  };
  assert.deepEqual(lookupPortListener(43187, execFile, 'darwin'), {
    command: 'com.docker.backend',
    pid: '4242',
  });
  assert.deepEqual(calls[0].args.slice(0, 2), ['-nP', '-Fpc']);
  assert.equal(calls[0].options.timeout, 2000);
  assert.match(portInUseMessage(43187, execFile, 'darwin'), /占用程序：com\.docker\.backend（pid 4242）/);

  const timedOut = portInUseMessage(43187, () => {
    const error = new Error('spawn lsof ETIMEDOUT');
    error.killed = true;
    throw error;
  }, 'linux');
  assert.match(timedOut, /連接埠 43187 已被占用/);
  assert.match(timedOut, /COPILOT_GATEWAY_PORT/);
  assert.equal(timedOut.includes('占用程序'), false);

  assert.equal(lookupPortListener(43187, () => 'pabc\ncnode\n', 'linux'), null);
});

test('連接埠被占用時顯示可操作的錯誤', async () => {
  const occupied = http.createServer();
  await listen(occupied);
  const processHandle = launchProxy(occupied.address().port);
  try {
    const result = await processHandle.exited;
    assert.equal(result.code, 1);
    assert.match(result.stderr(), new RegExp(`連接埠 ${occupied.address().port} 已被占用`));
    assert.match(result.stderr(), new RegExp(`pid ${process.pid}`));
    assert.match(result.stderr(), /COPILOT_GATEWAY_PORT/);
  } finally {
    await close(occupied);
  }
});

test('運作動畫保持服務狀態並立即顯示異常', () => {
  const frames = [];
  const status = createLiveStatus({
    write: (text) => frames.push(text),
    color: false,
    intervalMs: 0,
    clock: () => '12:00:00',
  });
  status.start();
  assert.match(frames.at(-1), /服務運作中\s+轉送 0\s+進行中 0\s+12:00:00/);
  assert.match(frames.at(-1), /近20筆\s+成功 0\s+失敗 0\s+中位 連線 — 上傳 — 上游 —\s+逾時 0\s+中斷 0/);
  assert.match(frames.at(-1), /最近異常\s+無/);
  status.begin();
  assert.match(frames.at(-1), /進行中 1/);
  status.fault(new Error('socket hang up'));
  assert.match(frames.at(-1), /最近異常\s+socket hang up\s+12:00:00/);
  assert.match(frames.at(-1), /轉送 0/);
  assert.match(frames.at(-1), /失敗 0/);
  status.record(201);
  assert.match(frames.at(-1), /轉送 1\s+最近 201/);
  assert.match(frames.at(-1), /進行中 1/);
  status.complete({ firstByteMs: 10, totalMs: 20, completed: true });
  assert.match(frames.at(-1), /進行中 0/);
  assert.match(frames.at(-1), /成功 1\s+失敗 0/);
  assert.match(frames.at(-1), /最近異常\s+無/);
  status.begin();
  status.record(502);
  status.complete({ firstByteMs: 10, totalMs: 20, completed: true });
  status.fault(new Error('上游回應 502'));
  assert.match(frames.at(-1), /最近異常\s+上游回應 502/);
  assert.match(frames.at(-1), /成功 1\s+失敗 1/);
  status.record(200, 180, { connectMs: 20, uploadMs: 30, upstreamMs: 130 });
  assert.match(frames.at(-1), /轉送 3\s+最近 200\s+連線 20ms\s+上傳 30ms\s+上游 130ms/);
  assert.match(frames.at(-1), /成功 2\s+失敗 1/);
  assert.match(frames.at(-1), /中位 連線 20ms 上傳 30ms 上游 130ms/);
  assert.match(frames.at(-1), /最近異常\s+無/);
  status.record(200, 2500, { connectMs: 40, uploadMs: 60, upstreamMs: 2400 });
  assert.match(frames.at(-1), /轉送 4\s+最近 200\s+連線 40ms\s+上傳 60ms\s+上游 慢 2\.4s/);
  assert.match(frames.at(-1), /中位 連線 30ms 上傳 45ms 上游 1\.3s/);
  status.begin();
  status.timeout(new Error('上游標頭逾時'));
  assert.match(frames.at(-1), /逾時 1/);
  assert.match(frames.at(-1), /成功 3\s+失敗 2/);
  assert.match(frames.at(-1), /進行中 0/);
  assert.match(frames.at(-1), /最近異常\s+上游標頭逾時/);
  status.begin();
  status.abort(true);
  assert.match(frames.at(-1), /中斷 1/);
  assert.match(frames.at(-1), /進行中 0/);
  assert.match(frames.at(-1), /失敗 2/);
  status.abort(false);
  assert.match(frames.at(-1), /中斷 2/);
  status.stop();

  const colored = [];
  const coloredStatus = createLiveStatus({
    write: (text) => colored.push(text),
    color: true,
    intervalMs: 0,
    clock: () => '12:00:00',
  });
  coloredStatus.start();
  assert.match(colored.at(-1), /\x1b\[32m服務運作中/);
  coloredStatus.fault(new Error('socket hang up'));
  assert.match(colored.at(-1), /\x1b\[33m服務運作中/);
  assert.match(colored.at(-1), /\x1b\[31m最近異常/);
  coloredStatus.record(201);
  assert.match(colored.at(-1), /\x1b\[32m201/);
  coloredStatus.record(503);
  assert.match(colored.at(-1), /\x1b\[31m503/);
  coloredStatus.record(200, 180, { connectMs: 20, uploadMs: 30, upstreamMs: 130 });
  assert.match(colored.at(-1), /\x1b\[32m20ms/);
  coloredStatus.record(200, 2500, { connectMs: 40, uploadMs: 60, upstreamMs: 2400 });
  assert.match(colored.at(-1), /\x1b\[33m慢 2\.4s/);
  coloredStatus.stop();
});

test('健康檢查不計入轉送，上游回應才回報狀態碼', async () => {
  const results = [];
  const durations = [];
  const phases = [];
  const upstream = http.createServer((req, res) => {
    res.writeHead(201, { 'Content-Type': 'text/plain' });
    res.end('ok');
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback), { onProxyResult: (statusCode, durationMs, timing) => {
    results.push(statusCode);
    durations.push(durationMs);
    phases.push(timing);
  } });
  await listen(proxy);
  const baseURL = `http://127.0.0.1:${proxy.address().port}`;
  try {
    assert.equal((await fetch(`${baseURL}/healthz`)).status, 200);
    assert.equal((await fetch(`${baseURL}/zen/go/v1/chat/completions`, { method: 'OPTIONS' })).status, 204);
    assert.equal((await fetch(`${baseURL}/test`, { method: 'POST', body: 'payload' })).status, 201);
    assert.deepEqual(results, [201]);
    assert.equal(durations.length, 1);
    assert.equal(Number.isFinite(durations[0]) && durations[0] >= 0, true);
    assert.equal(Number.isFinite(phases[0].connectMs) && phases[0].connectMs >= 0, true);
    assert.equal(Number.isFinite(phases[0].uploadMs) && phases[0].uploadMs >= 0, true);
    assert.equal(Number.isFinite(phases[0].upstreamMs) && phases[0].upstreamMs >= 0, true);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('Ctrl+C 顯示已停止', async () => {
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);
  const processHandle = launchProxy(port);
  try {
    await waitForOutput(processHandle, `http://127.0.0.1:${port}/healthz`);
    processHandle.child.kill('SIGINT');
    const result = await processHandle.exited;
    assert.equal(result.code, 0);
    assert.match(result.stdout(), /已停止/);
  } finally {
    processHandle.child.kill();
  }
});

test('使用指定連接埠啟動並印出 API 與健康檢查網址', async () => {
  const reservation = http.createServer();
  await listen(reservation);
  const port = reservation.address().port;
  await close(reservation);

  const processHandle = launchProxy(port);
  try {
    await waitForOutput(processHandle, `http://127.0.0.1:${port}/healthz`);
    assert.match(processHandle.stdout(), /copilot-gateway/);
    assert.match(processHandle.stdout(), new RegExp(`http://127\\.0\\.0\\.1:${port}/zen/go/v1`));
    assert.match(processHandle.stdout(), /Session\s+vscode-copilot-/);
    assert.equal(processHandle.stdout().includes('\x1b['), false);
    const response = await fetch(`http://127.0.0.1:${port}/healthz`);
    assert.equal(response.status, 200);
  } finally {
    processHandle.child.kill();
    await processHandle.exited;
  }
});

test('客戶端中止上傳時取消上游請求', async () => {
  let resolveUpstreamAborted;
  const upstreamAborted = new Promise((resolve) => { resolveUpstreamAborted = resolve; });
  let resolveUpstreamReceivedBody;
  const upstreamReceivedBody = new Promise((resolve) => { resolveUpstreamReceivedBody = resolve; });
  const upstream = http.createServer((req) => {
    req.once('data', () => resolveUpstreamReceivedBody());
    req.once('aborted', resolveUpstreamAborted);
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback));
  await listen(proxy);
  const clientRequest = http.request({
    hostname: '127.0.0.1',
    port: proxy.address().port,
    method: 'POST',
    headers: { 'Content-Length': '100' },
  });
  clientRequest.on('error', () => {});
  try {
    clientRequest.write('partial');
    await upstreamReceivedBody;
    clientRequest.destroy();
    await Promise.race([
      upstreamAborted,
      new Promise((_, reject) => setTimeout(() => reject(new Error('上游請求未被取消')), 1000)),
    ]);
  } finally {
    clientRequest.destroy();
    await Promise.all([close(proxy), close(upstream)]);
  }
});

function collectStream(url) {
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    let firstByteMs = null;
    let chunks = 0;
    let bytes = 0;
    http.get(url, (res) => {
      res.on('data', (chunk) => {
        if (firstByteMs === null) firstByteMs = Date.now() - startedAt;
        chunks += 1;
        bytes += chunk.length;
      });
      res.on('end', () => resolve({
        firstByteMs,
        totalMs: Date.now() - startedAt,
        chunks,
        bytes,
      }));
    }).on('error', reject);
  });
}

test('動態狀態列合併請求更新，不在轉送事件內同步寫入', async () => {
  const frames = [];
  let rendered;
  const status = createLiveStatus({ write: (text) => { frames.push(text); rendered?.(); }, intervalMs: 20 });
  status.start();
  const nextFrame = new Promise((resolve) => { rendered = resolve; });
  const initialCount = frames.length;
  const keepAlive = setTimeout(() => rendered(), 1000);
  try {
    status.begin();
    status.record(200);
    assert.equal(frames.length, initialCount);
    await nextFrame;
    assert.match(frames.at(-1), /轉送 1/);
  } finally {
    clearTimeout(keepAlive);
    status.stop();
  }
});

for (const mode of ['empty', 'abort']) {
  test(`串流 ${mode} 結束僅回報一次且不誤判完成`, async () => {
    let upstreamResponse;
    const timings = [];
    let transferClosed;
    const closed = new Promise((resolve) => { transferClosed = resolve; });
    const upstream = http.createServer((req, res) => {
      req.resume();
      upstreamResponse = res;
      res.writeHead(200);
      if (mode === 'empty') res.end();
      else { res.flushHeaders(); res.write('partial'); }
    });
    await listen(upstream);
    const proxy = createProxy((options, callback) => http.request({
      ...options, hostname: '127.0.0.1', port: upstream.address().port,
    }, callback), {
      onTransferComplete: (timing) => { timings.push(timing); transferClosed(); },
    });
    await listen(proxy);
    let client;
    try {
      await new Promise((resolve, reject) => {
        client = http.get(`http://127.0.0.1:${proxy.address().port}/stream`, (res) => {
          res.on('data', () => { if (mode === 'abort') res.destroy(); });
          res.on('close', resolve);
        });
        client.on('error', reject);
      });
      await closed;
      assert.equal(timings.length, 1);
      assert.equal(timings[0].completed, mode === 'empty');
      if (mode === 'empty') assert.equal(timings[0].firstByteMs, null);
      else assert.ok(Number.isFinite(timings[0].firstByteMs));
    } finally {
      client?.destroy();
      upstreamResponse?.destroy();
      await Promise.all([close(proxy), close(upstream)]);
    }
  });
}

test('標頭立即轉送，首塊及完成時間分開記錄，串流期間保留進行中', async () => {
  let upstreamResponse;
  const timings = [];
  const firstBytes = [];
  const frames = [];
  const live = createLiveStatus({ write: (text) => frames.push(text), intervalMs: 0 });
  const upstream = http.createServer((req, res) => {
    req.resume();
    upstreamResponse = res;
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.flushHeaders();
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback), {
    onProxyStart: () => live.begin(),
    onProxyResult: (...args) => live.record(...args),
    onFirstByte: (ms) => { firstBytes.push(ms); live.firstByte(ms); },
    onTransferComplete: (timing) => { timings.push(timing); live.complete(timing); },
  });
  await listen(proxy);
  let client;
  try {
    const response = await new Promise((resolve, reject) => {
      client = http.get(`http://127.0.0.1:${proxy.address().port}/stream`, resolve);
      client.on('error', reject);
      client.setTimeout(500, () => client.destroy(new Error('標頭未立即轉送')));
    });
    assert.deepEqual(firstBytes, []);
    assert.deepEqual(timings, []);
    assert.match(frames.at(-1), /進行中 1/);
    const firstChunk = new Promise((resolve) => response.once('data', resolve));
    upstreamResponse.write('data: first\n\n');
    await firstChunk;
    assert.equal(firstBytes.length, 1);
    assert.equal(timings.length, 0);
    const ended = new Promise((resolve) => response.once('end', resolve));
    upstreamResponse.end('data: last\n\n');
    await ended;
    assert.equal(timings.length, 1);
    assert.equal(timings[0].completed, true);
    assert.equal(timings[0].firstByteMs, firstBytes[0]);
    assert.ok(timings[0].totalMs >= firstBytes[0]);
    assert.match(frames.at(-1), /進行中 0/);
    assert.match(frames.at(-1), /首塊.*總計.*完成/);
  } finally {
    client?.destroy();
    upstreamResponse?.destroy();
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('本機串流經過代理的額外延遲維持在小範圍', async () => {
  const chunkCount = 40;
  const intervalMs = 15;
  const upstream = http.createServer((req, res) => {
    req.resume();
    res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    let sent = 0;
    const timer = setInterval(() => {
      res.write(`data: ${String(sent).padStart(16, '0')}\n\n`);
      sent += 1;
      if (sent === chunkCount) {
        clearInterval(timer);
        res.end();
      }
    }, intervalMs);
    res.on('close', () => clearInterval(timer));
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback));
  await listen(proxy);
  try {
    const direct = await collectStream(`http://127.0.0.1:${upstream.address().port}/stream`);
    const viaProxy = await collectStream(`http://127.0.0.1:${proxy.address().port}/stream`);
    const detail = `直連首塊 ${direct.firstByteMs}ms、總計 ${direct.totalMs}ms、${direct.chunks} 塊；代理首塊 ${viaProxy.firstByteMs}ms、總計 ${viaProxy.totalMs}ms、${viaProxy.chunks} 塊`;
    assert.equal(viaProxy.bytes, direct.bytes, detail);
    assert.equal(viaProxy.chunks, direct.chunks, detail);
    assert.ok(viaProxy.firstByteMs - direct.firstByteMs < 80, detail);
    assert.ok(viaProxy.totalMs - direct.totalMs < 150, detail);
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('上游送出標頭後斷線時關閉下游串流', async () => {
  const upstream = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Length': '100', 'Content-Type': 'text/plain' });
    res.write('partial');
    setTimeout(() => res.socket.destroy(), 20);
  });
  await listen(upstream);
  const proxy = createProxy((options, callback) => http.request({
    ...options, hostname: '127.0.0.1', port: upstream.address().port,
  }, callback));
  await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/test`, { method: 'POST', body: 'payload' });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
  } finally {
    await Promise.all([close(proxy), close(upstream)]);
  }
});

test('下游已收到上游標頭後代理請求出錯時直接關閉回應', async () => {
  const proxy = createProxy((options, callback) => {
    const proxyRequest = new PassThrough();
    setImmediate(() => {
      const proxyResponse = new PassThrough();
      proxyResponse.statusCode = 200;
      proxyResponse.headers = { 'Content-Type': 'text/plain' };
      callback(proxyResponse);
      proxyResponse.write('partial');
      setTimeout(() => proxyRequest.emit('error', new Error('simulated late upstream error')), 20);
    });
    return proxyRequest;
  });
  await listen(proxy);
  try {
    const response = await fetch(`http://127.0.0.1:${proxy.address().port}/test`, {
      method: 'POST', body: 'payload',
    });
    assert.equal(response.status, 200);
    await assert.rejects(response.text());
  } finally {
    await close(proxy);
  }
});

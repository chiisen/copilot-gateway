'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const { createProxy } = require('./proxy');

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

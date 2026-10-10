import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs/promises';
import path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import * as zlib from 'node:zlib';
import { createScope, ROOT } from '../src/main.mjs';
import { WebSocketInspector } from '../src/ws_inspector.mjs';

async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function waitFor(condition, timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (!condition()) { if (Date.now() > deadline) throw new Error('test timeout'); await new Promise(resolve => setTimeout(resolve, 15)); }
}
async function fixture(t, settings = {}, responseFn = null, options = {}) {
  const captures = [], sockets = new Set();
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    captures.push({ headers: req.headers, url: req.url, body: Buffer.concat(chunks) });
    if (responseFn) return responseFn(req, res, captures.at(-1));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-returned', reasoning: { effort: 'high' },
      usage: { output_tokens_details: { reasoning_tokens: 0 } }, output: [{ text: 'ANSWER_SECRET_MUST_NOT_PERSIST' }] }));
  });
  upstream.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  upstream.listen(0, '127.0.0.1'); await once(upstream, 'listening');
  const upstreamPort = upstream.address().port;
  const proxy_port = await freePort(), dashboard_port = await freePort();
  await fs.mkdir(path.join(ROOT, 'test-output'), { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(ROOT, 'test-output', 'proxy-fixture-'));
  const actions = [];
  const scope = await createScope({ dataDir, readOnly: options.readOnly, settings: { proxy_port, dashboard_port, ...settings },
    bridge: async action => {
      actions.push(action);
      if (action === 'restore') return { restored: 0, skipped: 0 };
      return { upstream_port: upstreamPort, attached: Boolean(options.recoveryPending && !actions.includes('restore')), fields: [],
        recovery_pending: Boolean(options.recoveryPending && !actions.includes('restore')),
        database: { available: true, providers: [] }, aliases: {} };
    } });
  t.after(async () => {
    await scope.close(); for (const socket of sockets) socket.destroy();
    await new Promise(resolve => upstream.close(resolve));
    const intended = path.resolve(ROOT, 'test-output');
    if (!path.resolve(dataDir).startsWith(intended + path.sep)) throw new Error('unsafe fixture cleanup');
    await fs.rm(dataDir, { recursive: true, force: true });
  });
  return { scope, upstream, captures, actions, dataDir, proxy_port, dashboard_port, upstreamPort };
}
function request(port, { method = 'POST', url = '/v1/responses', body, headers = {} } = {}) {
  const data = body ?? Buffer.from(JSON.stringify({ model: 'route-a/gpt-requested', reasoning: { effort: 'high' },
    input: 'PROMPT_SECRET_MUST_NOT_PERSIST' }));
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path: url, headers: {
      'Content-Type': 'application/json', 'Content-Length': data.length,
      Authorization: 'Bearer AUTH_SECRET_MUST_NOT_PERSIST', ...headers
    } }, res => {
      const chunks = []; res.on('data', c => chunks.push(c)); res.on('end', () => resolve({
        status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks)
      })); res.on('error', reject);
    });
    req.on('error', reject); req.end(data);
  });
}
function frame(obj, { masked = false, compressed = false } = {}) {
  const data = Buffer.from(typeof obj === 'string' ? obj : JSON.stringify(obj));
  const head = Buffer.alloc(data.length < 126 ? 2 : 4);
  head[0] = 129 | (compressed ? 64 : 0); head[1] = (masked ? 128 : 0) | (data.length < 126 ? data.length : 126);
  if (data.length >= 126) head.writeUInt16BE(data.length, 2);
  if (!masked) return Buffer.concat([head, data]);
  const mask = Buffer.from([9, 8, 7, 6]), payload = Buffer.from(data);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([head, mask, payload]);
}
function mockWebSocket(upstream, onMessage) {
  const incoming = [], outgoing = [];
  upstream.on('upgrade', (req, socket, head) => {
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write(`HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`);
    const send = obj => { const data = frame(obj); outgoing.push(data); socket.write(data); };
    const observer = new WebSocketInspector(obj => onMessage(obj, send), () => {});
    if (head.length) { incoming.push(head); observer.feed(head); }
    socket.on('data', c => { incoming.push(Buffer.from(c)); observer.feed(c); });
    socket.on('error', () => {});
  });
  return { incoming, outgoing };
}
async function rawWebSocket(port) {
  const socket = net.createConnection({ host: '127.0.0.1', port }); await once(socket, 'connect');
  const received = [], messages = [], observer = new WebSocketInspector(obj => messages.push(obj), () => {});
  let handshake = Buffer.alloc(0), ready = false, markReady;
  const readyPromise = new Promise(resolve => { markReady = resolve; });
  socket.on('data', c => {
    if (!ready) {
      handshake = Buffer.concat([handshake, c]); const end = handshake.indexOf('\r\n\r\n');
      if (end < 0) return;
      assert.match(handshake.subarray(0, end).toString(), /^HTTP\/1.1 101/);
      c = handshake.subarray(end + 4); ready = true; markReady();
    }
    if (c.length) { received.push(Buffer.from(c)); observer.feed(c); }
  });
  socket.on('error', () => {});
  socket.write(`GET /v1/responses HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Key: ZmFrZS1rZXktMTIzNDU2Nw==\r\nSec-WebSocket-Version: 13\r\n\r\n`);
  await Promise.race([readyPromise, new Promise((_, reject) => setTimeout(() => reject(new Error('WS handshake timeout')), 3000))]);
  return { socket, received, messages };
}

test('HTTP forwards request/response body bytes and auth while persisting metadata only', async t => {
  const f = await fixture(t), result = await request(f.proxy_port);
  await waitFor(() => f.scope.store.records[0]?.ended); await f.scope.store.flush();
  assert.equal(result.status, 200); assert.equal(f.captures.length, 1);
  assert.equal(f.captures[0].headers.authorization, 'Bearer AUTH_SECRET_MUST_NOT_PERSIST');
  assert.ok(f.captures[0].body.toString().includes('PROMPT_SECRET_MUST_NOT_PERSIST'));
  assert.ok(result.body.toString().includes('ANSWER_SECRET_MUST_NOT_PERSIST'));
  const saved = await fs.readFile(path.join(f.dataDir, 'records.json'), 'utf8');
  for (const secret of ['AUTH_SECRET', 'PROMPT_SECRET', 'ANSWER_SECRET']) assert.ok(!saved.includes(secret));
  const record = f.scope.store.records[0]; assert.equal(record.verdict, 'match');
  assert.equal(record.final.model.value, 'gpt-returned'); assert.equal(record.final.reasoning_tokens, 0);
});

test('SSE is delivered incrementally and its complete byte content is unchanged', async t => {
  const chunks = [Buffer.from('data: {"type":"response.created","response":{"reasoning":{"effort":"high"}}}\n\n'),
    Buffer.from('data: {"type":"response.completed","response":{"reasoning":{"effort":"low"},"status":"completed"}}\n\n')];
  const f = await fixture(t, {}, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(chunks[0]); setTimeout(() => res.end(chunks[1]), 80); });
  const responsePromise = request(f.proxy_port);
  await waitFor(() => f.scope.store.records[0]?.first);
  assert.equal(f.scope.store.records[0].final, null); assert.equal(f.scope.store.records[0].ended, false);
  const result = await responsePromise; assert.deepEqual(result.body, Buffer.concat(chunks));
  await waitFor(() => f.scope.store.records[0]?.ended); assert.equal(f.scope.store.records[0].verdict, 'mismatch');
});

for (const [encoding, compress] of Object.entries({ gzip: zlib.gzipSync, deflate: zlib.deflateSync,
  br: zlib.brotliCompressSync, ...(zlib.zstdCompressSync ? { zstd: zlib.zstdCompressSync } : {}) })) {
  test(`${encoding} response remains compressed on the wire but its metadata is observed`, async t => {
    const bytes = compress(Buffer.from(JSON.stringify({ model: 'gpt-demo', reasoning: { effort: 'high' } })));
    const f = await fixture(t, {}, (_req, res) => { res.writeHead(200, { 'Content-Type': 'application/json', 'Content-Encoding': encoding }); res.end(bytes); });
    const result = await request(f.proxy_port); assert.deepEqual(result.body, bytes);
    await waitFor(() => f.scope.store.records[0]?.ended); assert.equal(f.scope.store.records[0].verdict, 'match');
  });
}

test('compressed request body is forwarded byte-for-byte and inspected', async t => {
  const f = await fixture(t), body = zlib.gzipSync(Buffer.from(JSON.stringify({ model: 'gpt-demo', reasoning_effort: 'high' })));
  await request(f.proxy_port, { body, headers: { 'Content-Encoding': 'gzip' } });
  await waitFor(() => f.scope.store.records[0]?.ended);
  assert.deepEqual(f.captures[0].body, body); assert.equal(f.scope.store.records[0].request.effort.value, 'high');
});

test('large request still reaches CCSwitch while inspection is clearly marked truncated', async t => {
  const f = await fixture(t, { max_inspect_bytes: 256 });
  const body = Buffer.from(JSON.stringify({ model: 'gpt-demo', reasoning_effort: 'high', input: 'x'.repeat(5000) }));
  const result = await request(f.proxy_port, { body }); assert.equal(result.status, 200);
  await waitFor(() => f.scope.store.records[0]?.ended);
  assert.deepEqual(f.captures[0].body, body); assert.equal(f.scope.store.records[0].verdict, 'unobservable');
});

test('health/models requests do not manufacture model invocation records', async t => {
  const f = await fixture(t); await request(f.proxy_port, { method: 'GET', url: '/v1/models', body: Buffer.alloc(0) });
  assert.equal(f.scope.store.records.length, 0);
});

test('browser-origin, wrong-host and absolute-target proxy requests are rejected', async t => {
  const f = await fixture(t);
  for (const options of [{ headers: { Origin: 'https://evil.invalid' } }, { headers: { Host: 'evil.invalid' } },
    { url: 'http://evil.invalid/v1/responses' }]) {
    assert.equal((await request(f.proxy_port, options)).status, 403);
  }
  assert.equal(f.captures.length, 0);
});

test('dashboard requires a token and rejects cross-origin mutations even with one', async t => {
  const f = await fixture(t), url = `http://127.0.0.1:${f.dashboard_port}`;
  assert.equal((await fetch(url + '/api/records')).status, 401);
  const status = await fetch(url + '/api/status', { headers: { 'X-Probe-Token': f.scope.token } });
  assert.equal(status.status, 200); assert.equal((await status.json()).instance, f.scope.instance);
  assert.equal((await fetch(url + '/api/attach', { method: 'POST', headers: {
    'X-Probe-Token': f.scope.token, Origin: 'https://evil.invalid'
  } })).status, 403); assert.ok(!f.actions.includes('attach'));
});

test('upstream disconnect produces a failure and never triggers automatic retries', async t => {
  const f = await fixture(t, {}, (req) => req.socket.destroy());
  assert.equal((await request(f.proxy_port)).status, 502);
  await waitFor(() => f.scope.store.records[0]?.ended);
  assert.equal(f.captures.length, 1); assert.equal(f.scope.store.records[0].verdict, 'failed');
});

test('all source labels use the same upstream without an AnyRouter allowlist', async t => {
  const f = await fixture(t);
  for (const route of ['anyrouter', 'deepseek', 'custom-a', 'future-provider'])
    await request(f.proxy_port, { body: Buffer.from(JSON.stringify({ model: `${route}/gpt-demo`, reasoning_effort: 'high' })) });
  await waitFor(() => f.scope.store.records.every(r => r.ended));
  assert.deepEqual(f.scope.store.records.map(r => r.route_label), ['anyrouter', 'deepseek', 'custom-a', 'future-provider']);
  assert.equal(f.captures.length, 4);
});

test('WebSocket tunnel forwards masked client and server frames unchanged', async t => {
  const f = await fixture(t), mock = mockWebSocket(f.upstream, (obj, send) => {
    send({ type: 'response.created', response: { id: 'resp_mock', model: 'gpt-demo', reasoning: { effort: 'high' } } });
    send({ type: 'response.completed', response: { id: 'resp_mock', model: 'gpt-demo', reasoning: { effort: 'low' }, status: 'completed' } });
  });
  const ws = await rawWebSocket(f.proxy_port); t.after(() => ws.socket.destroy());
  const sent = frame({ type: 'response.create', model: 'source/gpt-demo', reasoning: { effort: 'high' }, input: 'WS_SECRET' }, { masked: true });
  ws.socket.write(sent); await waitFor(() => ws.messages.length === 2);
  await waitFor(() => f.scope.store.records[0]?.ended);
  assert.deepEqual(Buffer.concat(mock.incoming), sent);
  assert.deepEqual(Buffer.concat(ws.received), Buffer.concat(mock.outgoing));
  assert.equal(f.scope.store.records[0].verdict, 'mismatch');
  assert.ok(!JSON.stringify(f.scope.store.records).includes('WS_SECRET'));
});

test('sequential WebSocket creates become separate records', async t => {
  const f = await fixture(t); let count = 0;
  mockWebSocket(f.upstream, (obj, send) => send({ type: 'response.completed', response: {
    id: `resp_${++count}`, model: 'gpt-demo', reasoning: { effort: obj.reasoning.effort }, status: 'completed'
  } }));
  const ws = await rawWebSocket(f.proxy_port); t.after(() => ws.socket.destroy());
  for (const effort of ['high', 'low']) {
    ws.socket.write(frame({ type: 'response.create', model: 'gpt-demo', reasoning: { effort } }, { masked: true }));
    await waitFor(() => ws.messages.length === (effort === 'high' ? 1 : 2));
  }
  assert.equal(f.scope.store.records.length, 2); assert.ok(f.scope.store.records.every(r => r.verdict === 'match'));
});

test('overlapping WebSocket creates never receive guessed associations', async t => {
  const f = await fixture(t); let count = 0;
  mockWebSocket(f.upstream, (_obj, send) => { const id = `r${++count}`;
    setTimeout(() => send({ type: 'response.completed', response: { id, reasoning: { effort: 'high' } } }), 40); });
  const ws = await rawWebSocket(f.proxy_port); t.after(() => ws.socket.destroy());
  const message = frame({ type: 'response.create', model: 'gpt-demo', reasoning: { effort: 'high' } }, { masked: true });
  ws.socket.write(Buffer.concat([message, message])); await waitFor(() => ws.messages.length === 2);
  assert.equal(f.scope.store.records.length, 2); assert.ok(f.scope.store.records.every(r => r.verdict === 'ambiguous'));
});

test('stop restores first and drains an active HTTP stream before shutting down', async t => {
  const f = await fixture(t, {}, (_req, res) => { res.writeHead(200, { 'Content-Type': 'text/event-stream' });
    res.write(': keepalive\n\n'); setTimeout(() => res.end('data: {"type":"response.completed","response":{"reasoning":{"effort":"high"}}}\n\n'), 100); });
  const pending = request(f.proxy_port); await waitFor(() => f.scope.proxy.active === 1);
  const result = await f.scope.stop(); assert.equal(result.restored, 0); assert.ok(f.actions.includes('restore'));
  assert.equal(f.scope.state().stopping, true); assert.equal(f.scope.proxy.active, 1);
  assert.equal((await pending).status, 200); await f.scope.stopped;
});

test('port conflict prevents any attach mutation', async t => {
  const occupied = net.createServer(); occupied.listen(0, '127.0.0.1'); await once(occupied, 'listening');
  t.after(() => occupied.close()); const actions = [];
  const dataDir = await fs.mkdtemp(path.join(ROOT, 'test-output', 'port-fixture-'));
  t.after(async () => { if (path.resolve(dataDir).startsWith(path.resolve(ROOT, 'test-output') + path.sep)) await fs.rm(dataDir, { recursive: true, force: true }); });
  await assert.rejects(createScope({ attach: true, dataDir, settings: { proxy_port: occupied.address().port, dashboard_port: await freePort() },
    bridge: async action => { actions.push(action); return { upstream_port: 15721, database: { providers: [] }, fields: [] }; } }));
  assert.deepEqual(actions, ['discover']);
});

test('isolated demo never reads live config or forwards to a real target', async t => {
  const output = path.join(ROOT, 'test-output'); await fs.mkdir(output, { recursive: true });
  const dataDir = await fs.mkdtemp(path.join(output, 'demo-fixture-'));
  const untouched = JSON.stringify([{ id: 'LIVE_RECORD_SENTINEL', ended: true }]);
  await fs.writeFile(path.join(dataDir, 'records.json'), untouched);
  const proxy_port = await freePort(), dashboard_port = await freePort();
  const scope = await createScope({ demo: true, dataDir, settings: { proxy_port, dashboard_port },
    bridge: async () => { throw new Error('demo must never read config'); } });
  t.after(async () => { await scope.close(); if (path.resolve(dataDir).startsWith(path.resolve(output) + path.sep)) await fs.rm(dataDir, { recursive: true, force: true }); });
  assert.equal(scope.state().error, null); assert.equal(scope.state().upstream, null);
  assert.equal(scope.store.records.length, 4); assert.ok(scope.store.records.every(r => r.demo));
  assert.equal((await request(proxy_port)).status, 503);
  assert.equal(await fs.readFile(path.join(dataDir, 'records.json'), 'utf8'), untouched);
});

test('JSONL export is authenticated and includes metadata rather than raw bodies', async t => {
  const f = await fixture(t); await request(f.proxy_port); await waitFor(() => f.scope.store.records[0]?.ended);
  const exported = await fetch(`http://127.0.0.1:${f.dashboard_port}/api/export`, { headers: { 'X-Probe-Token': f.scope.token } });
  assert.equal(exported.status, 200); const text = await exported.text();
  assert.equal(JSON.parse(text.trim()).verdict, 'match'); assert.ok(!text.includes('SECRET_MUST_NOT_PERSIST'));
});

test('read-only startup does not attach but an explicit stop restores a previous journal', async t => {
  const f = await fixture(t, {}, null, { readOnly: true, recoveryPending: true });
  assert.equal(f.scope.state().mode, 'read_only'); assert.deepEqual(f.actions, ['discover']);
  await assert.rejects(f.scope.attach()); assert.ok(!f.actions.includes('attach'));
  await f.scope.stop(); assert.ok(f.actions.includes('restore')); await f.scope.stopped;
});

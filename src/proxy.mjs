import http from 'node:http';
import { pipeline } from 'node:stream';
import * as zlib from 'node:zlib';
import { Evidence, BodyInspector, newRecord } from './evidence.mjs';
import { WebSocketInspector } from './ws_inspector.mjs';

const HOP = new Set(['connection', 'proxy-connection', 'keep-alive', 'transfer-encoding',
  'te', 'trailer', 'upgrade', 'proxy-authorization', 'proxy-authenticate']);

export function cleanHeaders(headers) {
  const blocked = new Set(HOP);
  for (const key of String(headers.connection || '').split(',')) blocked.add(key.trim().toLowerCase());
  return Object.fromEntries(Object.entries(headers).filter(([key]) => !blocked.has(key.toLowerCase())));
}

function localTarget(value, ownPort) {
  const url = new URL(value);
  if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)
      || url.username || url.password || url.search || url.hash || !url.port || Number(url.port) === ownPort)
    throw new Error('unsafe_target');
  // Resolve localhost to a literal loopback address, never via external DNS.
  if (url.hostname === 'localhost') url.hostname = '127.0.0.1';
  return url;
}

function reject(res, status, message) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify({ error: { message, type: 'local_probe_error' } }));
}

function observeBody(stream, evidence, options, encoding) {
  const inspector = new BodyInspector(evidence, options);
  let decoder = null, disabled = false;
  const coding = String(encoding || '').trim().toLowerCase();
  if (coding && coding !== 'identity') {
    const constructors = { gzip: zlib.createGunzip, deflate: zlib.createInflate,
      br: zlib.createBrotliDecompress, zstd: zlib.createZstdDecompress };
    const ctor = constructors[coding];
    if (!ctor) { evidence.warn('content_encoding_unsupported'); disabled = true; }
    else {
      decoder = ctor({ highWaterMark: options.limit * 2 });
      decoder.on('data', chunk => { try { inspector.feed(chunk); } catch { evidence.warn('response_parse_error'); } });
      decoder.on('error', () => { disabled = true; evidence.warn('content_decoder_error'); });
    }
  }
  stream.on('data', chunk => {
    if (disabled) return;
    try {
      if (decoder) {
        if (decoder.writableLength > options.limit * 2) {
          disabled = true; decoder.destroy(); evidence.warn('content_decoder_error');
        } else decoder.write(chunk);
      } else inspector.feed(chunk);
    } catch { disabled = true; evidence.warn('response_parse_error'); }
  });
  return new Promise(resolve => {
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      if (!disabled) { try { inspector.end(); } catch { evidence.warn('response_parse_error'); } }
      resolve();
    };
    stream.once('end', () => {
      if (decoder && !disabled) { decoder.once('end', finish); decoder.once('error', finish); decoder.end(); }
      else finish();
    });
    stream.once('error', () => { evidence.warn('transport_error'); finish(); });
    stream.once('aborted', () => { evidence.warn('transport_aborted'); finish(); });
    stream.once('close', () => { if (!stream.complete && !stream.readableEnded) finish(); });
  });
}

export function createProxy({ port, upstream, store, aliases = () => ({}),
  limit = 4194304, idleTimeout = 300000, onActivity = () => {} }) {
  const sockets = new Set(), websocketSessions = new Set();
  let activeHttp = 0;
  const startEvidence = transport => {
    const record = newRecord(transport);
    store.add(record);
    return new Evidence(record, () => store.changed(), aliases());
  };
  const validRequest = req => {
    const host = String(req.headers.host || '').toLowerCase();
    return [`127.0.0.1:${port}`, `localhost:${port}`].includes(host)
      && !req.headers.origin && !req.headers['sec-fetch-site']
      && req.url?.startsWith('/') && !req.url.startsWith('//') && !/[\r\n\\]/.test(req.url);
  };
  const server = http.createServer((req, res) => {
    if (!validRequest(req)) { reject(res, 403, '探测代理仅接受本机客户端的相对路径请求。'); req.resume(); return; }
    let target;
    try { target = localTarget(upstream(), port); }
    catch { reject(res, 503, '未发现可用的 CCSwitch 本机上游。'); req.resume(); return; }
    activeHttp++; onActivity();
    const observed = req.method === 'POST' && /\/(?:responses(?:\/compact)?|chat\/completions|messages)\/?(?:\?|$)/.test(req.url);
    const evidence = observed ? startEvidence('HTTP') : null;
    // Request URL, authorization, cookies and raw bodies never enter the store.
    const requestDone = evidence ? observeBody(req, evidence, { request: true, limit }, req.headers['content-encoding']) : Promise.resolve();
    let done = false;
    const finish = async () => {
      if (done) return;
      done = true;
      await requestDone;
      evidence?.end(); activeHttp--; onActivity();
    };
    const headers = cleanHeaders(req.headers);
    headers.host = target.host;
    const out = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      method: req.method, path: req.url, headers }, response => {
      if (evidence) evidence.record.http_status = response.statusCode;
      const responseHeaders = cleanHeaders(response.headers);
      res.writeHead(response.statusCode, response.statusMessage, responseHeaders);
      res.flushHeaders();
      const contentType = String(response.headers['content-type'] || '').toLowerCase();
      let responseDone = Promise.resolve();
      if (evidence) {
        if (contentType.includes('text/event-stream') || /json/.test(contentType))
          responseDone = observeBody(response, evidence, { sse: contentType.includes('text/event-stream'), limit }, response.headers['content-encoding']);
        else evidence.warn('content_type_unsupported');
      }
      response.once('end', () => { if (Object.keys(response.trailers).length) res.addTrailers(response.trailers); });
      pipeline(response, res, async error => {
        if (error) evidence?.warn('transport_aborted');
        await responseDone; await finish();
      });
    });
    out.setTimeout(idleTimeout, () => out.destroy(new Error('timeout')));
    out.once('error', () => {
      if (evidence) { evidence.record.completion = 'failed'; evidence.warn('upstream_connection_error'); }
      if (!res.headersSent) reject(res, 502, 'CCSwitch 连接失败或超时；探测器没有重试请求。');
      else res.destroy();
      req.resume(); void finish();
    });
    req.once('aborted', () => { out.destroy(); evidence?.warn('transport_aborted'); });
    req.once('end', () => { if (Object.keys(req.trailers).length) out.addTrailers(req.trailers); });
    res.once('close', () => { if (!res.writableFinished) out.destroy(); });
    // Node regenerates HTTP framing; application body bytes remain unchanged.
    pipeline(req, out, error => { if (error) { out.destroy(); void finish(); } });
  });
  server.on('connection', socket => { sockets.add(socket); socket.on('close', () => sockets.delete(socket)); });
  server.on('clientError', (_error, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  server.on('upgrade', (req, client, head) => {
    if (!validRequest(req) || !/\/responses\/?(?:\?|$)/.test(req.url)) {
      client.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); return;
    }
    let target;
    try { target = localTarget(upstream(), port); }
    catch { client.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
    // Upgrade headers are forwarded as supplied; the handshake and all subsequent
    // frame bytes pass through without decompressing/re-encoding the actual tunnel.
    const headers = { ...req.headers, host: target.host };
    delete headers['proxy-authorization']; delete headers['proxy-connection'];
    const out = http.request({ hostname: target.hostname.replace(/^\[|\]$/g, ''), port: target.port,
      method: 'GET', path: req.url, headers });
    out.setTimeout(idleTimeout, () => out.destroy());
    let pending = [], byId = new Map(), closed = false, tunnel = null, transportRecord = null;
    const session = { client, get pending() { return pending.length; } };
    const warn = code => {
      if (!pending.length) {
        if (!transportRecord) transportRecord = startEvidence('WebSocket');
        transportRecord.warn(code);
      }
      for (const evidence of pending) evidence.warn(code);
    };
    const close = () => {
      if (closed) return;
      closed = true;
      for (const evidence of pending) { evidence.warn('websocket_closed_before_final'); evidence.end(); }
      transportRecord?.end(); pending = []; byId.clear();
      websocketSessions.delete(session); onActivity();
    };
    const fromClient = new WebSocketInspector(obj => {
      if (obj.type !== 'response.create') return;
      const evidence = startEvidence('WebSocket'); evidence.record.http_status = 101;
      evidence.request(obj.response && typeof obj.response === 'object' ? obj.response : obj);
      pending.push(evidence);
      if (pending.length > 1) warn('association_ambiguous');
      if (pending.length > 100) {
        for (const e of pending) { e.warn('websocket_truncated'); e.end(); }
        pending = []; byId.clear();
      }
      onActivity();
    }, warn, limit);
    const fromServer = new WebSocketInspector(obj => {
      const id = obj.response?.id || obj.response_id;
      let evidence = id ? byId.get(id) : null;
      if (!evidence) {
        const available = pending.filter(e => !e.responseId);
        if (available.length === 1) evidence = available[0];
        else if (pending.length === 1) evidence = pending[0];
        else { if (pending.length > 1) warn('association_ambiguous'); return; }
        if (id) { byId.set(id, evidence); evidence.responseId = id; }
      }
      evidence.response(obj);
      if (['response.completed', 'response.failed', 'response.incomplete', 'response.done', 'error'].includes(obj.type)) {
        evidence.end(); pending = pending.filter(e => e !== evidence);
        for (const [key, value] of byId) if (value === evidence) byId.delete(key);
        onActivity();
      }
    }, warn, limit);
    out.once('upgrade', (response, remote, remoteHead) => {
      tunnel = remote; websocketSessions.add(session); onActivity();
      const raw = response.rawHeaders;
      let handshake = `HTTP/1.1 101 ${response.statusMessage || 'Switching Protocols'}\r\n`;
      for (let i = 0; i < raw.length; i += 2) handshake += `${raw[i]}: ${raw[i + 1]}\r\n`;
      client.write(handshake + '\r\n');
      if (head.length) { fromClient.feed(head); remote.write(head); }
      if (remoteHead.length) { fromServer.feed(remoteHead); client.write(remoteHead); }
      client.on('data', chunk => fromClient.feed(chunk));
      remote.on('data', chunk => fromServer.feed(chunk));
      client.pipe(remote); remote.pipe(client);
      remote.setTimeout(idleTimeout, () => { warn('websocket_idle_timeout'); remote.destroy(); client.destroy(); });
      remote.on('error', () => { warn('upstream_connection_error'); client.destroy(); });
      remote.on('close', () => { client.destroy(); close(); });
      client.on('close', () => { remote.destroy(); close(); });
    });
    out.once('response', response => {
      // Preserve an upstream refusal so Codex can use its own fallback policy.
      let raw = `HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`;
      const h = cleanHeaders(response.headers);
      for (const [key, value] of Object.entries(h)) raw += `${key}: ${Array.isArray(value) ? value.join(', ') : value}\r\n`;
      if (!h['content-length']) raw += 'Connection: close\r\n';
      client.write(raw + '\r\n'); response.pipe(client); response.on('end', close);
    });
    out.once('error', () => { if (!client.destroyed) client.end('HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n'); close(); });
    client.on('error', () => { out.destroy(); tunnel?.destroy(); close(); });
    client.on('close', () => { out.destroy(); tunnel?.destroy(); close(); });
    out.end();
  });
  return {
    server,
    get active() { return activeHttp + [...websocketSessions].reduce((n, s) => n + s.pending, 0); },
    closeIdleWebSockets() { for (const s of websocketSessions) if (!s.pending) s.client.end(); },
    destroy() { for (const socket of sockets) socket.destroy(); server.close(); }
  };
}

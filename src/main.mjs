import http from 'node:http';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFile } from 'node:child_process';
import { randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { RecordStore } from './store.mjs';
import { createProxy } from './proxy.mjs';
import { Evidence, newRecord, safeText } from './evidence.mjs';

export const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const DEFAULTS = { python_path: 'D:/Anaconda3/envs/selfcontrol/python.exe', dashboard_port: 18742,
  proxy_port: 18741, max_records: 500, max_inspect_bytes: 4194304, idle_timeout_ms: 300000 };

async function settingsFromDisk() {
  const settings = { ...DEFAULTS, ...JSON.parse(await fs.readFile(path.join(ROOT, '设置.json'), 'utf8')) };
  for (const key of ['dashboard_port', 'proxy_port'])
    if (!Number.isInteger(settings[key]) || settings[key] < 1024 || settings[key] > 65535) throw new Error('端口必须为 1024–65535 的整数。');
  if (settings.dashboard_port === settings.proxy_port) throw new Error('面板端口与代理端口必须不同。');
  for (const [key, min, max] of [['max_records', 10, 2000], ['max_inspect_bytes', 65536, 16777216], ['idle_timeout_ms', 10000, 1800000]])
    if (!Number.isInteger(settings[key]) || settings[key] < min || settings[key] > max) throw new Error(`设置 ${key} 超出支持范围。`);
  return settings;
}

export function makeBridge(settings, dataDir, configPath, dbPath) {
  const python = settings.python_path;
  if (typeof python !== 'string' || !/^[A-Z]:[\\/]/i.test(python)
      || !/[\\/]envs[\\/]selfcontrol[\\/]python\.exe$/i.test(path.win32.normalize(python)))
    throw new Error('请在设置.json 配置 Anaconda 的 selfcontrol 环境下 python.exe 的本机绝对路径。');
  return action => new Promise((resolve, reject) => {
    execFile(python, ['-X', 'utf8', path.join(ROOT, 'src', 'config_bridge.py'), action,
      '--config', configPath, '--database', dbPath, '--journal', path.join(dataDir, 'recovery.json'),
      '--proxy-port', String(settings.proxy_port)], { windowsHide: true, timeout: 7000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      try {
        const result = JSON.parse(stdout);
        if (!result.ok) { reject(new Error(result.error)); return; }
        if (error) { reject(new Error('Anaconda 配置桥接未成功完成。')); return; }
        resolve(result.result);
      } catch { reject(new Error('无法运行 Anaconda selfcontrol 的配置桥接；请检查 Python 路径。')); }
    });
  });
}

export function addDemo(store) {
  const samples = [
    ['模拟来源 A', 'xhigh', 'xhigh', 'match'], ['模拟来源 B', 'high', 'low', 'mismatch'],
    ['模拟来源 C', 'max', undefined, 'no_echo'], ['模拟来源 D', 'medium', null, 'null_echo']
  ];
  for (const [source, requested, returned] of samples) {
    const record = newRecord('HTTP / SSE'); record.demo = true; record.source_hint = source;
    const evidence = new Evidence(record, () => store.changed());
    evidence.request({ model: 'demo-route/gpt-demo', reasoning: { effort: requested } });
    record.source_hint = source;
    record.http_status = 200;
    evidence.response({ type: 'response.created', response: { model: 'gpt-demo', reasoning: { effort: requested } } });
    const response = { model: 'gpt-demo', status: 'completed', usage: {
      input_tokens: 12, output_tokens: 24, output_tokens_details: { reasoning_tokens: returned === null ? 0 : 18 }
    } };
    if (returned !== undefined) response.reasoning = { effort: returned };
    evidence.response({ type: 'response.completed', response }); evidence.end(); store.add(record);
  }
}

function sendJson(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff' });
  res.end(JSON.stringify(value));
}

export async function createScope(options = {}) {
  const settings = { ...DEFAULTS, ...options.settings };
  const dataDir = options.dataDir || path.join(ROOT, 'data');
  const configPath = options.configPath || settings.codex_config_path || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const dbPath = options.dbPath || settings.ccswitch_db_path || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  const bridge = options.bridge || makeBridge(settings, dataDir, configPath, dbPath);
  const store = new RecordStore(dataDir, settings.max_records, options.demo ? 'records-demo.json' : 'records.json'); await store.load();
  const token = randomBytes(32).toString('hex'), instance = randomUUID();
  let discovery = null, discoveryError = null, refreshing = null;
  let stopping = false, closed = false, closing = null, stopResolve;
  const stopped = new Promise(resolve => { stopResolve = resolve; });
  const mode = options.demo ? 'demo' : options.readOnly ? 'read_only' : 'ready';
  let upstreamPort = options.upstreamPort || null;
  const refresh = async () => {
    if (options.demo) return;
    if (refreshing) return refreshing;
    refreshing = (async () => {
      try {
        discovery = await bridge('discover'); discoveryError = null;
        if (discovery.upstream_port) upstreamPort = discovery.upstream_port;
      } catch (e) { discoveryError = safeText(e.message, 240); }
    })();
    try { await refreshing; } finally { refreshing = null; }
  };
  await refresh();
  const state = () => ({ product: 'reasoning-scope-local', version: '1.0.0', instance, mode,
    attached: Boolean(discovery?.attached), partially_attached: Boolean(discovery?.partially_attached),
    recovery_pending: Boolean(discovery?.recovery_pending), stopping, active_requests: proxy.active,
    upstream: upstreamPort ? `http://127.0.0.1:${upstreamPort}` : null,
    proxy_url: `http://127.0.0.1:${settings.proxy_port}/v1`,
    discovery: discovery ? { config_path: discovery.config_path,
      fields: discovery.fields, configured_effort: safeText(discovery.configured_effort, 96),
      database: { ...discovery.database, providers: discovery.database.providers?.map(p => ({ id: safeText(p.id), name: safeText(p.name) })) } } : null,
    error: discoveryError, storage_error: store.storageError,
    record_count: store.records.length, observation_point: 'Codex → 探测器 → CCSwitch' });
  const checkDrain = () => {
    if (stopping && proxy.active === 0 && !closing) {
      proxy.closeIdleWebSockets();
      closing = setTimeout(() => void close(), 1200);
    }
  };
  const proxy = createProxy({ port: settings.proxy_port,
    upstream: () => upstreamPort ? `http://127.0.0.1:${upstreamPort}` : null,
    store, aliases: () => discovery?.aliases || {}, limit: settings.max_inspect_bytes,
    idleTimeout: settings.idle_timeout_ms, onActivity: () => {
      if (closing && proxy.active > 0) { clearTimeout(closing); closing = null; }
      checkDrain();
    } });
  const adminSockets = new Set();
  const authorized = req => {
    const actual = Buffer.from(String(req.headers['x-probe-token'] || ''));
    const expected = Buffer.from(token);
    return actual.length === expected.length && timingSafeEqual(actual, expected);
  };
  const admin = http.createServer(async (req, res) => {
    const host = String(req.headers.host || '').toLowerCase();
    const origins = [`http://127.0.0.1:${settings.dashboard_port}`, `http://localhost:${settings.dashboard_port}`];
    if (![`127.0.0.1:${settings.dashboard_port}`, `localhost:${settings.dashboard_port}`].includes(host)
      || req.headers.origin && !origins.includes(req.headers.origin)
      || req.headers['sec-fetch-site'] === 'cross-site') {
      sendJson(res, 403, { error: '仅允许面板同源访问。' }); req.resume(); return;
    }
    let url;
    try {
      if (!req.url?.startsWith('/') || req.url.startsWith('//')) throw new Error();
      url = new URL(req.url, origins[0]);
    } catch { sendJson(res, 400, { error: '请求路径无效。' }); req.resume(); return; }
    if (url.pathname === '/health' && req.method === 'GET') {
      sendJson(res, 200, { product: 'reasoning-scope-local', version: '1.0.0' }); return;
    }
    if (url.pathname.startsWith('/api/')) {
      if (!authorized(req)) { sendJson(res, 401, { error: '面板令牌无效，请用一键入口重新打开。' }); req.resume(); return; }
      req.resume();
      try {
        if (url.pathname === '/api/status' && req.method === 'GET') { sendJson(res, 200, state()); return; }
        if (url.pathname === '/api/records' && req.method === 'GET') { sendJson(res, 200, [...store.records].reverse()); return; }
        if (url.pathname === '/api/export' && req.method === 'GET') {
          res.writeHead(200, { 'Content-Type': 'application/x-ndjson; charset=utf-8', 'Cache-Control': 'no-store',
            'Content-Disposition': 'attachment; filename="reasoning-metadata.jsonl"' });
          res.end(store.records.map(r => JSON.stringify(r)).join('\n') + '\n'); return;
        }
        if (url.pathname === '/api/demo' && req.method === 'POST') {
          addDemo(store); await store.flush(); sendJson(res, 200, { ok: true, count: 4 }); return;
        }
        if (url.pathname === '/api/clear' && req.method === 'POST') {
          if (proxy.active) { sendJson(res, 409, { error: '有请求正在进行，完成后再清空记录。' }); return; }
          await store.clear(); sendJson(res, 200, { ok: true }); return;
        }
        if (url.pathname === '/api/attach' && req.method === 'POST') {
          await attach(); sendJson(res, 200, state()); return;
        }
        if (url.pathname === '/api/restore' && req.method === 'POST') {
          const result = await restore(); sendJson(res, 200, { ok: true, ...result }); return;
        }
        if (url.pathname === '/api/stop' && req.method === 'POST') {
          const result = await stop(); sendJson(res, 200, { ok: true, ...result, active_requests: proxy.active }); return;
        }
        sendJson(res, 404, { error: '未知操作。' });
      } catch (e) { sendJson(res, 409, { error: safeText(e.message, 240) }); }
      return;
    }
    if (req.method !== 'GET') { sendJson(res, 405, { error: '不支持的请求方法。' }); req.resume(); return; }
    const files = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
    const file = files[url.pathname];
    if (!file) { sendJson(res, 404, { error: '页面不存在。' }); return; }
    try {
      const data = await fs.readFile(path.join(ROOT, 'public', file[0]));
      res.writeHead(200, { 'Content-Type': `${file[1]}; charset=utf-8`, 'Cache-Control': 'no-store',
        'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; frame-ancestors 'none'; base-uri 'none'; form-action 'none'",
        'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' }); res.end(data);
    } catch { sendJson(res, 500, { error: '面板文件读取失败。' }); }
  });
  admin.on('connection', socket => { adminSockets.add(socket); socket.on('close', () => adminSockets.delete(socket)); });
  admin.on('clientError', (_e, socket) => { if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n'); });
  function listen(server, port) {
    return new Promise((resolve, reject) => {
      server.once('error', reject);
      server.listen(port, '127.0.0.1', () => { server.removeListener('error', reject); resolve(); });
    });
  }
  // Both ports must be successfully bound before any configuration mutation.
  try { await listen(proxy.server, settings.proxy_port); await listen(admin, settings.dashboard_port); }
  catch { proxy.destroy(); admin.close(); throw new Error('本机端口被占用，未接入或修改 Codex 配置。请查看设置与故障排查。'); }
  const runtimeFile = path.join(dataDir, 'runtime.json');
  try {
    await fs.writeFile(runtimeFile, JSON.stringify({ product: 'reasoning-scope-local', instance,
      pid: process.pid, token, dashboard_port: settings.dashboard_port, proxy_port: settings.proxy_port,
      mode, started: new Date().toISOString() }, null, 2), { mode: 0o600 });
  } catch {
    proxy.destroy(); admin.close();
    throw new Error('无法保存本机运行状态，已关闭监听端口，未接入或修改 Codex 配置。');
  }
  const poll = setInterval(() => void refresh(), 5000); poll.unref();
  let mutation = Promise.resolve();
  function serialize(action) {
    const task = mutation.then(action); mutation = task.catch(() => {}); return task;
  }
  function attach() {
    return serialize(async () => {
      if (mode !== 'ready') throw new Error('当前是演示或只读模式，请双击“一键启用.cmd”接入真实链路。');
      if (stopping) throw new Error('程序正在停止。');
      await refresh();
      if (!discovery?.upstream_port) throw new Error('未发现指向 CCSwitch 的本机地址；请在 CCSwitch 开启 Codex 代理。');
      const socket = await import('node:net');
      await new Promise((resolve, reject) => {
        const s = socket.createConnection({ host: '127.0.0.1', port: discovery.upstream_port });
        s.setTimeout(2000);
        s.once('connect', () => { s.end(); resolve(); });
        s.once('error', () => reject(new Error('CCSwitch 本机代理没有监听；未修改 Codex 配置。')));
        s.once('timeout', () => { s.destroy(); reject(new Error('CCSwitch 本机代理连接超时；未修改 Codex 配置。')); });
      });
      discovery = await bridge('attach');
      upstreamPort = discovery.upstream_port; discoveryError = null;
      return discovery;
    });
  }
  function restore() {
    return serialize(async () => {
      if (mode === 'demo' || mode === 'read_only' && !discovery?.recovery_pending) return { restored: 0, skipped: 0 };
      const result = await bridge('restore'); await refresh(); return result;
    });
  }
  async function stop() {
    if (stopping) return { restored: 0, skipped: 0 };
    const result = await restore(); stopping = true; checkDrain(); return result;
  }
  async function close() {
    if (closed) return;
    closed = true; clearInterval(poll); clearTimeout(closing);
    // close() is an internal forced cleanup used by tests. Production stop()
    // restores config first and waits for all observed requests to complete.
    proxy.destroy(); for (const s of adminSockets) s.destroy(); admin.close();
    await store.flush();
    try {
      const runtime = JSON.parse(await fs.readFile(runtimeFile, 'utf8'));
      if (runtime.instance === instance) await fs.unlink(runtimeFile);
    } catch {}
    stopResolve();
  }
  if (options.demo && !store.records.length) addDemo(store);
  if (options.attach) {
    try { await attach(); }
    catch (e) { discoveryError = safeText(e.message, 240); }
  }
  return { store, token, instance, admin, proxy, refresh, attach, restore, stop, close, stopped, state };
}

async function control(settings, action) {
  const dataDir = path.join(ROOT, 'data');
  const configPath = settings.codex_config_path || path.join(process.env.CODEX_HOME || path.join(os.homedir(), '.codex'), 'config.toml');
  const dbPath = settings.ccswitch_db_path || path.join(os.homedir(), '.cc-switch', 'cc-switch.db');
  if (action === 'restore-only') {
    const result = await makeBridge(settings, dataDir, configPath, dbPath)('restore');
    console.log(`恢复完成：${result.restored} 个地址；保留其他程序修改的 ${result.skipped} 个地址。`); return;
  }
  let runtime;
  try { runtime = JSON.parse(await fs.readFile(path.join(dataDir, 'runtime.json'), 'utf8')); }
  catch { console.log('探测器未运行，检查并恢复地址。'); await control(settings, 'restore-only'); return; }
  try {
    const response = await fetch(`http://127.0.0.1:${runtime.dashboard_port}/api/stop`, {
      method: 'POST', headers: { 'X-Probe-Token': runtime.token }, signal: AbortSignal.timeout(10000) });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '停止失败。');
    console.log(`地址已恢复，正在等待 ${result.active_requests} 个请求结束后停止。请重新启动 Codex，使原地址生效。`);
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED') await control(settings, 'restore-only');
    else throw new Error('无法安全停止探测器；请打开面板或使用“紧急恢复地址.cmd”。');
  }
}

async function main() {
  const settings = await settingsFromDisk();
  const args = new Set(process.argv.slice(2));
  if (args.has('--restore-only') || args.has('--stop')) { await control(settings, args.has('--stop') ? 'stop' : 'restore-only'); return; }
  const scope = await createScope({ settings, attach: args.has('--attach'), readOnly: args.has('--read-only'), demo: args.has('--demo') });
  console.log(`思考强度探测面板已启动：http://127.0.0.1:${settings.dashboard_port}`);
  if (scope.state().error) console.log(scope.state().error);
  let signals = false;
  const stop = async () => {
    if (signals) return;
    signals = true;
    try { await scope.stop(); }
    catch { signals = false; console.error('恢复未成功，服务保持运行。请使用紧急恢复入口。'); }
  };
  process.on('SIGINT', stop); process.on('SIGTERM', stop);
  await scope.stopped;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main().catch(error => { console.error(safeText(error.message, 240) || '启动失败。'); process.exitCode = 1; });

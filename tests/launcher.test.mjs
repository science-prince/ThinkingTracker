import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import net from 'node:net';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { ROOT } from '../src/main.mjs';

const run = promisify(execFile);
async function freePort() {
  const server = net.createServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const port = server.address().port; await new Promise(resolve => server.close(resolve)); return port;
}
async function eventually(action, timeout = 8000) {
  const end = Date.now() + timeout;
  while (true) {
    try { const value = await action(); if (value) return value; } catch {}
    if (Date.now() > end) throw new Error('launcher integration timeout');
    await new Promise(resolve => setTimeout(resolve, 100));
  }
}

test('Windows one-click launcher attaches to mock CCSwitch, forwards, reuses and restores', { skip: process.platform !== 'win32', timeout: 60000 }, async t => {
  const output = path.join(ROOT, 'test-output'); await fs.mkdir(output, { recursive: true });
  const sandbox = await fs.mkdtemp(path.join(output, 'launcher-fixture-'));
  const mock = http.createServer(async (req, res) => {
    for await (const _chunk of req) {}
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ model: 'gpt-demo', reasoning: { effort: 'low' } }));
  });
  const mockSockets = new Set(); mock.on('connection', s => { mockSockets.add(s); s.on('close', () => mockSockets.delete(s)); });
  mock.listen(0, '127.0.0.1'); await once(mock, 'listening');
  const mockPort = mock.address().port, proxyPort = await freePort(), dashboardPort = await freePort();
  const configuredPython = JSON.parse(await fs.readFile(path.join(ROOT, '设置.json'), 'utf8')).python_path;
  const config = path.join(sandbox, 'mock-codex.toml'), database = path.join(sandbox, 'mock-cc-switch.db');
  const original = `model_reasoning_effort="high"\nopenai_base_url="http://127.0.0.1:${mockPort}/v1"\n[model_providers.custom]\nbase_url="http://127.0.0.1:${mockPort}/v1"\n`;
  await fs.writeFile(config, original);
  for (const dir of ['src', 'public']) {
    await fs.mkdir(path.join(sandbox, dir));
    for (const file of await fs.readdir(path.join(ROOT, dir)))
      if (/\.(?:mjs|py|html|css|js)$/.test(file)) await fs.copyFile(path.join(ROOT, dir, file), path.join(sandbox, dir, file));
  }
  await fs.copyFile(path.join(ROOT, 'package.json'), path.join(sandbox, 'package.json'));
  await fs.copyFile(path.join(ROOT, 'launch.ps1'), path.join(sandbox, 'launch.ps1'));
  await fs.writeFile(path.join(sandbox, '设置.json'), JSON.stringify({ python_path: configuredPython,
    proxy_port: proxyPort, dashboard_port: dashboardPort, codex_config_path: config, ccswitch_db_path: database }));
  await run(configuredPython, ['-X', 'utf8', '-c',
    'import sqlite3,sys\nd=sqlite3.connect(sys.argv[1])\nd.execute("CREATE TABLE proxy_config(app_type TEXT,listen_port INTEGER,listen_address TEXT,enabled INTEGER)")\nd.execute("INSERT INTO proxy_config VALUES (?,?,?,?)",("codex",int(sys.argv[2]),"127.0.0.1",1))\nd.execute("CREATE TABLE providers(id TEXT,name TEXT,app_type TEXT)")\nd.commit()\nd.close()', database, String(mockPort)], { windowsHide: true });
  const ps = path.join(process.env.SystemRoot || 'C:/Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const launch = mode => run(ps, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(sandbox, 'launch.ps1'), '-Mode', mode, '-NoBrowser'], {
    cwd: sandbox, windowsHide: true, timeout: 25000, maxBuffer: 100000
  });
  let runtime;
  const runtimePath = path.join(sandbox, 'data', 'runtime.json');
  t.after(async () => {
    try {
      await fs.access(runtimePath); await launch('Stop');
      await eventually(async () => { try { await fs.access(runtimePath); return false; } catch { return true; } });
    } catch {}
    for (const s of mockSockets) s.destroy(); await new Promise(resolve => mock.close(resolve));
    // Only remove a verified test tree once its service has finished.
    let running = false;
    try { await fs.access(runtimePath); running = true; } catch {}
    if (!running && path.resolve(sandbox).startsWith(path.resolve(output) + path.sep)) await fs.rm(sandbox, { recursive: true, force: true });
  });
  await launch('Attach');
  runtime = JSON.parse(await fs.readFile(runtimePath, 'utf8'));
  const status = async () => (await fetch(`http://127.0.0.1:${dashboardPort}/api/status`, { headers: { 'X-Probe-Token': runtime.token } })).json();
  await eventually(async () => (await status()).attached);
  assert.ok((await fs.readFile(config, 'utf8')).includes(`127.0.0.1:${proxyPort}`));
  const response = await fetch(`http://127.0.0.1:${proxyPort}/v1/responses`, { method: 'POST',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ model: 'mock-provider/gpt-demo', reasoning: { effort: 'high' } }) });
  assert.equal((await response.json()).reasoning.effort, 'low');
  await eventually(async () => {
    const records = await (await fetch(`http://127.0.0.1:${dashboardPort}/api/records`, { headers: { 'X-Probe-Token': runtime.token } })).json();
    return records[0]?.verdict === 'mismatch';
  });
  await launch('Attach');
  assert.equal(JSON.parse(await fs.readFile(runtimePath, 'utf8')).instance, runtime.instance);
  await launch('Stop');
  await eventually(async () => { try { await fs.access(runtimePath); return false; } catch { return true; } });
  assert.equal(await fs.readFile(config, 'utf8'), original);
});

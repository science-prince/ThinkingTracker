const $ = id => document.getElementById(id);
const labels = { pending: '进行中', match: '回显一致', mismatch: '回显不同', no_echo: '未回显',
  null_echo: '回显 null', invalid_echo: '无效回显', no_request_effort: '请求未指定',
  incomplete: '未完整结束', failed: '请求失败', conflict: '字段冲突', ambiguous: '关联不确定', unobservable: '无法解析' };
let token = new URLSearchParams(location.hash.slice(1)).get('token');
try {
  if (token) { sessionStorage.setItem('reasoning-probe-token', token); history.replaceState(null, '', location.pathname); }
  else token = sessionStorage.getItem('reasoning-probe-token');
} catch {}
let records = [], state = null, busy = false, polling = false, initialized = false;
let lastFocus = null;
let renderedRecords = '';

function notice(message, isError = false) {
  const element = $(isError ? 'error' : 'message');
  element.textContent = message || ''; element.hidden = !message;
}
async function api(endpoint, method = 'GET') {
  const response = await fetch(`/api/${endpoint}`, { method, headers: { 'X-Probe-Token': token || '' }, cache: 'no-store' });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error || '本机服务请求失败。');
  return data;
}
function fieldText(field) {
  if (!field || field.state === 'missing') return '未回显';
  if (field.state === 'null') return 'null';
  if (field.state === 'conflict') return '字段冲突';
  if (field.state === 'invalid') return '无效类型';
  return field.value;
}
function element(tag, text, className) {
  const node = document.createElement(tag); if (text != null) node.textContent = text;
  if (className) node.className = className; return node;
}
function displayState() {
  if (!state) return;
  const readOnly = state.mode === 'read_only', demo = state.mode === 'demo';
  $('connection-title').textContent = state.stopping ? '已恢复地址，等待请求完成后停止'
    : demo ? '模拟演示 · 未接入真实链路'
      : state.partially_attached ? '部分地址已接入，请检查配置'
        : state.attached ? '观测已启用' : readOnly ? '只读面板 · 尚未接入' : '等待启用观测';
  $('connection-note').textContent = state.stopping ? `尚有 ${state.active_requests} 个请求。请重新启动 Codex，使原地址生效。`
    : demo ? '这里的数据全部由本机生成，不发送模型请求，也不读取或修改 Codex 配置。'
      : state.attached ? '接入后请重新打开 Codex；已有进程或会话可能仍缓存原地址。'
        : readOnly ? '双击“一键启用.cmd”可安全接入；本模式不会修改配置。'
          : '启用只调整指向 CCSwitch 的本机地址，并保存字段级恢复记录。';
  $('attach').disabled = busy || readOnly || demo || state.stopping || (state.attached && !state.partially_attached);
  $('restore').disabled = busy || demo || state.stopping || !state.recovery_pending;
  $('stop').disabled = busy || state.stopping;
  $('proxy-address').textContent = state.proxy_url.replace('http://', '');
  $('upstream-address').textContent = state.upstream?.replace('http://', '') || '待发现';
  $('clear').disabled = busy || state.active_requests > 0;
  $('demo').disabled = busy;
  if (!initialized) { $('show-demo').checked = demo; initialized = true; }
  notice(state.error || state.storage_error || '', true);
}
function selectedRecords() {
  const search = $('search').value.toLowerCase(), filter = $('filter').value, demos = $('show-demo').checked;
  return records.filter(record => (demos || !record.demo)
    && (filter === 'all' || filter === record.verdict || filter === 'unknown' && !['match', 'mismatch'].includes(record.verdict))
    && (!search || [record.request?.model?.value, record.final?.model?.value, record.route_label, record.source_hint]
      .filter(Boolean).join(' ').toLowerCase().includes(search)));
}
function displayRecords() {
  const visible = selectedRecords();
  const signature = JSON.stringify(visible);
  if (signature === renderedRecords) return;
  renderedRecords = signature;
  const focusedRecord = document.activeElement?.dataset?.recordId;
  $('total').textContent = visible.length;
  $('matched').textContent = visible.filter(r => r.verdict === 'match').length;
  $('mismatched').textContent = visible.filter(r => r.verdict === 'mismatch').length;
  $('unknown').textContent = visible.filter(r => !['match', 'mismatch'].includes(r.verdict)).length;
  $('empty').hidden = visible.length > 0;
  const fragment = document.createDocumentFragment();
  for (const record of visible) {
    const tr = element('tr');
    const time = new Date(record.time).toLocaleTimeString('zh-CN', { hour12: false });
    const first = element('td'); first.append(element('span', time));
    first.append(element('span', record.route_label || '无路由标签', 'source'));
    if (record.source_hint) first.append(element('span', record.source_hint, 'source'));
    if (record.demo) first.append(element('span', '模拟数据', 'demo-label'));
    tr.append(first);
    tr.append(element('td', fieldText(record.request?.model).replace('未回显', '未指定'), 'model'));
    tr.append(element('td', fieldText(record.request?.effort).replace('未回显', '未指定'), 'value'));
    tr.append(element('td', fieldText(record.first?.effort), 'value muted'));
    tr.append(element('td', record.final ? fieldText(record.final.effort) : record.ended ? '无最终事件' : '等待结束', 'value'));
    tr.append(element('td', fieldText(record.final?.model), 'model'));
    tr.append(element('td', record.final?.reasoning_tokens ?? '—', 'value'));
    const result = element('td'); result.append(element('span', labels[record.verdict] || '未知状态', `badge ${record.verdict}`)); tr.append(result);
    const detailCell = element('td'), button = element('button', '详情', 'button secondary detail-button');
    button.setAttribute('aria-label', `查看 ${time} 请求详情`);
    button.dataset.recordId = record.id;
    button.addEventListener('click', () => {
      lastFocus = button;
      $('detail-summary').textContent = `${record.demo ? '模拟记录 · ' : ''}${labels[record.verdict] || record.verdict}。来源标签及返回模型均为协议声明。`;
      $('detail-json').textContent = JSON.stringify(record, null, 2);
      $('detail').showModal(); $('close-detail').focus();
    });
    detailCell.append(button); tr.append(detailCell); fragment.append(tr);
  }
  $('rows').replaceChildren(fragment);
  if (focusedRecord) document.querySelector(`[data-record-id="${CSS.escape(focusedRecord)}"]`)?.focus();
}
async function refresh() {
  if (polling || busy) return;
  if (!token) { notice('请双击程序的一键入口打开面板，以获得本机访问令牌。', true); return; }
  polling = true;
  try {
    [state, records] = await Promise.all([api('status'), api('records')]);
    displayState(); displayRecords();
    $('update').textContent = `更新于 ${new Date().toLocaleTimeString('zh-CN', { hour12: false })}`;
  } catch (e) {
    notice(state?.stopping ? '后台服务已停止。请在需要时双击“一键启用.cmd”。' : e.message, true);
    $('update').textContent = '连接已中断';
  } finally { polling = false; }
}
async function action(endpoint) {
  if (busy) return;
  busy = true; displayState(); notice('');
  try {
    const result = await api(endpoint, 'POST');
    const messages = { attach: '观测已启用。请重新打开 Codex，再发送正常消息。',
      restore: `已恢复 ${result.restored ?? 0} 个地址，并保留 ${result.skipped ?? 0} 个后来修改的地址。请重新启动 Codex。`,
      stop: '地址已恢复。当前请求结束后后台服务会停止；请重新启动 Codex。',
      demo: '已加入 4 条明确标记的模拟记录；没有发送真实请求。', clear: '记录已清空。' };
    if (endpoint === 'demo') $('show-demo').checked = true;
    notice(messages[endpoint]);
  } catch (e) { notice(e.message, true); }
  finally { busy = false; await refresh(); displayState(); }
}
for (const id of ['attach', 'restore', 'stop', 'demo', 'clear']) $(id).addEventListener('click', () => void action(id));
for (const id of ['search', 'filter', 'show-demo']) $(id).addEventListener('input', displayRecords);
$('close-detail').addEventListener('click', () => $('detail').close());
$('detail').addEventListener('close', () => {
  if (lastFocus?.isConnected) lastFocus.focus();
  else if (lastFocus?.dataset.recordId) document.querySelector(`[data-record-id="${CSS.escape(lastFocus.dataset.recordId)}"]`)?.focus();
});
$('export').addEventListener('click', async () => {
  try {
    const response = await fetch('/api/export', { headers: { 'X-Probe-Token': token || '' }, cache: 'no-store' });
    if (!response.ok) throw new Error('导出失败，请重新打开面板。');
    const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
    link.href = url; link.download = `思考强度元数据-${new Date().toISOString().slice(0, 10)}.jsonl`;
    link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
  } catch (e) { notice(e.message, true); }
});
void refresh(); setInterval(() => void refresh(), 2000);

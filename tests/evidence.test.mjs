import test from 'node:test';
import assert from 'node:assert/strict';
import { BodyInspector, Evidence, newRecord, snapshot, extractEffort, verdict } from '../src/evidence.mjs';
import { WebSocketInspector } from '../src/ws_inspector.mjs';

function evidence(request = { model: 'route/gpt-demo', reasoning: { effort: 'high' } }) {
  const e = new Evidence(newRecord()); e.record.http_status = 200; e.request(request); return e;
}
function complete(e, response = {}) {
  e.response({ type: 'response.completed', response: { status: 'completed', ...response } }); e.end(); return e.record;
}
function frame(text, { masked = false, opcode = 1, fin = true, compressed = false } = {}) {
  const body = Buffer.from(text), header = Buffer.alloc(body.length < 126 ? 2 : 4);
  header[0] = opcode | (fin ? 128 : 0) | (compressed ? 64 : 0);
  header[1] = (masked ? 128 : 0) | (body.length < 126 ? body.length : 126);
  if (body.length >= 126) header.writeUInt16BE(body.length, 2);
  if (!masked) return Buffer.concat([header, body]);
  const mask = Buffer.from([11, 22, 33, 44]), payload = Buffer.from(body);
  for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3];
  return Buffer.concat([header, mask, payload]);
}

test('matches the final echo, independently from the first echo', () => {
  const e = evidence(); e.response({ type: 'response.created', response: { reasoning: { effort: 'low' } } });
  const r = complete(e, { model: 'gpt-demo', reasoning: { effort: 'high' } });
  assert.equal(r.verdict, 'match'); assert.equal(r.first.effort.value, 'low');
  assert.ok(r.warnings.includes('first_final_echo_changed'));
});
test('reports a final effort mismatch', () => assert.equal(complete(evidence(), { reasoning: { effort: 'low' } }).verdict, 'mismatch'));
test('never treats an early echo as a missing final echo', () => {
  const e = evidence(); e.response({ type: 'response.created', response: { reasoning: { effort: 'high' } } });
  assert.equal(complete(e).verdict, 'no_echo');
});
test('distinguishes null from absence', () => {
  assert.equal(complete(evidence(), { reasoning: { effort: null } }).verdict, 'null_echo');
  assert.equal(complete(evidence()).verdict, 'no_echo');
});
test('preserves zero reasoning tokens', () => {
  assert.equal(snapshot({ usage: { output_tokens_details: { reasoning_tokens: 0 } } }).reasoning_tokens, 0);
});
test('does not derive actual effort from tokens or elapsed time', () => {
  assert.equal(complete(evidence(), { usage: { output_tokens_details: { reasoning_tokens: 99999 } } }).verdict, 'no_echo');
});
test('preserves unknown effort strings without classifying them as known', () => {
  const e = evidence({ reasoning_effort: 'future_level' });
  const r = complete(e, { reasoning_effort: 'future_level' });
  assert.equal(r.final.effort.known, false); assert.equal(r.verdict, 'match');
});
test('does not compare invalid or redacted values as equal', () => {
  for (const value of [3, {}, 'x'.repeat(110), 'sk-' + 's'.repeat(50)]) {
    const e = evidence({ reasoning_effort: value });
    const r = complete(e, { reasoning_effort: value });
    assert.notEqual(r.verdict, 'match');
    assert.ok(!JSON.stringify(r).includes('s'.repeat(50)));
  }
});
test('detects conflicting top-level effort fields', () => {
  assert.equal(extractEffort({ reasoning: { effort: 'high' }, reasoning_effort: 'low' }).state, 'conflict');
  assert.equal(complete(evidence(), { reasoning: { effort: 'high' }, reasoning_effort: 'low' }).verdict, 'conflict');
});
test('extracts Chat Completions and thinking metadata', () => {
  const s = snapshot({ reasoning_effort: 'medium', thinking: { type: 'enabled', budget_tokens: 0 }, usage: {
    prompt_tokens: 12, completion_tokens: 3, completion_tokens_details: { reasoning_tokens: 0 }
  } });
  assert.equal(s.effort.value, 'medium'); assert.equal(s.thinking_budget, 0); assert.equal(s.input_tokens, 12);
});
test('never scans prompt or answer content for reasoning fields', () => {
  const e = evidence({ input: [{ reasoning: { effort: 'high' } }], secret: 'PROMPT_SECRET' });
  const r = complete(e, { output: [{ reasoning_effort: 'high', text: 'ANSWER_SECRET' }] });
  assert.equal(r.verdict, 'no_echo');
  assert.ok(!JSON.stringify(r).includes('PROMPT_SECRET')); assert.ok(!JSON.stringify(r).includes('ANSWER_SECRET'));
});
test('missing request effort is not replaced with config defaults', () => {
  assert.equal(complete(evidence({ model: 'gpt-demo' }), { reasoning: { effort: 'high' } }).verdict, 'no_request_effort');
});
test('valid JSON response yields complete evidence', () => {
  const e = evidence(), inspector = new BodyInspector(e);
  inspector.feed(Buffer.from(JSON.stringify({ model: 'gpt-demo', reasoning: { effort: 'high' } }))); inspector.end(); e.end();
  assert.equal(e.record.verdict, 'match');
});
test('HTTP error JSON cannot be reported as matched', () => {
  const e = evidence(); e.record.http_status = 401;
  e.response({ reasoning_effort: 'high', error: { message: 'KEY_SECRET' } }, '', true); e.end();
  assert.equal(e.record.verdict, 'failed'); assert.ok(!JSON.stringify(e.record).includes('KEY_SECRET'));
});
test('a clean transport end without a final event remains incomplete', () => {
  const e = evidence(); e.response({ type: 'response.created', response: { reasoning: { effort: 'high' } } }); e.end();
  assert.equal(e.record.verdict, 'incomplete');
});
test('SSE handles one-byte chunks, UTF8 and CRLF', () => {
  const e = evidence(), inspector = new BodyInspector(e, { sse: true });
  const raw = Buffer.from('event: response.completed\r\ndata: ' + JSON.stringify({ type: 'response.completed', response: {
    model: 'gpt-demo', reasoning: { effort: 'high' }, output: [{ text: '中文正文不会保存' }]
  } }) + '\r\n\r\n');
  for (const byte of raw) inspector.feed(Buffer.from([byte])); inspector.end(); e.end();
  assert.equal(e.record.verdict, 'match'); assert.ok(!JSON.stringify(e.record).includes('中文正文'));
});
test('SSE accepts multiline data and ignores comments', () => {
  const e = evidence(), inspector = new BodyInspector(e, { sse: true });
  inspector.feed(Buffer.from(': keepalive\n\nevent: response.completed\ndata: {"response":\ndata: {"reasoning":{"effort":"high"}}}\n\n'));
  inspector.end(); e.end(); assert.equal(e.record.verdict, 'match');
});
test('a partial SSE final event is not dispatched', () => {
  const e = evidence(), inspector = new BodyInspector(e, { sse: true });
  inspector.feed(Buffer.from('data: {"type":"response.completed","response":{"reasoning":{"effort":"high"}}}\n'));
  inspector.end(); e.end(); assert.equal(e.record.verdict, 'incomplete');
});
test('Chat SSE tracks finish and retains zero tokens in a later usage chunk', () => {
  const e = evidence(), inspector = new BodyInspector(e, { sse: true });
  for (const obj of [
    { model: 'gpt-demo', reasoning_effort: 'high', choices: [{ delta: { content: 'ANSWER_SECRET' }, finish_reason: null }] },
    { model: 'gpt-demo', choices: [{ delta: {}, finish_reason: 'stop' }] },
    { model: 'gpt-demo', choices: [], usage: { completion_tokens_details: { reasoning_tokens: 0 } } }
  ]) inspector.feed(Buffer.from(`data: ${JSON.stringify(obj)}\n\n`));
  inspector.feed(Buffer.from('data: [DONE]\n\n')); inspector.end(); e.end();
  assert.equal(e.record.verdict, 'no_echo'); assert.equal(e.record.final.reasoning_tokens, 0);
});
test('[DONE] alone does not prove successful Responses completion', () => {
  const e = evidence(), inspector = new BodyInspector(e, { sse: true });
  inspector.feed(Buffer.from('data: [DONE]\n\n')); inspector.end(); e.end(); assert.equal(e.record.verdict, 'incomplete');
});
test('response.failed and response.incomplete are not successful comparisons', () => {
  for (const type of ['response.failed', 'response.incomplete']) {
    const e = evidence(); e.response({ type, response: { reasoning: { effort: 'high' } } }); e.end();
    assert.equal(e.record.verdict, type === 'response.failed' ? 'failed' : 'incomplete');
  }
});
test('truncation and invalid JSON are explicitly unobservable', () => {
  for (const [body, limit] of [['!not-json', 100], ['x'.repeat(400), 20]]) {
    const e = evidence(), inspector = new BodyInspector(e, { limit });
    inspector.feed(Buffer.from(body)); inspector.end(); e.end(); assert.equal(e.record.verdict, 'unobservable');
  }
});
test('ambiguous websocket associations cannot yield a matched verdict', () => {
  const r = complete(evidence(), { reasoning_effort: 'high' }); r.warnings.push('association_ambiguous');
  assert.equal(verdict(r), 'ambiguous');
});
test('websocket decodes masked fragmented text, with interleaved ping', () => {
  const messages = [], warnings = [], inspector = new WebSocketInspector(m => messages.push(m), w => warnings.push(w));
  const raw = Buffer.concat([frame('{"type":', { masked: true, fin: false }),
    frame('ping', { masked: true, opcode: 9 }), frame('"response.create"}', { masked: true, opcode: 0 })]);
  for (const b of raw) inspector.feed(Buffer.from([b]));
  assert.deepEqual(messages, [{ type: 'response.create' }]); assert.deepEqual(warnings, []);
});
test('compressed websocket messages explicitly report unsupported inspection', () => {
  const messages = [], warnings = [], inspector = new WebSocketInspector(m => messages.push(m), w => warnings.push(w));
  inspector.feed(frame('compressed bytes', { compressed: true }));
  assert.equal(messages.length, 0); assert.deepEqual(warnings, ['compressed_websocket_unsupported']);
});
test('websocket oversized payload disables only inspection', () => {
  const warnings = [], inspector = new WebSocketInspector(() => {}, w => warnings.push(w), 20);
  inspector.feed(frame('x'.repeat(200))); assert.equal(inspector.disabled, true); assert.deepEqual(warnings, ['websocket_truncated']);
});
test('an aborted transport cannot report a completed comparison', () => {
  const e = evidence(); e.response({ type: 'response.completed', response: { reasoning_effort: 'high' } });
  e.warn('transport_aborted'); e.end(); assert.equal(e.record.verdict, 'incomplete');
});

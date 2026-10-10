import { StringDecoder } from 'node:string_decoder';

const LEVELS = new Set(['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra']);
const own = (obj, key) => obj !== null && typeof obj === 'object' && Object.hasOwn(obj, key);

export function safeText(value, max = 160) {
  if (typeof value !== 'string') return null;
  return value.replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\b(?:sk|sess|eyJ)-?[a-zA-Z0-9_-]{16,}/g, '[已脱敏]')
    .replace(/\bBearer\s+\S+/gi, 'Bearer [已脱敏]')
    .replace(/((?:api[_-]?key|token|password|secret)\s*[=:]\s*)\S+/gi, '$1[已脱敏]')
    .slice(0, max);
}

export function field(obj, path) {
  let node = obj;
  for (const key of path) {
    if (!own(node, key)) return { state: 'missing' };
    node = node[key];
  }
  if (node === null) return { state: 'null' };
  if (typeof node !== 'string') return { state: 'invalid' };
  const value = safeText(node, 96);
  // A redacted or truncated string cannot support an exact comparison.
  if (value !== node) return { state: 'invalid' };
  return { state: 'value', value, known: LEVELS.has(node) };
}

export function extractEffort(obj) {
  const fields = [['reasoning', 'effort'], ['reasoning_effort'], ['output_config', 'effort']]
    .map(path => ({ ...field(obj, path), path: path.join('.') }))
    .filter(f => f.state !== 'missing');
  if (!fields.length) return { state: 'missing' };
  if (new Set(fields.map(f => JSON.stringify([f.state, f.value]))).size > 1)
    return { state: 'conflict', fields };
  return fields[0];
}

function numberAt(obj, paths) {
  for (const path of paths) {
    let value = obj;
    for (const key of path) value = value?.[key];
    if (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0) return value;
  }
  return null;
}

export function snapshot(obj) {
  const usage = obj?.usage;
  const thinking = obj?.thinking;
  const model = field(obj, ['model']);
  delete model.known;
  return {
    model, effort: extractEffort(obj),
    reasoning_tokens: numberAt(usage, [
      ['output_tokens_details', 'reasoning_tokens'], ['completion_tokens_details', 'reasoning_tokens'],
      ['reasoning_tokens'], ['thinking_tokens']
    ]),
    input_tokens: numberAt(usage, [['input_tokens'], ['prompt_tokens']]),
    output_tokens: numberAt(usage, [['output_tokens'], ['completion_tokens']]),
    thinking_type: typeof thinking?.type === 'string' ? safeText(thinking.type, 40) : null,
    thinking_budget: numberAt(thinking, [['budget_tokens']])
  };
}

export function verdict(record) {
  if (record.warnings?.includes('association_ambiguous')) return 'ambiguous';
  if (record.warnings?.some(w => /truncated|parse_error|unsupported|compressed|decoder_error/.test(w))) return 'unobservable';
  if (!record.ended) return 'pending';
  if (record.http_status >= 400 || record.completion === 'failed') return 'failed';
  if (record.warnings?.some(w => ['transport_aborted', 'transport_error', 'sse_incomplete_event',
    'websocket_closed_before_final', 'previous_process_interrupted'].includes(w))) return 'incomplete';
  if (record.completion !== 'completed') return 'incomplete';
  const req = record.request?.effort, echo = record.final?.effort;
  if (!echo || echo.state === 'missing') return 'no_echo';
  if (echo.state === 'null') return 'null_echo';
  if (echo.state === 'conflict' || req?.state === 'conflict') return 'conflict';
  if (echo.state !== 'value') return 'invalid_echo';
  if (!req || req.state !== 'value') return 'no_request_effort';
  return req.value === echo.value ? 'match' : 'mismatch';
}

export function newRecord(transport = 'HTTP') {
  return {
    id: crypto.randomUUID(), time: new Date().toISOString(), transport,
    observation_point: 'Codex → 探测器 → CCSwitch',
    request: snapshot({}), first: null, final: null, latest: null,
    route_label: null, source_hint: null, source_evidence: '请求模型的路由标签；未核验实际出站来源',
    http_status: null, completion: 'in_progress', ended: false, duration_ms: null,
    warnings: [], event_count: 0, verdict: 'pending', demo: false
  };
}

export class Evidence {
  constructor(record, changed = () => {}, aliases = {}) {
    this.record = record;
    this.changed = changed;
    this.aliases = aliases;
    this.started = performance.now();
    this.responseId = null;
    this.chatFinal = null;
    this.chatFinished = false;
  }
  warn(code) {
    if (!this.record.warnings.includes(code)) this.record.warnings.push(code);
    this.update();
  }
  update() {
    this.record.verdict = verdict(this.record);
    this.changed(this.record);
  }
  request(obj) {
    this.record.request = snapshot(obj);
    const model = this.record.request.model;
    if (model.state === 'value' && model.value.includes('/')) {
      this.record.route_label = safeText(model.value.split('/')[0], 96);
      this.record.source_hint = safeText(this.aliases[model.value]);
    }
    this.update();
  }
  response(obj, event = '', isJson = false) {
    if (!obj || typeof obj !== 'object') { this.warn('response_parse_error'); return; }
    this.record.event_count++;
    const type = typeof obj.type === 'string' ? obj.type : event;
    const value = obj.response && typeof obj.response === 'object' ? obj.response
      : obj.message && typeof obj.message === 'object' ? obj.message : obj;
    if (typeof value.id === 'string') this.responseId = value.id;
    const data = snapshot(value);
    const isSnapshot = own(value, 'model') || own(value, 'reasoning') || own(value, 'reasoning_effort')
      || own(value, 'usage') || own(value, 'choices') || isJson;
    if (isSnapshot) {
      if (!this.record.first) this.record.first = data;
      this.record.latest = data;
    }
    if (isJson) {
      this.record.final = data;
      this.record.completion = this.record.http_status >= 400 || own(value, 'error') && value.error
        || value.status === 'failed' ? 'failed'
        : value.status === 'incomplete' || value.status === 'in_progress' || value.status === 'queued'
          ? 'incomplete' : 'completed';
    } else if (['response.completed', 'response.failed', 'response.incomplete', 'response.done'].includes(type)) {
      this.record.final = data;
      this.record.completion = type === 'response.failed' || value.status === 'failed' ? 'failed'
        : type === 'response.incomplete' || value.status === 'incomplete' ? 'incomplete'
          : type === 'response.done' && value.status !== 'completed' ? 'incomplete' : 'completed';
    } else if (type === 'error' || own(obj, 'error') && obj.error) {
      this.record.completion = 'failed';
    }
    if (Array.isArray(value.choices)) {
      if (value.choices.some(choice => choice.finish_reason != null)) {
        this.chatFinished = true;
        this.chatFinal = data;
      }
      // Usage-only chunks must not manufacture an effort echo from an earlier chunk.
      if (value.usage && this.chatFinished && this.chatFinal) {
        for (const k of ['reasoning_tokens', 'input_tokens', 'output_tokens'])
          if (data[k] !== null) this.chatFinal[k] = data[k];
      }
    }
    this.update();
  }
  done() {
    if (this.chatFinished) {
      this.record.final = this.chatFinal;
      this.record.completion = 'completed';
    }
    this.update();
  }
  end() {
    if (!this.record.ended) {
      this.record.ended = true;
      this.record.duration_ms = Math.round(performance.now() - this.started);
    }
    if (this.record.first && this.record.final) {
      const first = this.record.first.effort, final = this.record.final.effort;
      if (first.state === 'value' && final.state === 'value' && first.value !== final.value
          && !this.record.warnings.includes('first_final_echo_changed'))
        this.record.warnings.push('first_final_echo_changed');
    }
    this.update();
  }
}

export class BodyInspector {
  constructor(evidence, { sse = false, request = false, limit = 4194304 } = {}) {
    this.evidence = evidence;
    this.sse = sse;
    this.request = request;
    this.limit = limit;
    this.decoder = new StringDecoder('utf8');
    this.buffer = '';
    this.data = [];
    this.event = '';
    this.bytes = 0;
    this.eventBytes = 0;
    this.disabled = false;
    this.skipping = false;
  }
  feed(chunk) {
    if (this.disabled) return;
    if (!this.sse) {
      this.bytes += chunk.length;
      if (this.bytes > this.limit) {
        this.buffer = ''; this.disabled = true;
        this.evidence.warn(this.request ? 'request_truncated' : 'response_truncated');
        return;
      }
    }
    this.buffer += this.decoder.write(chunk);
    if (!this.sse) return;
    let end;
    while ((end = this.buffer.indexOf('\n')) >= 0) {
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      this.line(line);
    }
    if (Buffer.byteLength(this.buffer) > this.limit) {
      this.buffer = ''; this.disabled = true; this.evidence.warn('response_truncated');
    }
  }
  line(line) {
    if (line === '') { this.dispatch(); return; }
    if (this.skipping) return;
    this.eventBytes += Buffer.byteLength(line);
    if (this.eventBytes > this.limit) {
      this.data = []; this.skipping = true; this.evidence.warn('response_truncated'); return;
    }
    if (line.startsWith('event:')) this.event = line.slice(6).trim();
    else if (line.startsWith('data:')) this.data.push(line.slice(5).replace(/^ /, ''));
  }
  dispatch() {
    const data = this.data.join('\n');
    if (data && !this.skipping) {
      if (data.trim() === '[DONE]') this.evidence.done();
      else {
        try { this.evidence.response(JSON.parse(data), this.event); }
        catch { this.evidence.warn('response_parse_error'); }
      }
    }
    this.data = []; this.event = ''; this.eventBytes = 0; this.skipping = false;
  }
  end() {
    if (this.disabled) return;
    this.buffer += this.decoder.end();
    if (this.sse) {
      // SSE requires a blank line to dispatch an event. A partial final event is
      // not evidence of successful completion even when its JSON is valid.
      if (this.buffer || this.data.length) this.evidence.warn('sse_incomplete_event');
    } else if (this.buffer.trim()) {
      try {
        const obj = JSON.parse(this.buffer);
        if (this.request) this.evidence.request(obj);
        else this.evidence.response(obj, '', true);
      } catch { this.evidence.warn(this.request ? 'request_parse_error' : 'response_parse_error'); }
    } else if (this.request) this.evidence.warn('request_parse_error');
    this.buffer = ''; this.data = [];
  }
}

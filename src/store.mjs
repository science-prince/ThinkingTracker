import fs from 'node:fs/promises';
import path from 'node:path';

export class RecordStore {
  constructor(directory, maxRecords = 500, filename = 'records.json') {
    this.directory = directory; this.file = path.join(directory, filename);
    this.maxRecords = maxRecords; this.records = []; this.timer = null;
    this.writes = Promise.resolve(); this.storageError = null;
  }
  async load() {
    await fs.mkdir(this.directory, { recursive: true });
    try {
      const stat = await fs.stat(this.file);
      if (stat.size > 16 * 1024 * 1024) throw new Error('large_store');
      const data = JSON.parse(await fs.readFile(this.file, 'utf8'));
      this.records = Array.isArray(data) ? data.slice(-this.maxRecords) : [];
      for (const record of this.records) if (!record.ended) {
        record.ended = true; record.completion = 'incomplete'; record.verdict = 'incomplete';
        record.warnings = [...(record.warnings || []), 'previous_process_interrupted'];
      }
    } catch (e) {
      if (e.code !== 'ENOENT') this.storageError = '历史记录无法读取；不会删除原文件。';
    }
  }
  add(record) {
    this.records.push(record);
    if (this.records.length > this.maxRecords) this.records.splice(0, this.records.length - this.maxRecords);
    this.changed();
  }
  changed() {
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, 200);
  }
  async flush() {
    clearTimeout(this.timer); this.timer = null;
    if (this.storageError) return; // preserve damaged history until the user clears it.
    const text = JSON.stringify(this.records);
    this.writes = this.writes.then(async () => {
      const temp = this.file + '.tmp';
      try { await fs.writeFile(temp, text, { mode: 0o600 }); await fs.rename(temp, this.file); }
      catch { this.storageError = '记录保存失败；面板仍可显示当前内存中的记录。'; }
    });
    await this.writes;
  }
  async clear() {
    await this.writes;
    this.records = []; this.storageError = null;
    await this.flush();
  }
}

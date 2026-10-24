import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { defaults } from '../lib/h3.mjs';
import { AvailabilityMonitor } from '../public/monitor.js';

const settle = async () => { for (let i = 0; i < 4; i++) await new Promise(resolve => setImmediate(resolve)); };
async function page(initialJobs, detail) {
  const elements = new Map(), requests = [], timeouts = new Map(), intervals = new Map();
  let nextTimer = 0, jobs = initialJobs;
  const element = name => {
    if (!elements.has(name)) elements.set(name, { value: '', hidden: false, disabled: false, children: [], handlers: {}, textContent: '',
      addEventListener(event, fn) { (this.handlers[event] ||= []).push(fn); },
      click() { if (!this.disabled) for (const fn of this.handlers.click || []) fn({}); },
      classList: { toggle() {} }, setAttribute() {}, removeAttribute(name) { delete this[name]; },
      replaceChildren() { this.children = []; }, append(child) { this.children.push(child); }, load() {}, focus() {},
    });
    return elements.get(name);
  };
  const form = element('#form'); form.elements = [];
  for (const name of [...Object.keys(defaults), 'apiKey', 'duration']) { const field = element(name); form.elements[name] = field; form.elements.push(field); }
  const context = vm.createContext({
    document: { querySelector: element, querySelectorAll: () => [], createElement: () => element(`new-${elements.size}`), title: '' },
    window: { addEventListener() {} }, AvailabilityMonitor, URL, Date, Promise, AbortController,
    localStorage: { getItem() { return 'mock-key'; } },
    FormData: class { constructor() { return Object.entries(defaults).map(([name]) => [name, form.elements[name].value]).concat([['apiKey', 'mock-key']]); } },
    setTimeout(fn, ms) { const id = ++nextTimer; timeouts.set(id, { fn, ms }); return id; }, clearTimeout(id) { timeouts.delete(id); },
    setInterval(fn, ms) { const id = ++nextTimer; intervals.set(id, { fn, ms }); return id; }, clearInterval(id) { intervals.delete(id); },
    fetch: async (path, options) => {
      requests.push({ path, method: options?.method || 'GET' });
      let data;
      if (path === '/api/defaults') data = defaults;
      else if (path === '/api/preview') data = { command: 'curl mock' };
      else if (path === '/api/jobs') data = { jobs };
      else data = await detail(path, options);
      return { ok: !data.error, status: data.error ? 404 : 200, json: async () => data };
    },
  });
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
  vm.runInContext(source, context); await settle();
  return { element, requests, setJobs(value) { jobs = value; }, async timeout(ms) { const found = [...timeouts].find(([, timer]) => timer.ms === ms); assert.ok(found, `expected ${ms}ms timer`); timeouts.delete(found[0]); await found[1].fn(); await settle(); }, async sync() { await [...intervals.values()].find(timer => timer.ms === 5000).fn(); await settle(); } };
}

const running = { id: 'aaaa', status: 'running', created: Date.now() - 60000, finished: null };
const old = { id: 'bbbb', status: 'error', created: Date.now() - 90000, finished: Date.now() - 80000 };

test('actual H3 page restores running job after reload, completes and opens earlier history', async () => {
  let done = false;
  const ui = await page([running, old], async path => path.endsWith('bbbb') ? { ...old, ok: false, body: 'old failure' } : done ? { ...running, status: 'done', ok: true } : running);
  assert.equal(ui.element('#run').disabled, true); assert.equal(ui.element('#progress').hidden, false);
  assert.match(ui.element('#elapsed').textContent, /60 秒/);
  assert.equal(ui.element('#job-list').children.length, 2); assert.equal(ui.element('#job-list').children[1].disabled, true);
  assert.equal(ui.requests.some(req => req.method === 'POST' && req.path === '/api/jobs'), false);
  done = true; ui.setJobs([{ ...running, status: 'done' }, old]); await ui.timeout(1000);
  assert.equal(ui.element('#run').disabled, false); assert.equal(ui.element('#video').src, '/api/jobs/aaaa/download');
  assert.equal(ui.element('#download').href, '/api/jobs/aaaa/download'); assert.equal(ui.element('#video-result').hidden, false);
  ui.element('#job-list').children[1].click(); await settle();
  assert.match(ui.element('#response').textContent, /old failure/); assert.equal(ui.element('#video-result').hidden, true);
  ui.element('#job-list').children[0].click(); await settle();
  assert.equal(ui.element('#video-result').hidden, false);
});

test('actual H3 page opens latest completed history on reload and detects another tab running', async () => {
  const ui = await page([{ ...running, status: 'done' }], async path => path.endsWith('aaaa') ? { ...running, status: 'done', ok: true } : { ...running, id: 'cccc' });
  assert.equal(ui.element('#video').src, '/api/jobs/aaaa/download');
  ui.setJobs([{ ...running, id: 'cccc' }, { ...running, status: 'done' }]); await ui.sync();
  assert.equal(ui.element('#run').disabled, true); assert.equal(ui.element('#status').textContent, '生成中');
});

test('actual H3 page retries transient status errors but stops tracking expired jobs', async () => {
  let phase = 'offline';
  const ui = await page([running], async () => { if (phase === 'offline') throw new Error('temporary offline'); return { error: 'expired' }; });
  assert.equal(ui.element('#run').disabled, true); assert.match(ui.element('#elapsed').textContent, /正在重试/);
  phase = 'expired'; ui.setJobs([]); await ui.timeout(3000);
  assert.equal(ui.element('#run').disabled, false); assert.equal(ui.element('#progress').hidden, true);
  assert.match(ui.element('#result-message').textContent, /服务重启后无法恢复/);
});

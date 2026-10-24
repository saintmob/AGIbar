import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../server.mjs';
import { validateProbe } from '../lib/k3.mjs';
import { AvailabilityMonitor } from '../public/monitor.js';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });

test('K3 probe uses exact minimal request, interprets errors and never returns upstream secrets', async t => {
  const received = []; let mode = 'quota'; let redirected = false;
  const secret = 'mock-k3-secret';
  const upstream = http.createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    received.push({ path: req.url, authorization: req.headers.authorization, body: JSON.parse(raw) });
    res.setHeader('Content-Type', 'application/json');
    if (req.url === '/target') redirected = true;
    if (mode === 'quota') { res.writeHead(429); res.end(JSON.stringify({ error: secret })); }
    else if (mode === 'redirect') { res.writeHead(302, { Location: '/target' }); res.end(); }
    else if (mode === 'invalid') res.end(JSON.stringify({ error: secret, choices: [] }));
    else if (mode === 'huge') res.end('x'.repeat(70000));
    else if (mode === 'slow') { req.socket.on('close', () => {}); }
    else res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: secret }, finish_reason: 'length' }] }));
  });
  const remote = await listen(upstream); const app = createApp(); const base = await listen(app);
  t.after(async () => { await close(app); await close(upstream); });
  const call = () => fetch(`${base}/api/k3/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: `${remote}/v1/`, apiKey: secret }) });
  assert.throws(() => validateProbe({ base: 'http://example.com/v1', apiKey: secret }), /HTTPS/);
  assert.throws(() => validateProbe({ base: `${remote}/v1?key=x`, apiKey: secret }), /Base URL/);
  assert.throws(() => validateProbe({ base: remote, apiKey: 'key\nInjected: x' }), /API key/);
  assert.equal((await fetch(`${base}/monitor.js`)).status, 200);
  const quota = await (await call()).json();
  assert.equal(quota.available, false); assert.equal(quota.httpStatus, 429); assert.ok(!JSON.stringify(quota).includes(secret));
  assert.deepEqual(received[0], { path: '/v1/chat/completions', authorization: `Bearer ${secret}`, body: { model: 'k3.1-pro', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false } });
  mode = 'success'; const available = await (await call()).json();
  assert.equal(available.available, true); assert.ok(!JSON.stringify(available).includes(secret));
  for (const next of ['invalid', 'redirect', 'huge']) { mode = next; assert.equal((await (await call()).json()).available, false, next); }
  assert.equal(redirected, false);
  mode = 'slow'; const controller = new AbortController();
  const pending = fetch(`${base}/api/k3/probe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ base: remote, apiKey: secret }), signal: controller.signal }).catch(error => error.name);
  while (received.at(-1)?.path !== '/chat/completions') await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal((await call()).status, 409);
  controller.abort(); assert.equal(await pending, 'AbortError');
  mode = 'success';
  let recovered;
  for (let n = 0; n < 50; n++) { const res = await call(); if (res.status === 200) { recovered = await res.json(); break; } await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.equal(recovered?.available, true, 'disconnect releases probe and aborts curl');
});

test('monitor waits five minutes between completed attempts and notifies once, then stops', async () => {
  const scheduled = []; const changes = []; let notifications = 0, calls = 0;
  const monitor = new AvailabilityMonitor({
    probe: async () => ({ available: ++calls === 2 }), onChange: result => changes.push(result), onAvailable: () => notifications++,
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, unschedule: () => {},
  });
  monitor.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls, 1); assert.equal(scheduled[0].delay, 300000); assert.equal(notifications, 0);
  await scheduled[0].callback();
  assert.equal(calls, 2); assert.equal(notifications, 1); assert.equal(monitor.running, false); assert.equal(scheduled.length, 1);
  assert.equal(changes.at(-1).available, true);
});

test('manual check cancels the pending timer and never overlaps an in-flight probe', async () => {
  const scheduled = []; let calls = 0, resolveProbe;
  const monitor = new AvailabilityMonitor({
    probe: () => { calls++; return new Promise(resolve => { resolveProbe = resolve; }); }, onChange: () => {}, onAvailable: () => {},
    schedule: (callback, delay) => { scheduled.push({ callback, delay }); return scheduled.length; }, unschedule: () => {},
  });
  monitor.start(); assert.equal(calls, 1); assert.equal(monitor.checkNow(), false, 'an active probe is not duplicated');
  resolveProbe({ available: false, message: '限额中' }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(scheduled.length, 1); assert.equal(monitor.checkNow(), true); assert.equal(calls, 2);
  monitor.stop(); resolveProbe({ available: false });
});

test('native-style timer callbacks are called without the monitor as their receiver', async () => {
  const receivers = [];
  function schedule() { receivers.push(this); return 1; }
  function unschedule() { receivers.push(this); }
  const monitor = new AvailabilityMonitor({ probe: async () => ({ available: false }), onChange: () => {}, onAvailable: () => {}, schedule, unschedule });
  monitor.start(); await new Promise(resolve => setImmediate(resolve)); monitor.stop();
  assert.ok(receivers.every(receiver => receiver === undefined), 'timer functions are not invoked as monitor methods');
});

test('stop aborts in-flight request and ignores late results, failed requests schedule retry', async () => {
  let resolveProbe, signal, notifications = 0, scheduled = 0;
  const monitor = new AvailabilityMonitor({ probe: value => { signal = value; return new Promise(resolve => { resolveProbe = resolve; }); }, onChange: () => {}, onAvailable: () => notifications++, schedule: () => scheduled++, unschedule: () => {} });
  monitor.start(); monitor.stop(); assert.equal(signal.aborted, true);
  resolveProbe({ available: true }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(notifications, 0); assert.equal(scheduled, 0);
  monitor.probe = async () => { throw new Error('network'); };
  monitor.start(); await new Promise(resolve => setImmediate(resolve)); assert.equal(scheduled, 1); monitor.stop();
});

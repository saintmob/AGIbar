import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../server.mjs';
import { defaults, validate, command, runCurl } from '../lib/h3.mjs';

const listen = server => new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`)));
const close = server => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); });
const request = (base, data) => fetch(`${base}/api/jobs`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) });
async function completed(base, id) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const result = await (await fetch(`${base}/api/jobs/${id}`)).json();
    if (result.status !== 'running') return result;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error('curl did not complete');
}

test('validation and shell preview reject unsafe values and preserve literal fields', () => {
  const value = { ...defaults, apiKey: 'test-secret' };
  assert.throws(() => validate({ ...value, apiKey: 'secret\nInjected: yes' }), /API key/);
  assert.throws(() => validate({ ...value, endpoint: 'file:///etc/passwd' }), /HTTP/);
  assert.throws(() => validate({ ...value, endpoint: 'http://external.example/a' }), /HTTPS/);
  assert.throws(() => validate({ ...value, width: 0 }), /width/);
  assert.throws(() => validate({ ...value, extra_params: [] }), /JSON/);
  assert.throws(() => validate({ ...value, extra_params: { duration: -1 } }), /duration/);
  const preview = command(validate({ ...value, prompt: "@/etc/passwd; $(touch /tmp/nope) it's literal" }));
  assert.ok(preview.includes('--form-string'));
  assert.ok(preview.includes('--fail-with-body'));
  assert.ok(preview.includes('$H3_API_KEY'));
  assert.ok(!preview.includes(value.apiKey));
  assert.ok(preview.includes("it'\\''s literal"));
});

test('local API uses actual curl for MP4, preserves HTTP error, guards access and supports cancellation', async t => {
  let received;
  const mp4 = Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.alloc(12)]);
  const upstream = http.createServer(async (req, res) => {
    const chunks = []; for await (const chunk of req) chunks.push(chunk);
    received = { headers: req.headers, body: Buffer.concat(chunks).toString() };
    if (req.url === '/slow') return;
    if (req.url === '/error') { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ error: 'bad request', reflected: 'test-secret' })); }
    if (req.url === '/json') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"message":"not a video"}'); }
    res.writeHead(200, { 'Content-Type': 'video/mp4' }); res.end(mp4);
  });
  const upstreamBase = await listen(upstream);
  const app = createApp(); const base = await listen(app);
  t.after(async () => { await close(app); await close(upstream); });
  const value = { ...defaults, endpoint: `${upstreamBase}/video`, apiKey: 'test-secret', prompt: '@/etc/passwd; $(uname)' };
  assert.deepEqual(await (await fetch(`${base}/api/jobs`)).json(), { jobs: [] });
  assert.equal((await fetch(`${base}/api/jobs`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  assert.equal((await fetch(`${base}/`)).status, 200);
  assert.equal((await fetch(`${base}/style.css`)).status, 200);
  assert.equal((await fetch(`${base}/api/defaults`, { headers: { Origin: 'https://evil.example' } })).status, 403);
  const badHostStatus = await new Promise((resolve, reject) => { http.get(`${base}/api/defaults`, { headers: { Host: 'evil.example' } }, res => { res.resume(); resolve(res.statusCode); }).on('error', reject); });
  assert.equal(badHostStatus, 403);
  assert.equal((await request(base, { ...value, apiKey: '' })).status, 400);
  const created = await (await request(base, value)).json();
  const success = await completed(base, created.id);
  assert.equal(success.ok, true); assert.equal(success.httpStatus, 200);
  assert.equal(received.headers.authorization, 'Bearer test-secret');
  assert.match(received.headers['content-type'], /^multipart\/form-data/);
  for (const field of ['prompt','width','height','aspect_ratio','fps','num_inference_steps','flow_shift','seed','extra_params']) assert.ok(received.body.includes(`name="${field}"`));
  assert.ok(received.body.includes('@/etc/passwd; $(uname)'));
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/jobs/${created.id}/download`)).arrayBuffer()), mp4);
  assert.ok(!JSON.stringify(success).includes('test-secret'));
  const failed = await (await request(base, { ...value, endpoint: `${upstreamBase}/error` })).json();
  const failure = await completed(base, failed.id);
  assert.equal(failure.ok, false); assert.equal(failure.httpStatus, 400); assert.equal(failure.curlExitCode, 22);
  assert.match(failure.body, /bad request/); assert.match(failure.body, /REDACTED/); assert.ok(!JSON.stringify(failure).includes('test-secret'));
  assert.equal((await fetch(`${base}/api/jobs/${failed.id}/download`)).status, 409);
  const jsonJob = await (await request(base, { ...value, endpoint: `${upstreamBase}/json` })).json();
  const nonVideo = await completed(base, jsonJob.id); assert.equal(nonVideo.ok, false); assert.equal(nonVideo.curlExitCode, 0); assert.match(nonVideo.body, /not a video/);
  const slow = await (await request(base, { ...value, endpoint: `${upstreamBase}/slow` })).json();
  const history = await (await fetch(`${base}/api/jobs`)).json();
  assert.deepEqual(history.jobs.map(job => job.id), [slow.id, jsonJob.id, failed.id, created.id]);
  assert.deepEqual(history.jobs.map(job => job.status), ['running', 'error', 'error', 'done']);
  for (const job of history.jobs) {
    assert.deepEqual(Object.keys(job).sort(), ['created', 'finished', 'id', 'status']);
    assert.equal(typeof job.created, 'number');
    assert.equal(job.finished === null, job.status === 'running');
  }
  assert.equal(history.jobs[0].created, slow.created);
  assert.ok(!JSON.stringify(history).includes('test-secret'));
  // Re-fetching the list models a new page session; completed downloads remain available.
  assert.deepEqual(Buffer.from(await (await fetch(`${base}/api/jobs/${history.jobs[3].id}/download`)).arrayBuffer()), mp4);
  assert.equal((await request(base, value)).status, 409);
  assert.equal((await fetch(`${base}/api/jobs/${slow.id}`, { method: 'DELETE' })).status, 200);
  const cancelled = await completed(base, slow.id); assert.equal(cancelled.ok, false); assert.equal(cancelled.signal, 'SIGTERM');
});

test('upstream reflected keys are redacted before any response files are persisted', async t => {
  const key = 'sk-agi_bar-static';
  const upstream = http.createServer(async (req, res) => {
    for await (const chunk of req) { /* consume multipart */ }
    if (req.url === '/video') {
      res.writeHead(200, { 'Content-Type': 'video/mp4', 'X-Reflected-Key': key });
      return res.end(Buffer.concat([Buffer.from([0, 0, 0, 24]), Buffer.from('ftypisom'), Buffer.from(key)]));
    }
    res.writeHead(400, { 'Content-Type': 'application/json', 'X-Reflected-Key': key });
    res.write(`{"error":"${key.slice(0, 6)}`);
    setTimeout(() => res.end(`${key.slice(6)}","again":"${key}"}`), 10);
  });
  const base = await listen(upstream);
  const directory = await mkdtemp(join(tmpdir(), 'agibar-redaction-test-'));
  t.after(async () => { await close(upstream); await rm(directory, { recursive: true, force: true }); });
  const value = { ...defaults, apiKey: key, endpoint: `${base}/error` };
  const result = await runCurl(value, directory);
  assert.equal(result.httpStatus, 400); assert.equal(result.curlExitCode, 22);
  for (const file of ['response.bin', 'headers.txt']) {
    const bytes = await readFile(join(directory, file));
    assert.equal(bytes.includes(Buffer.from(key)), false, `${file} must never contain raw key`);
    assert.ok(bytes.includes(Buffer.from('[REDACTED]')));
  }
  assert.ok(!JSON.stringify(result).includes(key));
  const videoResult = await runCurl({ ...value, endpoint: `${base}/video` }, directory);
  assert.equal(videoResult.ok, false);
  assert.match(videoResult.message, /阻止下载/);
  for (const file of ['response.bin', 'headers.txt']) assert.equal((await readFile(join(directory, file))).includes(Buffer.from(key)), false);
});

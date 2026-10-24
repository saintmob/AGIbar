import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaults, validate, command, runCurl } from './lib/h3.mjs';
import { validateProbe, probeK3 } from './lib/k3.mjs';

export function createApp() {
  const jobs = new Map();
  let starting = false;
  let probing = false;
  const base = dirname(fileURLToPath(import.meta.url));
  const server = http.createServer(async (req, res) => {
    const json = (status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify(data)); };
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; media-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
    const host = req.headers.host;
    const expected = `127.0.0.1:${server.address().port}`;
    if (host !== expected && host !== `localhost:${server.address().port}`) return json(403, { error: '仅接受本机访问。' });
    if (req.headers.origin && req.headers.origin !== `http://${host}`) return json(403, { error: '拒绝跨域访问。' });
    const path = new URL(req.url, `http://${host}`).pathname;
    try {
      if (req.method === 'GET' && path === '/api/defaults') return json(200, defaults);
      if (req.method === 'GET' && path === '/api/jobs') {
        const history = [...jobs.values()].reverse().map(job => ({
          id: job.id, status: job.status, created: job.created, finished: job.finished ?? null,
        }));
        return json(200, { jobs: history });
      }
      if (req.method === 'POST' && path === '/api/k3/probe') {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 application/json。' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 8000) return json(413, { error: '请求过大。' }); }
        let value;
        try { value = validateProbe(JSON.parse(raw)); } catch (error) { return json(400, { error: error.message }); }
        if (probing) return json(409, { error: '已有 K3 探测执行中。' });
        probing = true;
        const controller = new AbortController();
        const cancel = () => { if (!res.writableEnded) controller.abort(); };
        res.on('close', cancel);
        try {
          const result = await probeK3(value, controller.signal);
          if (!res.destroyed) return json(200, { ...result, checkedAt: new Date().toISOString() });
          return;
        } finally { probing = false; res.off('close', cancel); }
      }
      if (req.method === 'POST' && ['/api/preview', '/api/jobs'].includes(path)) {
        if (!req.headers['content-type']?.startsWith('application/json')) return json(415, { error: '需要 application/json。' });
        let raw = '';
        for await (const chunk of req) { raw += chunk; if (Buffer.byteLength(raw) > 64000) { json(413, { error: '请求过大。' }); return; } }
        let value;
        try { value = validate(JSON.parse(raw)); } catch (error) { return json(400, { error: error.message }); }
        if (path === '/api/preview') return json(200, { command: command(value) });
        if (starting || [...jobs.values()].some(job => job.status === 'running')) return json(409, { error: '已有请求执行中，请等待或取消。' });
        const id = randomUUID();
        let directory;
        starting = true;
        try { directory = await mkdtemp(join(tmpdir(), 'agibar-h3-')); }
        finally { starting = false; }
        const job = { id, directory, status: 'running', created: Date.now() };
        jobs.set(id, job);
        runCurl(value, directory, { onChild: child => { job.child = child; } }).then(result => { job.result = result; job.status = result.ok ? 'done' : 'error'; job.finished = Date.now(); job.child = null; }).catch(error => { job.result = { ok: false, message: '执行失败', stderr: error.message.replaceAll(value.apiKey, '[REDACTED]') }; job.status = 'error'; job.finished = Date.now(); job.child = null; });
        return json(202, { id, status: job.status, created: job.created });
      }
      const match = path.match(/^\/api\/jobs\/([a-f0-9-]+)(\/download)?$/);
      if (match) {
        const job = jobs.get(match[1]);
        if (!job) return json(404, { error: '结果不存在或已过期。' });
        if (req.method === 'DELETE' && !match[2]) { job.child?.kill('SIGTERM'); return json(200, { cancelled: true }); }
        if (req.method === 'GET' && !match[2]) return json(200, { id: job.id, status: job.status, created: job.created, finished: job.finished ?? null, ...job.result });
        if (req.method === 'GET' && match[2]) {
          if (!job.result?.ok) return json(409, { error: '没有可下载的 MP4。' });
          res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': job.result.size, 'Content-Disposition': 'inline; filename="h3-video.mp4"' });
          createReadStream(join(job.directory, 'response.bin')).pipe(res);
          return;
        }
      }
      const assets = { '/': ['index.html', 'text/html; charset=utf-8'], '/app.js': ['app.js', 'text/javascript; charset=utf-8'], '/monitor.js': ['monitor.js', 'text/javascript; charset=utf-8'], '/style.css': ['style.css', 'text/css; charset=utf-8'] };
      if (req.method === 'GET' && assets[path]) { const [file, type] = assets[path]; res.writeHead(200, { 'Content-Type': type }); res.end(await readFile(join(base, 'public', file))); return; }
      json(404, { error: '未找到资源。' });
    } catch { if (!res.headersSent) json(500, { error: '本地服务发生错误。' }); else res.end(); }
  });
  const cleanup = setInterval(() => {
    for (const [id, job] of jobs) if (job.status !== 'running' && Date.now() - job.created > 3600000) { jobs.delete(id); rm(job.directory, { recursive: true, force: true }).catch(() => {}); }
  }, 60000);
  cleanup.unref();
  server.on('close', () => { clearInterval(cleanup); for (const job of jobs.values()) { job.child?.kill('SIGTERM'); rm(job.directory, { recursive: true, force: true }).catch(() => {}); } });
  return server;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.PORT || 4317);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须在 1–65535 之间。');
  const server = createApp();
  server.listen(port, '127.0.0.1', () => console.log(`H3 工作台：http://127.0.0.1:${port}`));
  server.on('error', error => { console.error(error.message); process.exitCode = 1; });
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { server.close(); server.closeAllConnections(); });
}

import { spawn } from 'node:child_process';
import { writeFile } from 'node:fs/promises';

export const defaults = {
  endpoint: 'https://token.agi.bar/minimax-h3/head/v1/videos/sync',
  prompt: 'A cinematic paper boat crosses a rain puddle while rainfall and distant city ambience remain synchronized.',
  width: 1024, height: 576, aspect_ratio: '16:9', fps: 24,
  num_inference_steps: 50, flow_shift: 12, seed: 1101,
  extra_params: { task: 't2va', duration: 5, audio_flow_shift: 3 },
};

export function validate(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须是对象。');
  const value = {};
  let url;
  try { url = new URL(input.endpoint); } catch { throw new Error('请输入有效的 endpoint URL。'); }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.hash) throw new Error('Endpoint 只支持无用户名、密码和片段的 HTTP(S) URL。');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非本机 endpoint 必须使用 HTTPS，避免泄露密钥。');
  value.endpoint = url.href;
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) throw new Error('请输入有效 API key（不允许换行）。');
  value.apiKey = input.apiKey.trim();
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw new Error('提示词不能为空，最多 20,000 字符。');
  value.prompt = input.prompt.trim();
  for (const [name, min, max, integer] of [
    ['width', 64, 4096, true], ['height', 64, 4096, true], ['fps', 1, 120, true],
    ['num_inference_steps', 1, 200, true], ['flow_shift', 0, 100, false], ['seed', -1, 2147483647, true],
  ]) {
    const number = input[name];
    if (typeof number !== 'number' || !Number.isFinite(number) || number < min || number > max || (integer && !Number.isInteger(number))) throw new Error(`${name} 必须在 ${min}–${max} 之间${integer ? '且为整数' : ''}。`);
    value[name] = number;
  }
  if (typeof input.aspect_ratio !== 'string' || !/^\d{1,3}:\d{1,3}$/.test(input.aspect_ratio) || input.aspect_ratio.split(':').some(n => Number(n) === 0)) throw new Error('宽高比格式应为 16:9，且两项必须大于 0。');
  value.aspect_ratio = input.aspect_ratio;
  if (!input.extra_params || typeof input.extra_params !== 'object' || Array.isArray(input.extra_params) || JSON.stringify(input.extra_params).length > 12000) throw new Error('extra_params 必须是 JSON 对象，最多 12,000 字符。');
  value.extra_params = input.extra_params;
  if (typeof value.extra_params.duration !== 'number' || !Number.isFinite(value.extra_params.duration) || value.extra_params.duration < 0.1 || value.extra_params.duration > 60) throw new Error('extra_params.duration 必须在 0.1–60 秒之间。');
  return value;
}

export function fields(value) {
  return ['prompt', 'width', 'height', 'aspect_ratio', 'fps', 'num_inference_steps', 'flow_shift', 'seed', 'extra_params'].map(name => `${name}=${name === 'extra_params' ? JSON.stringify(value[name]) : value[name]}`);
}

const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
export function command(value) {
  return ['curl --request POST --fail-with-body --http1.1', `  --url ${quote(value.endpoint)}`, '  --header "Authorization: Bearer $H3_API_KEY"', ...fields(value).map(field => `  --form-string ${quote(field)}`), '  --output h3-video.mp4'].join(' \\\n');
}

export async function runCurl(value, directory, { onChild = () => {} } = {}) {
  const output = `${directory}/response.bin`;
  const headers = `${directory}/headers.txt`;
  // Raw upstream data stays in memory. Only redacted bytes may reach disk.
  const args = ['--disable', '--request', 'POST', '--fail-with-body', '--http1.1', '--silent', '--show-error', '--connect-timeout', '30', '--max-time', '1200', '--max-filesize', '157286400', '--proto', '=http,https', '--url', value.endpoint, '--header', '@-', ...fields(value).flatMap(field => ['--form-string', field]), '--include', '--suppress-connect-headers', '--output', '-', '--write-out', '%{http_code}'];
  const started = Date.now();
  const result = await new Promise(resolve => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    onChild(child);
    const chunks = [];
    let total = 0, stderr = '', overflow = false;
    child.stdout.on('data', chunk => {
      total += chunk.length;
      if (total > 158334976) { overflow = true; child.kill('SIGTERM'); return; }
      chunks.push(chunk);
    });
    child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-20000); });
    child.stdin.on('error', () => {});
    child.once('error', error => resolve({ code: null, stdout: Buffer.concat(chunks), stderr: error.message }));
    child.once('close', (code, signal) => resolve({ code, signal, stdout: Buffer.concat(chunks), stderr: overflow ? '响应超过本地内存保护限制。' : stderr }));
    child.stdin.end(`Authorization: Bearer ${value.apiKey}\n`);
  });
  const redact = text => text.replaceAll(value.apiKey, '[REDACTED]');
  const secret = Buffer.from(value.apiKey);
  const redactBytes = buffer => {
    const parts = [];
    let offset = 0, match;
    while ((match = buffer.indexOf(secret, offset)) !== -1) { parts.push(buffer.subarray(offset, match), Buffer.from('[REDACTED]')); offset = match + secret.length; }
    parts.push(buffer.subarray(offset));
    return Buffer.concat(parts);
  };
  const suffix = result.stdout.subarray(-3).toString('ascii');
  const hasStatus = /^\d{3}$/.test(suffix);
  const raw = hasStatus ? result.stdout.subarray(0, -3) : result.stdout;
  let offset = 0, rawHeaders = '';
  // --include may emit interim 100/103 responses before the final response.
  while (raw.subarray(offset, offset + 5).toString('ascii') === 'HTTP/') {
    const end = raw.indexOf('\r\n\r\n', offset);
    if (end < 0) break;
    const block = raw.subarray(offset, end + 4).toString('utf8');
    rawHeaders += block;
    offset = end + 4;
    if (!/^HTTP\/\S+ 1\d\d\b/.test(block)) break;
  }
  const rawBody = raw.subarray(offset);
  const headerText = redact(rawHeaders);
  const reflectedKey = rawBody.includes(secret);
  const buffer = redactBytes(rawBody);
  await Promise.all([writeFile(output, buffer, { mode: 0o600 }), writeFile(headers, headerText, { mode: 0o600 })]);
  const contentType = [...headerText.matchAll(/^content-type:\s*(.+)$/gim)].at(-1)?.[1].trim() || '';
  const size = buffer.length;
  const isVideo = buffer.length >= 12 && buffer.toString('ascii', 4, 8) === 'ftyp';
  const httpStatus = hasStatus ? Number(suffix) : 0;
  const ok = result.code === 0 && httpStatus >= 200 && httpStatus < 300 && isVideo && !reflectedKey;
  return { ok, httpStatus, curlExitCode: result.code, signal: result.signal, contentType, size,
    elapsedMs: Date.now() - started, stderr: redact(result.stderr), headers: headerText,
    body: isVideo ? '' : redact(buffer.subarray(0, 64000).toString('utf8')),
    message: reflectedKey && isVideo ? '视频响应包含 API key，已脱敏并阻止下载。' : ok ? '视频生成完成' : result.signal ? '请求已取消' : result.code === 0 && !isVideo ? '接口未返回 MP4，请查看响应内容。' : 'curl 请求失败，请检查错误与响应内容。',
  };
}

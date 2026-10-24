import { spawn } from 'node:child_process';

export function validateProbe(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须是对象。');
  let url;
  try { url = new URL(input.base); } catch { throw new Error('请输入有效 Base URL。'); }
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new Error('Base URL 必须是无凭据、查询或片段的 HTTP(S) 地址。');
  if (url.protocol !== 'https:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('非本机 Base URL 必须使用 HTTPS。');
  if (typeof input.apiKey !== 'string' || !input.apiKey.trim() || input.apiKey.length > 4096 || /[\r\n\0]/.test(input.apiKey)) throw new Error('请输入有效 API key。');
  return { endpoint: `${url.href.replace(/\/+$/, '')}/chat/completions`, apiKey: input.apiKey.trim() };
}

export async function probeK3(value, signal) {
  if (signal?.aborted) return { available: false, httpStatus: 0, message: '探测已取消。' };
  const body = JSON.stringify({ model: 'k3.1-pro', messages: [{ role: 'user', content: 'Hi' }], max_tokens: 1, stream: false });
  const args = ['--disable', '--silent', '--show-error', '--request', 'POST', '--connect-timeout', '10', '--max-time', '45', '--max-filesize', '65536', '--proto', '=http,https', '--url', value.endpoint, '--header', '@-', '--header', 'Content-Type: application/json', '--data-raw', body, '--output', '-', '--write-out', '\n%{http_code}'];
  const result = await new Promise(resolve => {
    const child = spawn('curl', args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const chunks = []; let size = 0, overflow = false;
    const cancel = () => child.kill('SIGTERM');
    signal?.addEventListener('abort', cancel, { once: true });
    child.stdout.on('data', chunk => { size += chunk.length; if (size > 65540) { overflow = true; cancel(); } else chunks.push(chunk); });
    child.stderr.resume(); // Never expose upstream diagnostics or credentials.
    child.stdin.on('error', () => {});
    child.once('error', () => { signal?.removeEventListener('abort', cancel); resolve({ code: -1, raw: '' }); });
    child.once('close', code => { signal?.removeEventListener('abort', cancel); resolve({ code, raw: overflow ? '' : Buffer.concat(chunks).toString('utf8') }); });
    child.stdin.end(`Authorization: Bearer ${value.apiKey}\n`);
    if (signal?.aborted) cancel();
  });
  const status = result.raw.match(/\n(\d{3})$/);
  const httpStatus = status ? Number(status[1]) : 0;
  let response;
  try { response = JSON.parse(result.raw.slice(0, -4)); } catch {}
  const available = result.code === 0 && httpStatus >= 200 && httpStatus < 300 && !response?.error && Array.isArray(response?.choices) && response.choices.some(choice => choice?.message && typeof choice.message === 'object');
  return { available, httpStatus, message: available ? 'Kimi K3.1 Pro 已可用，监测已停止。' : httpStatus === 429 ? 'HTTP 429：额度或速率受限，等待下一次探测。' : httpStatus ? `HTTP ${httpStatus}：尚未确认可用，等待下一次探测。` : '连接失败、超时或探测已取消，等待下一次探测。' };
}

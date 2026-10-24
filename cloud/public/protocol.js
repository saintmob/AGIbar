export const H3_ENDPOINT = 'https://token.agi.bar/minimax-h3/head/v1/videos/sync';
export const KIMI_ENDPOINT = 'https://token.agi.bar/v1/chat/completions';
export function validateH3(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('请求必须是对象。');
  if (typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 20000) throw new Error('提示词须为 1–20,000 字符。');
  const value = { prompt: input.prompt.trim() };
  for (const [name, min, max, integer] of [['width',64,4096,true],['height',64,4096,true],['fps',1,120,true],['seed',-1,2147483647,true],['num_inference_steps',1,200,true],['flow_shift',0,100,false]]) {
    const n = input[name];
    if (typeof n !== 'number' || !Number.isFinite(n) || n < min || n > max || (integer && !Number.isInteger(n))) throw new Error(`${name} 参数无效。`);
    value[name] = n;
  }
  if (typeof input.aspect_ratio !== 'string' || !/^\d{1,3}:\d{1,3}$/.test(input.aspect_ratio) || input.aspect_ratio.split(':').some(n => !Number(n))) throw new Error('画面比例无效。');
  value.aspect_ratio = input.aspect_ratio;
  if (!input.extra_params || typeof input.extra_params !== 'object' || Array.isArray(input.extra_params) || JSON.stringify(input.extra_params).length > 12000) throw new Error('extra_params 必须为 JSON 对象，最多 12,000 字符。');
  const duration = input.extra_params.duration;
  if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0.1 || duration > 60) throw new Error('duration 须在 0.1–60 秒之间。');
  value.extra_params = input.extra_params;
  return value;
}
export function h3Request(input, apiKey, signal) {
  const value = validateH3(input); const body = new FormData();
  for (const [name, value_] of Object.entries(value)) body.set(name, name === 'extra_params' ? JSON.stringify(value_) : String(value_));
  return { method:'POST', headers:{Authorization:`Bearer ${apiKey}`}, body, redirect:'error', signal };
}
export function h3HealthRequest(apiKey, signal) {
  // `OPTIONS` only succeeds as the browser's CORS preflight; the subsequent
  // application request is 405. Send a deliberately incomplete JSON payload
  // instead: H3 rejects it at input validation (HTTP 400) before a job exists.
  return { method:'POST', headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'}, body:'{}', redirect:'error', signal };
}
export function kimiRequest(apiKey, signal, content = 'Hi', maxTokens = 1) {
  if (typeof content !== 'string' || !content.trim() || content.length > 20000) throw new Error('提示词须为 1–20,000 字符。');
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 4096) throw new Error('最大输出 Tokens 须为 1–4096。');
  return { method:'POST', headers:{Authorization:`Bearer ${apiKey}`,'Content-Type':'application/json'}, body:JSON.stringify({model:'k3.1-pro',messages:[{role:'user',content}],max_tokens:maxTokens,stream:false}),redirect:'error',signal };
}
export function isAvailable(response, data) { return response.ok && !data?.error && Array.isArray(data?.choices) && data.choices.some(c => c?.message && typeof c.message === 'object'); }
export async function readLimited(response, limit = 48 * 1024 * 1024) {
  const reader = response.body?.getReader();if(!reader)return new Uint8Array();
  const chunks=[];let size=0;
  try {while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>limit){await reader.cancel();throw new Error('响应超过浏览器内存保护限制。');}chunks.push(value);}}
  finally{reader.releaseLock();}
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return bytes;
}
export function isMp4(bytes) { return bytes.length >= 12 && new TextDecoder().decode(bytes.slice(4,8)) === 'ftyp'; }
export function containsSecret(bytes, apiKey) {
  const secret=new TextEncoder().encode(apiKey);if(!secret.length)return false;
  outer:for(let i=0;i<=bytes.length-secret.length;i++){for(let j=0;j<secret.length;j++)if(bytes[i+j]!==secret[j])continue outer;return true;}return false;
}

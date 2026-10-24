import { H3_ENDPOINT, KIMI_ENDPOINT, h3Request, h3HealthRequest, kimiRequest, isAvailable, readLimited, isMp4, containsSecret } from './protocol.js';
const $ = selector => document.querySelector(selector);
const form = $('#h3-form');
const defaults = { prompt: 'A cinematic paper boat crosses a rain puddle while rainfall and distant city ambience remain synchronized.', width: 1024, height: 576, aspect_ratio: '16:9', fps: 24, seed: 1101, num_inference_steps: 50, flow_shift: 12, extra_params: { task: 't2va', duration: 5, audio_flow_shift: 3 } };
const numeric = ['width','height','fps','seed','num_inference_steps','flow_shift'];
const namespace = 'agibar.public.v1.';
function load(name, fallback) { try { return JSON.parse(localStorage.getItem(namespace + name)) ?? fallback; } catch { return fallback; } }
function save(name, value) {
  try { localStorage.setItem(namespace + name, JSON.stringify(value)); return true; }
  catch { $('#storage-warning').textContent = '浏览器存储不可用或已满；本轮仍可使用，刷新后可能丢失。请下载视频或清空历史。'; return false; }
}
let history = load('history', []);
if (!Array.isArray(history)) history = [];
history = history.filter(job => job && typeof job.id === 'string').slice(0,10);
for (const job of history) if (job.status === 'running') { job.status = 'interrupted'; job.message = '页面已重新打开，原同步请求无法恢复；请先确认上游情况，再决定是否重新生成。'; }
save('history', history);
try { localStorage.removeItem(namespace + 'monitor'); } catch {}
let settings = load('settings', {});
if (!settings || typeof settings !== 'object') settings = {};
settings = { apiKey: settings.apiKey };
settings.apiKey ??= 'sk-agi_bar-static';
$('#api-key').value = settings.apiKey;
save('settings',settings);
let theme = load('theme', 'system');
function applyTheme() { const dark = theme === 'dark' || (theme === 'system' && typeof matchMedia === 'function' && matchMedia('(prefers-color-scheme: dark)').matches); if (document.documentElement?.dataset) document.documentElement.dataset.theme = dark ? 'dark' : 'light'; $('#theme-toggle').textContent = dark ? '☀︎ 浅色' : '◐ 深色'; }
applyTheme();
$('#theme-toggle').addEventListener('click', () => { theme = document.documentElement?.dataset?.theme === 'dark' ? 'light' : 'dark'; save('theme', theme); applyTheme(); });
let selectedTab = load('tab', 'minimax');
function switchTab(name) {
  selectedTab = name;
  for (const tab of ['minimax','kimi']) { const active = tab === name; $(`#${tab}`).hidden = !active; $(`#tab-${tab}`).classList.toggle('active',active); $(`#tab-${tab}`).setAttribute('aria-selected',String(active)); }
  save('tab', name);
}
for (const name of ['minimax','kimi']) $(`#tab-${name}`).addEventListener('click', () => switchTab(name));
switchTab(selectedTab === 'kimi' ? 'kimi' : 'minimax');
$('#open-config').addEventListener('click', () => $('#config').showModal());
$('#save-config').addEventListener('click', () => {
  const key = $('#api-key').value.trim();
  if (!key || /[\r\n\0]/.test(key)) { $('#storage-warning').textContent = '请填写有效 API key。'; return; }
  if (active || chatController || healthControllers.minimax || healthControllers.kimi) { $('#storage-warning').textContent = '请等待或取消当前请求后更新配置。'; return; }
  settings = { apiKey:key }; save('settings',settings);
  $('#config').close();
});
$('#show-key').addEventListener('click', () => { const show = $('#api-key').type === 'password'; $('#api-key').type=show?'text':'password';$('#show-key').textContent=show?'隐藏密钥':'显示密钥'; });
function setForm(value) {
  for (const name of Object.keys(defaults)) form.elements[name].value = name === 'extra_params' ? JSON.stringify(value[name] ?? defaults[name],null,2) : value[name] ?? defaults[name];
  form.elements.duration.value = (value.extra_params ?? defaults.extra_params).duration;
  updatePreview();
}
function payload() {
  const value = Object.fromEntries(new FormData(form));
  for (const name of numeric) value[name] = Number(value[name]);
  value.extra_params = JSON.parse(value.extra_params);
  if (!value.extra_params || typeof value.extra_params !== 'object' || Array.isArray(value.extra_params)) throw new Error('extra_params 必须是 JSON 对象。');
  delete value.duration;
  return value;
}
const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;
let command = '';
function updatePreview() {
  try {
    const value = payload(); save('generation',value);
    command = ['curl --request POST --fail-with-body --http1.1', "  --url 'https://token.agi.bar/minimax-h3/head/v1/videos/sync'", '  --header "Authorization: Bearer $H3_API_KEY"', ...Object.entries(value).map(([k,v]) => `  --form-string ${quote(`${k}=${k === 'extra_params' ? JSON.stringify(v) : v}`)}`), '  --output h3-video.mp4'].join(' \\\n');
    $('#command').textContent = command;
  } catch { command = ''; $('#command').textContent = '请检查 extra_params JSON。'; }
}
setForm(load('generation', defaults));
$('#reset').addEventListener('click', () => setForm(defaults));
form.elements.duration.addEventListener('input', () => { try { const extra = JSON.parse(form.elements.extra_params.value); extra.duration = Number(form.elements.duration.value); form.elements.extra_params.value = JSON.stringify(extra,null,2); } catch {} });
form.elements.extra_params.addEventListener('input', () => { try { form.elements.duration.value = JSON.parse(form.elements.extra_params.value).duration; } catch {} });
form.addEventListener('input', updatePreview);
$('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(command); $('#copy').textContent = '已复制'; } catch { $('#copy').textContent = '请选中命令复制'; } });
const setupPrompt = model => model === 'kimi'
  ? `请帮助配置本机可兼容 OpenAI Chat Completions 的 IDE / agent 工具。Kimi K3.1 Pro：Base URL=https://token.agi.bar/v1；API Key=${settings.apiKey}；准确模型名=k3.1-pro；Authorization: Bearer <API key>。先检查目标工具是否支持自定义 Chat Completions；Codex / Claude 原生协议不一定兼容，不要把它当作已支持。若需要桥接，先说明并征得我同意；凭证仅存本机。用 Hi、max_tokens:1、stream:false 做一次最小验证。此接入仅在店内内网有效，遵循上游额度与策略，额度由上游策略决定。`
  : `请帮助在本机配置 MiniMax H3 视频生成工具；它不是 coding / chat 模型，不能替代 Codex 或 Claude 的推理模型。POST https://token.agi.bar/minimax-h3/head/v1/videos/sync；Authorization: Bearer ${settings.apiKey}；使用 curl --http1.1 --fail-with-body 和 multipart --form-string。参数示例：prompt="A paper boat on water",width=1024,height=576,aspect_ratio=16:9,fps=24,seed=1101,num_inference_steps=50,flow_shift=12,extra_params={"task":"t2va","duration":5,"audio_flow_shift":3}。成功应为 MP4；先检查 HTTP 状态再保存视频。凭证仅存本机；健康探测使用刻意缺少 prompt 的 JSON，服务端应在参数校验阶段返回 HTTP 400，且不会创建视频任务。它不能证明视频生成可用。生成会消耗额度，实际生成前由我确认。此接入仅在店内内网有效，遵循上游额度与策略。`;
for (const model of ['minimax','kimi']) $(`#copy-setup-${model}`).addEventListener('click', async () => {
  try { await navigator.clipboard.writeText(setupPrompt(model)); $(`#${model}-setup-status`).textContent = '已复制。请粘贴至本地 Codex / Claude / IDE agent。'; }
  catch { $(`#${model}-setup-status`).textContent = '剪贴板不可用，请从接入配置复制信息。'; }
});
let active, resultUrl;
function persistHistory() {
  if (save('history',history)) return;
  // Retain metadata when localStorage cannot hold another video.
  for (const job of history) if (job.video) { delete job.video; job.cacheNote = '浏览器容量不足，视频未保留；请在当前结果中下载。'; }
  save('history',history);
}
function renderHistory() {
  $('#history').replaceChildren();
  for (const job of history) {
    const button = document.createElement('button'); button.className = 'history-item'; button.disabled = Boolean(active);
    button.textContent = `${new Date(job.created).toLocaleString()} · ${{ running:'生成中',done:'已完成',error:'失败',interrupted:'连接中断',cancelled:'已取消等待' }[job.status] || job.status}`;
    button.addEventListener('click', () => showJob(job)); $('#history').append(button);
  }
}
function showJob(job, blob) {
  if (resultUrl) { URL.revokeObjectURL(resultUrl); resultUrl = null; }
  const result = $('#result'); result.replaceChildren();
  const message = document.createElement('p'); message.textContent = `${job.message || ''}${job.cacheNote ? ` ${job.cacheNote}` : ''}`; result.append(message);
  if (blob || job.video) {
    const src = blob ? (resultUrl = URL.createObjectURL(blob)) : job.video;
    const video = document.createElement('video'); video.controls = true; video.playsInline = true; video.src = src; result.append(video);
    const link = document.createElement('a'); link.className = 'download'; link.href = src; link.download = 'h3-video.mp4'; link.textContent = '↓ 下载 MP4'; result.append(link);
  }
  const detail = document.createElement('pre'); detail.textContent = JSON.stringify({ id:job.id,status:job.status,httpStatus:job.httpStatus,elapsedMs:job.elapsedMs,bytes:job.bytes,body:job.body },null,2); result.append(detail);
}
function busy(value) {
  for (const element of form.elements) element.disabled = value && element.id !== 'cancel';
  $('#cancel').hidden = !value; $('#reset').disabled = value; $('#clear-history').disabled = value;
  renderHistory();
}
const toDataURL = blob => new Promise((resolve,reject) => { const reader = new FileReader(); reader.onload = () => resolve(reader.result); reader.onerror = reject; reader.readAsDataURL(blob); });
form.addEventListener('submit', async event => {
  event.preventDefault(); if (active) return;
  let value; try { value = payload(); } catch { $('#h3-status').textContent = '请检查 extra_params JSON。'; return; }
  const job = { id:crypto.randomUUID(),created:Date.now(),status:'running',message:'等待同步接口返回。' };
  history.unshift(job); history = history.slice(0,10); persistHistory();
  const controller = new AbortController(); active = controller; busy(true); showJob(job);
  const tick = () => { $('#h3-status').textContent = `生成中 · ${Math.floor((Date.now()-job.created)/1000)} 秒。请保持页面开启。`; };
  tick(); const interval = setInterval(tick,1000); const timeout = setTimeout(() => controller.abort(),1200000);
  try {
    const apiKey = settings.apiKey;
    const response = await fetch(H3_ENDPOINT,h3Request(value,apiKey,controller.signal));
    job.httpStatus = response.status;
    job.elapsedMs = Date.now()-job.created;
    const bytes = await readLimited(response);
    if(containsSecret(bytes,apiKey))throw new Error('上游响应包含密钥，已阻止显示或下载。');
    if (!response.ok || !isMp4(bytes)) {
      job.status='error'; job.message=response.ok ? '接口未返回 MP4，请查看响应内容。':`上游 HTTP ${response.status}`; job.body=new TextDecoder().decode(bytes.slice(0,64000)).replaceAll(apiKey,'[REDACTED]'); showJob(job);
    } else {
      const blob = new Blob([bytes],{type:'video/mp4'}); job.bytes=blob.size; job.status='done'; job.message='视频生成完成。';
      if (blob.size <= 2*1024*1024) job.video=await toDataURL(blob);
      else job.cacheNote='视频超过 2 MiB，仅本次页面可下载；历史仅保存状态，请立即下载。';
      persistHistory(); showJob(job,blob);
    }
  } catch (exception) { job.status=controller.signal.aborted ? 'cancelled':'interrupted'; job.message=`${exception instanceof TypeError ? '连接失败：请确认店内 WiFi 与 API 的 CORS 设置。' : exception.message} 等待已中断；上游可能仍在运行或计费，本站无法恢复同步连接。`; showJob(job); }
  finally { clearInterval(interval);clearTimeout(timeout);job.elapsedMs=Date.now()-job.created;active=null;persistHistory();busy(false);$('#h3-status').textContent=job.message; }
});
$('#cancel').addEventListener('click', () => active?.abort());
$('#clear-history').addEventListener('click', () => { history=[];persistHistory();renderHistory();$('#result').replaceChildren();if(resultUrl)URL.revokeObjectURL(resultUrl); });
renderHistory(); if (history[0]) showJob(history[0]);

const healthControllers = { minimax: null, kimi: null };
async function checkHealth(model) {
  if (healthControllers[model]) return;
  const controller = healthControllers[model] = new AbortController();
  const button = $(`#check-${model}`), status = $(`#${model}-health-status`);
  button.disabled = true; status.textContent = '正在探测…';
  const timeout = setTimeout(() => controller.abort(), model === 'kimi' ? 50000 : 15000);
  try {
    const response = await fetch(model === 'kimi' ? KIMI_ENDPOINT : H3_ENDPOINT, model === 'kimi' ? kimiRequest(settings.apiKey,controller.signal) : h3HealthRequest(settings.apiKey,controller.signal));
    if (model === 'minimax') {
      status.textContent = response.status === 400
        ? 'H3 参数校验已返回 HTTP 400，接口可达；本次请求刻意缺少 prompt，未创建视频任务。此结果不能证明视频生成可用。'
        : `接口已返回 HTTP ${response.status}。健康探测使用刻意无效的请求，未提交生成参数；不能证明视频生成可用。`;
    } else {
      const bytes = await readLimited(response,65536); let data;
      try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
      status.textContent = isAvailable(response,data) ? `Kimi K3.1 Pro 已可用 · HTTP ${response.status}，最小 Chat Completion 成功。` : `HTTP ${response.status}：尚未确认 Kimi 可用。`;
    }
  } catch { status.textContent = '连接失败或超时；请检查店内 WiFi、上游 CORS 与服务状态。浏览器无法区分这些原因。'; }
  finally { clearTimeout(timeout); healthControllers[model] = null; button.disabled = false; }
}
for (const model of ['minimax','kimi']) $(`#check-${model}`).addEventListener('click', () => checkHealth(model));
let chatController;
const savedChat = load('kimi-chat', {});
$('#kimi-prompt').value = typeof savedChat?.prompt === 'string' ? savedChat.prompt : '请用一句话介绍你自己。';
$('#kimi-result').textContent = typeof savedChat?.result === 'string' ? savedChat.result : '尚无对话结果。';
$('#kimi-prompt').addEventListener('input', () => save('kimi-chat',{prompt:$('#kimi-prompt').value,result:$('#kimi-result').textContent}));
$('#kimi-form').addEventListener('submit', async event => {
  event.preventDefault(); if (chatController) return;
  const controller = new AbortController(); const prompt = $('#kimi-prompt').value;
  let request; try { request = kimiRequest(settings.apiKey,controller.signal,prompt,Number($('#kimi-tokens').value)); }
  catch (error) { $('#kimi-status').textContent = error.message; return; }
  chatController = controller; $('#send-kimi').disabled = true; $('#cancel-kimi').hidden = false;
  $('#kimi-status').textContent = '等待 Kimi 回复…';
  const timeout = setTimeout(() => controller.abort(),50000);
  try {
    const apiKey = settings.apiKey;
    const response = await fetch(KIMI_ENDPOINT,request);
    const bytes = await readLimited(response,65536);
    if (containsSecret(bytes,apiKey)) throw new Error('上游响应包含密钥，已阻止显示或保存。');
    let data; try { data = JSON.parse(new TextDecoder().decode(bytes)); } catch {}
    if (!isAvailable(response,data)) throw new Error(`HTTP ${response.status}：未收到有效 Chat Completion。`);
    const content = data.choices.find(choice => choice?.message)?.message?.content;
    $('#kimi-result').textContent = typeof content === 'string' ? content : '接口已返回有效消息，但没有可显示的文本内容。';
    save('kimi-chat',{prompt,result:$('#kimi-result').textContent});
    $('#kimi-status').textContent = `回复完成 · HTTP ${response.status}`;
  } catch (error) { $('#kimi-status').textContent = controller.signal.aborted ? '等待已取消或超时；上游可能仍在处理或计费。' : error instanceof TypeError ? '连接失败，请检查店内 WiFi 与上游 CORS。' : error.message; }
  finally { clearTimeout(timeout); chatController = null; $('#send-kimi').disabled = false; $('#cancel-kimi').hidden = true; }
});
$('#cancel-kimi').addEventListener('click', () => chatController?.abort());
$('#clear-kimi').addEventListener('click', () => { $('#kimi-result').textContent = '尚无对话结果。'; save('kimi-chat',{prompt:$('#kimi-prompt').value}); });
window.addEventListener('pagehide',()=>{active?.abort();chatController?.abort();for(const controller of Object.values(healthControllers))controller?.abort();});

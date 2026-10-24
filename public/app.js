import { AvailabilityMonitor } from './monitor.js';

const form = document.querySelector('#form');
const $ = selector => document.querySelector(selector);
const error = $('#form-error');
const apiKeyStorageKey = 'agibar.h3.api-key';
const defaultApiKey = 'sk-agi_bar-static';
let defaults, jobId, timer, polling, started;
let currentCommand = '';
let previewRevision = 0;
let history = [], selectedJobId, selectionRevision = 0, historyLoading = false;
const numeric = ['width', 'height', 'fps', 'seed', 'num_inference_steps', 'flow_shift'];

async function api(path, options = {}) {
  const response = await fetch(path, options);
  const data = await response.json();
  if (!response.ok) { const error = new Error(data.error || `本地服务返回 ${response.status}`); error.status = response.status; throw error; }
  return data;
}
function payload() {
  const data = Object.fromEntries(new FormData(form));
  for (const field of numeric) data[field] = Number(data[field]);
  try { data.extra_params = JSON.parse(data.extra_params); } catch { throw new Error('extra_params 不是有效 JSON，请检查引号与逗号。'); }
  if (!data.extra_params || typeof data.extra_params !== 'object' || Array.isArray(data.extra_params)) throw new Error('extra_params 必须是 JSON 对象。');
  delete data.duration;
  return data;
}
function setDefaults() {
  for (const [name, value] of Object.entries(defaults)) form.elements[name].value = name === 'extra_params' ? JSON.stringify(value, null, 2) : value;
  form.elements.duration.value = defaults.extra_params.duration;
  // Reset affects configuration only; a completed result remains available for download.
  error.hidden = true;
  updateRatios(); updateCount(); preview();
}
function updateCount() { $('#prompt-count').textContent = `${form.elements.prompt.value.length.toLocaleString()} / 20,000`; }
function updateRatios() { for (const button of document.querySelectorAll('[data-ratio]')) { const active = button.dataset.ratio === form.elements.aspect_ratio.value && Number(button.dataset.width) === Number(form.elements.width.value) && Number(button.dataset.height) === Number(form.elements.height.value); button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); } }
async function preview() {
  const revision = ++previewRevision;
  try {
    const value = payload();
    // The preview never sends the user's key. The server validates a placeholder.
    value.apiKey = 'preview-placeholder';
    const result = await api('/api/preview', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    if (revision !== previewRevision) return;
    currentCommand = result.command; $('#command').textContent = currentCommand;
    $('#copy').disabled = false;
  } catch (exception) { if (revision !== previewRevision) return; currentCommand = ''; $('#command').textContent = `请检查配置：${exception.message}`; $('#copy').disabled = true; }
}
function tab(name) {
  for (const value of ['request', 'response']) { const active = value === name; $(`#${value}-tab`).classList.toggle('active', active); $(`#${value}-tab`).setAttribute('aria-selected', String(active)); $(`#${value}-pane`).hidden = !active; }
}
function setBusy(busy) {
  $('#run').disabled = busy; $('#cancel').hidden = !busy;
  for (const element of form.elements) if (element.id !== 'cancel' && element.id !== 'run') element.disabled = busy;
  $('#reset').disabled = busy;
}
function finish(result) {
  clearTimeout(polling); clearInterval(timer); setBusy(false); jobId = null;
  $('#progress').hidden = true;
  $('#status').textContent = result.ok ? '生成完成' : result.signal ? '已取消' : '请求失败';
  $('#status').className = `status ${result.ok ? 'done' : 'error'}`;
  $('#result-message').hidden = result.ok;
  $('#result-message').textContent = result.message || '请求失败，请查看响应详情。';
  $('#response').textContent = [
    `HTTP: ${result.httpStatus || '未收到响应'}    curl exit: ${result.curlExitCode ?? 'N/A'}`,
    `Content-Type: ${result.contentType || '未知'}    Size: ${result.size ?? 0} bytes`,
    `耗时: ${((result.elapsedMs || 0) / 1000).toFixed(1)} 秒`,
    '', '── curl stderr ──', result.stderr || '(empty)', '', '── Response headers ──', result.headers || '(empty)', '', '── Response body ──', result.body || (result.ok ? '(MP4 binary; see video preview)' : '(empty)'),
  ].join('\n');
  $('#metrics').hidden = false; $('#metrics').textContent = `HTTP ${result.httpStatus || '—'}   ·   ${((result.elapsedMs || 0) / 1000).toFixed(1)}s   ·   ${((result.size || 0) / 1048576).toFixed(2)} MB`;
  if (!result.ok) tab('response');
}
function clearResult() {
  $('#empty').hidden = true; $('#video-result').hidden = true; $('#video').removeAttribute('src'); $('#video').load();
  $('#result-message').hidden = true; $('#metrics').hidden = true;
}
function renderHistory() {
  const list = $('#job-list'); list.replaceChildren();
  $('#history-empty').hidden = history.length > 0;
  for (const job of history) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = `history-job${selectedJobId === job.id ? ' selected' : ''}`;
    button.disabled = Boolean(jobId && job.id !== jobId);
    button.setAttribute('aria-pressed', String(selectedJobId === job.id));
    button.textContent = `${new Date(job.created).toLocaleString()} · ${job.status === 'running' ? '生成中' : job.status === 'done' ? '已完成 · 预览 / 下载' : '失败 / 已取消 · 查看详情'} · ${job.id.slice(0, 8)}`;
    button.addEventListener('click', () => selectJob(job)); list.append(button);
  }
}
function trackJob(job) {
  ++selectionRevision; clearTimeout(polling); clearInterval(timer);
  jobId = job.id; selectedJobId = job.id; started = job.created;
  setBusy(true); clearResult();
  $('#progress').hidden = false; $('#status').textContent = '生成中'; $('#status').className = 'status running';
  $('#response').textContent = '请求执行中，等待 curl 返回…';
  const tick = () => { $('#elapsed').textContent = `等待服务端响应 · ${Math.max(0, Math.floor((Date.now() - started) / 1000))} 秒`; };
  tick(); timer = setInterval(tick, 1000); renderHistory(); poll(jobId);
}
async function selectJob(job) {
  if (jobId) return;
  const revision = ++selectionRevision;
  try {
    const result = await api(`/api/jobs/${job.id}`);
    if (revision !== selectionRevision || jobId) return;
    selectedJobId = job.id;
    if (result.status === 'running') { trackJob(result); return; }
    showResult(result); renderHistory();
  } catch (exception) {
    if (revision !== selectionRevision || jobId) return;
    error.textContent = exception.message; error.hidden = false;
    if (exception.status === 404) refreshHistory();
  }
}
function showResult(result) {
  clearResult();
  if (result.ok) { const url = `/api/jobs/${result.id}/download`; $('#video').src = url; $('#download').href = url; $('#video-result').hidden = false; }
  finish(result);
}
async function refreshHistory() {
  if (historyLoading) return;
  historyLoading = true;
  try {
    const data = await api('/api/jobs'); history = data.jobs;
    $('#history-error').hidden = true;
    const running = history.find(job => job.status === 'running');
    if (running && jobId !== running.id) trackJob(running);
    else if (!jobId && !selectedJobId && history.length) selectJob(history[0]);
    renderHistory();
  } catch (exception) { $('#history-error').textContent = `无法同步队列：${exception.message}；稍后自动重试。`; $('#history-error').hidden = false; }
  finally { historyLoading = false; }
}
async function poll(id) {
  if (jobId !== id) return;
  try {
    const result = await api(`/api/jobs/${id}`);
    if (jobId !== id) return;
    if (result.status === 'running') { polling = setTimeout(() => poll(id), 1000); return; }
    showResult(result); refreshHistory();
  } catch (exception) {
    if (jobId !== id) return;
    if (exception.status === 404) {
      ++selectionRevision; selectedJobId = null;
      showResult({ ok: false, message: '任务不存在或已过期；本地服务重启后无法恢复原任务。' });
      refreshHistory(); return;
    }
    // Keep tracking an in-flight curl after a transient local connection failure.
    $('#elapsed').textContent = `本地状态暂时不可用：${exception.message}；正在重试…`;
    polling = setTimeout(() => poll(id), 3000);
  }
}
form.addEventListener('submit', async event => {
  event.preventDefault(); error.hidden = true;
  try {
    const value = payload();
    setBusy(true);
    const result = await api('/api/jobs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(value) });
    trackJob(result); refreshHistory();
    if (matchMedia('(max-width:760px)').matches) $('.preview').scrollIntoView({ behavior: 'smooth' });
  } catch (exception) { setBusy(Boolean(jobId)); error.textContent = exception.message; error.hidden = false; if (exception.status === 409) refreshHistory(); }
});
$('#cancel').addEventListener('click', async () => { if (!jobId) return; $('#cancel').disabled = true; try { await api(`/api/jobs/${jobId}`, { method: 'DELETE' }); } catch (exception) { error.textContent = exception.message; error.hidden = false; } finally { $('#cancel').disabled = false; } });
$('#reset').addEventListener('click', setDefaults);
$('#show-key').addEventListener('click', () => { const shown = form.elements.apiKey.type === 'password'; form.elements.apiKey.type = shown ? 'text' : 'password'; $('#show-key').textContent = shown ? '隐藏' : '显示'; $('#show-key').setAttribute('aria-label', shown ? '隐藏 API key' : '显示 API key'); $('#show-key').setAttribute('aria-pressed', String(shown)); });
$('#forget-key').addEventListener('click', () => { try { localStorage.removeItem(apiKeyStorageKey); } catch {} form.elements.apiKey.value = ''; form.elements.apiKey.focus(); });
form.elements.apiKey.addEventListener('input', () => { try { localStorage.setItem(apiKeyStorageKey, form.elements.apiKey.value); } catch {} });
for (const button of document.querySelectorAll('[data-prompt]')) button.addEventListener('click', () => { form.elements.prompt.value = button.dataset.prompt; updateCount(); preview(); });
for (const button of document.querySelectorAll('[data-ratio]')) button.addEventListener('click', () => { form.elements.width.value = button.dataset.width; form.elements.height.value = button.dataset.height; form.elements.aspect_ratio.value = button.dataset.ratio; updateRatios(); preview(); });
form.elements.duration.addEventListener('input', () => { try { const extra = JSON.parse(form.elements.extra_params.value); if (!extra || typeof extra !== 'object' || Array.isArray(extra)) return; extra.duration = Number(form.elements.duration.value); form.elements.extra_params.value = JSON.stringify(extra, null, 2); } catch {} });
form.elements.extra_params.addEventListener('input', () => { try { const extra = JSON.parse(form.elements.extra_params.value); if (typeof extra.duration === 'number') form.elements.duration.value = extra.duration; } catch {} });
let debounce;
form.addEventListener('input', () => { updateCount(); updateRatios(); clearTimeout(debounce); debounce = setTimeout(preview, 200); });
$('#request-tab').addEventListener('click', () => tab('request'));
$('#response-tab').addEventListener('click', () => tab('response'));
$('#copy').addEventListener('click', async () => { try { await navigator.clipboard.writeText(currentCommand); $('#copy').textContent = '已复制'; } catch { $('#copy').textContent = '请选中命令复制'; } setTimeout(() => { $('#copy').textContent = '复制命令'; }, 2000); });
api('/api/defaults').then(data => {
  defaults = data; setDefaults();
  try { form.elements.apiKey.value = localStorage.getItem(apiKeyStorageKey) || defaultApiKey; } catch { form.elements.apiKey.value = defaultApiKey; }
  refreshHistory(); setInterval(refreshHistory, 5000);
}).catch(exception => { error.textContent = `无法读取本地配置：${exception.message}`; error.hidden = false; $('#run').disabled = true; });

let monitorSettings;
let notificationSession;
function updateNotification(session) {
  if (notificationSession !== session) return;
  if (!('Notification' in window)) { $('#k3-notification').textContent = '此浏览器不支持系统通知；可用时会在此页面提示并停止。'; return; }
  const permission = Notification.permission;
  $('#k3-notification').textContent = permission === 'granted' ? `通知权限已允许；${session.available ? 'K3 已可用，已尝试发送一次系统通知；监测已停止。' : '恢复可用时通知一次并停止。'}` : permission === 'default' ? `等待浏览器通知权限；${session.available ? 'K3 已可用，监测已停止，允许后将通知一次。' : '监测已启动，不受权限等待影响。'}` : '未获通知权限；可用时会在此页面提示并停止，可在浏览器站点设置中允许通知。';
  if (session.available && !session.notified && permission === 'granted') {
    session.notified = true;
    try { new Notification('Kimi K3.1 Pro 已可用', { body: 'k3.1-pro 探测成功，监测已停止。', tag: 'agibar-k3-available' }); }
    catch { $('#k3-notification').textContent = 'K3 已可用；浏览器无法显示系统通知，请查看页面状态。'; }
  }
}
const monitor = new AvailabilityMonitor({
  probe: signal => api('/api/k3/probe', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(monitorSettings), signal }),
  onChange: result => {
    $('#k3-status').textContent = result.checking ? '正在探测 k3.1-pro…' : `${result.message} 最近检查：${new Date().toLocaleTimeString()}${result.nextAt ? `；下次约 ${new Date(result.nextAt).toLocaleTimeString()}` : ''}`;
    $('#k3-check').disabled = Boolean(result.checking);
    if (result.available) { monitorSettings = null; setMonitorBusy(false); }
  },
  onAvailable: () => {
    document.title = 'K3.1 Pro 已可用 · AGIbar';
    if (notificationSession) { notificationSession.available = true; updateNotification(notificationSession); }
  },
});
function setMonitorBusy(busy) {
  $('#k3-start').disabled = busy; $('#k3-check').disabled = busy && Boolean(monitor.checking); $('#k3-stop').hidden = !busy; $('#k3-base').disabled = busy;
}
function stopMonitor(message = '监测已停止。') {
  monitor.stop(); monitorSettings = null; notificationSession = null; setMonitorBusy(false); $('#k3-status').textContent = message;
  $('#k3-notification').textContent = '监测已停止；待处理的通知权限结果不会重新启动监测或发送通知。';
}
function startMonitor() {
  const apiKey = form.elements.apiKey.value.trim();
  if (!apiKey) { $('#k3-status').textContent = '请先在左侧输入 API key。'; return; }
  let base;
  try {
    base = new URL($('#k3-base').value.trim());
    if (!['http:', 'https:'].includes(base.protocol) || base.username || base.password || base.search || base.hash || (base.protocol !== 'https:' && !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname))) throw new Error();
  } catch { $('#k3-status').textContent = '请填写可信 HTTPS Base URL，本机模拟接口可用 HTTP。'; return; }
  setMonitorBusy(true);
  monitorSettings = { base: base.href, apiKey };
  const session = notificationSession = { available: false, notified: false };
  updateNotification(session);
  if ('Notification' in window && Notification.permission === 'default') {
    try {
      // Permission prompts can remain pending indefinitely. Never await them before probing.
      Promise.resolve(Notification.requestPermission()).then(() => updateNotification(session), () => {
        if (notificationSession === session) $('#k3-notification').textContent = '通知权限请求未完成；监测继续，可用时会在此页面提示。';
      });
    } catch { $('#k3-notification').textContent = '浏览器无法请求通知权限；监测继续，可用时会在此页面提示。'; }
  }
  document.title = 'H3 Studio · AGIbar';
  monitor.start();
}
$('#k3-start').addEventListener('click', startMonitor);
$('#k3-stop').addEventListener('click', () => stopMonitor());
$('#k3-check').addEventListener('click', () => {
  if (!monitor.running) { startMonitor(); return; }
  if (monitor.checkNow()) $('#k3-status').textContent = '正在立即探测 k3.1-pro…';
});
form.elements.apiKey.addEventListener('input', () => { if (notificationSession) stopMonitor('API key 已改变，监测已停止；请重新开始。'); });
$('#forget-key').addEventListener('click', () => stopMonitor('API key 已清除，监测已停止。'));
$('#reset').addEventListener('click', () => { if (notificationSession) stopMonitor('配置已重置，监测已停止；请重新开始。'); });
window.addEventListener('pagehide', () => stopMonitor());

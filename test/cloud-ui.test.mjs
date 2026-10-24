import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import * as protocol from '../cloud/public/protocol.js';
const settle=()=>new Promise(resolve=>setImmediate(resolve));
async function page(initial={},fetcher) {
  const elements=new Map(),callbacks=[],storage=new Map(Object.entries(initial)),requests=[],clipboard=[];
  function element(key){if(!elements.has(key))elements.set(key,{value:'',type:'password',textContent:'',handlers:{},children:[],classList:{toggle(){}},setAttribute(){},addEventListener(type,fn){(this.handlers[type]??=[]).push(fn);},click(){for(const fn of this.handlers.click||[])fn({});},submit(){for(const fn of this.handlers.submit||[])fn({preventDefault(){}});},replaceChildren(){this.children=[];},append(child){this.children.push(child);},showModal(){this.open=true;},close(){this.open=false;}});return elements.get(key);}
  const form=element('#h3-form');form.elements=[];
  for(const name of ['prompt','width','height','aspect_ratio','fps','seed','num_inference_steps','flow_shift','extra_params','duration']){const input=element(`field-${name}`);input.name=name;form.elements.push(input);form.elements[name]=input;}
  element('#kimi-tokens').value='256';
  class FormData{constructor(form){this.data=form?form.elements.map(e=>[e.name,e.value]):[];}[Symbol.iterator](){return this.data[Symbol.iterator]();}}
  const timers=new Map();let timerId=0;
  const ctx=vm.createContext({...protocol,document:{querySelector:element,createElement:()=>element(Symbol())},window:{addEventListener(type,callback){callbacks.push([type,callback]);}},localStorage:{getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)},FormData,AbortController,Blob,TextDecoder,Date,URL,crypto:{randomUUID:()=> 'test-job'},navigator:{clipboard:{writeText:async text=>clipboard.push(text)}},setTimeout:(fn,ms)=>{timers.set(++timerId,{fn,ms});return timerId;},clearTimeout:id=>timers.delete(id),setInterval:()=>++timerId,clearInterval(){},fetch:async(url,options)=>{requests.push({url,options});return fetcher?fetcher(url,options):new Response(JSON.stringify({choices:[{message:{content:'你好'}}]}));}});
  const source=(await readFile(new URL('../cloud/public/app.js',import.meta.url),'utf8')).replace(/^import .*\n/,'');vm.runInContext(source,ctx);
  return {element,storage,timers,callbacks,requests,clipboard};
}
test('reload keeps visitor state, discards old monitoring, and never sends automatic requests',async()=>{
  const ui=await page({'agibar.public.v1.history':JSON.stringify([{id:'old',created:Date.now(),status:'running'}]),'agibar.public.v1.monitor':JSON.stringify({enabled:true,nextAt:0}),'agibar.public.v1.settings':JSON.stringify({interval:5,apiKey:'sk-agi_bar-static'})});
  assert.equal(ui.element('#api-key').value,'sk-agi_bar-static');assert.equal(ui.requests.length,0);assert.equal(ui.timers.size,0);
  assert.equal(ui.storage.has('agibar.public.v1.monitor'),false);assert.equal(JSON.parse(ui.storage.get('agibar.public.v1.settings')).interval,undefined);
  assert.equal(JSON.parse(ui.storage.get('agibar.public.v1.history'))[0].status,'interrupted');
  ui.element('#tab-kimi').click();assert.equal(ui.element('#minimax').hidden,true);assert.equal(ui.element('#kimi').hidden,false);
  ui.element('#open-config').click();assert.equal(ui.element('#config').open,true);
});
test('model health checks are single requests and H3 status never claims generation success',async()=>{
  const ui=await page({},async url=>url===protocol.H3_ENDPOINT?new Response(null,{status:400}):new Response(JSON.stringify({choices:[{message:{content:''}}]})));
  ui.element('#check-minimax').click();ui.element('#check-minimax').click();await settle();
  assert.equal(ui.requests.length,1);assert.equal(ui.requests[0].options.method,'POST');assert.equal(ui.requests[0].options.body,'{}');
  assert.match(ui.element('#minimax-health-status').textContent,/400.*未创建视频任务/);
  ui.element('#check-kimi').click();await settle();assert.equal(ui.requests.length,2);
  assert.deepEqual(JSON.parse(ui.requests[1].options.body),{model:'k3.1-pro',messages:[{role:'user',content:'Hi'}],max_tokens:1,stream:false});
  assert.match(ui.element('#kimi-health-status').textContent,/已可用/);assert.equal(ui.timers.size,0);
});
test('each model copies its own accurate configuration using the current visitor key',async()=>{
  const ui=await page();ui.element('#api-key').value='visitor-key';ui.element('#save-config').click();
  ui.element('#copy-setup-minimax').click();ui.element('#copy-setup-kimi').click();await settle();
  assert.equal(ui.clipboard.length,2);assert.match(ui.clipboard[0],/visitor-key/);assert.match(ui.clipboard[0],/curl --http1.1 --fail-with-body/);assert.match(ui.clipboard[0],/不是 coding \/ chat 模型/);
  assert.match(ui.clipboard[1],/visitor-key/);assert.match(ui.clipboard[1],/k3.1-pro/);assert.match(ui.clipboard[1],/原生协议不一定兼容/);assert.equal(ui.requests.length,0);
});
test('Kimi playground uses typed prompt and token budget, restores last answer without replay',async()=>{
  const ui=await page();ui.element('#kimi-prompt').value='介绍广州';ui.element('#kimi-tokens').value='128';ui.element('#kimi-form').submit();ui.element('#kimi-form').submit();await settle();
  assert.equal(ui.requests.length,1);assert.equal(JSON.parse(ui.requests[0].options.body).messages[0].content,'介绍广州');assert.equal(JSON.parse(ui.requests[0].options.body).max_tokens,128);
  assert.equal(ui.element('#kimi-result').textContent,'你好');assert.match(ui.element('#kimi-status').textContent,/回复完成/);
  const restored=await page(Object.fromEntries(ui.storage));assert.equal(restored.element('#kimi-prompt').value,'介绍广州');assert.equal(restored.element('#kimi-result').textContent,'你好');assert.equal(restored.requests.length,0);
});
test('Kimi playground does not persist echoed credentials, allows retry and cancels on pagehide',async()=>{
  const ui=await page({},async()=>new Response(JSON.stringify({choices:[{message:{content:'sk-agi_bar-static'}}]})));
  ui.element('#kimi-form').submit();await settle();assert.match(ui.element('#kimi-status').textContent,/包含密钥/);assert.equal(ui.storage.has('agibar.public.v1.kimi-chat'),false);
  ui.element('#kimi-tokens').value='0';ui.element('#kimi-form').submit();assert.equal(ui.requests.length,1);
  const pending=await page({},async()=>new Promise(()=>{}));pending.element('#kimi-form').submit();pending.callbacks.find(([type])=>type==='pagehide')[1]();assert.equal(pending.requests[0].options.signal.aborted,true);
});
test('markup places three equivalent feature sections within each model tab and removes monitoring',async()=>{
  const html=await readFile(new URL('../cloud/public/index.html',import.meta.url),'utf8');
  for(const model of ['minimax','kimi']){
    const panel=html.split(`<section id="${model}"`)[1].split(model==='minimax'?'<section id="kimi"':'<dialog')[0];
    for(const id of [`check-${model}`,`copy-setup-${model}`,model==='kimi'?'kimi-form':'h3-form'])assert.ok(panel.includes(`id="${id}"`));
  }
  assert.doesNotMatch(html,/start-monitor|stop-monitor|setup-model|id="interval"|无限 Tokens|再通知你/);
  const app=await readFile(new URL('../cloud/public/app.js',import.meta.url),'utf8');assert.doesNotMatch(app,/Notification|scheduleMonitor|startMonitor/);
});

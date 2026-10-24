import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { H3_ENDPOINT, KIMI_ENDPOINT, h3Request, h3HealthRequest, kimiRequest, isAvailable, readLimited, isMp4, containsSecret } from '../cloud/public/protocol.js';
const value = { prompt:'@literal; $(echo no)',width:1024,height:576,aspect_ratio:'16:9',fps:24,seed:1101,num_inference_steps:50,flow_shift:12,extra_params:{task:'t2va',duration:5,audio_flow_shift:3} };
test('public browser uses exact fixed endpoints and ordinary multipart text fields', () => {
  assert.equal(H3_ENDPOINT,'https://token.agi.bar/minimax-h3/head/v1/videos/sync');
  assert.equal(KIMI_ENDPOINT,'https://token.agi.bar/v1/chat/completions');
  const request=h3Request(value,'test-key',new AbortController().signal);
  assert.equal(request.redirect,'error');assert.equal(request.headers.Authorization,'Bearer test-key');
  assert.equal(request.headers['Content-Type'],undefined);
  assert.equal(request.body.get('prompt'),value.prompt);
  assert.deepEqual(JSON.parse(request.body.get('extra_params')),value.extra_params);
  assert.equal([...request.body].length,9);
  assert.throws(()=>h3Request({...value,width:0},'x'),/width/);
  assert.throws(()=>h3Request({...value,extra_params:{duration:0}},'x'),/duration/);
});
test('Kimi browser probe retains minimum chat contract and availability semantics', () => {
  const request=kimiRequest('test-key');
  assert.deepEqual(JSON.parse(request.body),{model:'k3.1-pro',messages:[{role:'user',content:'Hi'}],max_tokens:1,stream:false});
  assert.equal(request.redirect,'error');
  assert.equal(isAvailable({ok:true},{choices:[{message:{content:''}}]}),true);
  assert.equal(isAvailable({ok:false},{choices:[{message:{}}]}),false);
  assert.equal(isAvailable({ok:true},{error:'error',choices:[{message:{}}]}),false);
});
test('response caps, MP4 detection and credential reflection guard', async () => {
  const bytes=await readLimited(new Response('0000ftyp0000'),12);
  assert.equal(isMp4(bytes),true);assert.equal(isMp4(new TextEncoder().encode('{"error":1}')),false);
  await assert.rejects(readLimited(new Response('12345'),4),/响应超过/);
  const reflected=await readLimited(new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode('test-'));c.enqueue(new TextEncoder().encode('key'));c.close();}})));
  assert.equal(containsSecret(reflected,'test-key'),true);
  assert.equal(containsSecret(bytes,'test-key'),false);
});
test('deploy artifact contains only static browser path with constrained connect CSP', async () => {
  const config=JSON.parse(await readFile(new URL('../wrangler.jsonc',import.meta.url),'utf8'));
  assert.equal(config.main,undefined);assert.deepEqual(config.assets,{directory:'./cloud/public'});
  const app=await readFile(new URL('../cloud/public/app.js',import.meta.url),'utf8');
  assert.doesNotMatch(app,/fetch\('\/api\//);
  assert.match(app,/fetch\(H3_ENDPOINT/);assert.match(app,/fetch\(KIMI_ENDPOINT/);
  const headers=await readFile(new URL('../cloud/public/_headers',import.meta.url),'utf8');
  assert.match(headers,/connect-src 'self' https:\/\/token\.agi\.bar;/);
});

test('H3 health is a deliberately invalid POST and Kimi chat validates caller input and budget', () => {
  const health = h3HealthRequest('test-key');
  assert.equal(health.method,'POST');assert.equal(health.body,'{}');assert.equal(health.redirect,'error');assert.equal(health.headers.Authorization,'Bearer test-key');
  const chat = JSON.parse(kimiRequest('test-key',undefined,'Hello',128).body);
  assert.equal(chat.messages[0].content,'Hello');assert.equal(chat.max_tokens,128);
  assert.throws(()=>kimiRequest('x',undefined,'',128),/提示词/);
  assert.throws(()=>kimiRequest('x',undefined,'Hi',0),/Tokens/);
  assert.throws(()=>kimiRequest('x',undefined,'Hi',4097),/Tokens/);
});

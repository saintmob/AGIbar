import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { AvailabilityMonitor } from '../public/monitor.js';

// Run the actual page event handlers with an inert DOM and fetch. No real network.
async function page({ permission = 'default', probePending = false } = {}) {
  const elements = new Map();
  const element = name => {
    if (!elements.has(name)) elements.set(name, { value: '', textContent: '', hidden: false, disabled: false, handlers: {}, addEventListener(event, callback) { (this.handlers[event] ||= []).push(callback); }, click() { for (const fn of this.handlers.click || []) fn({}); }, classList: { toggle() {} }, setAttribute() {}, focus() {} });
    return elements.get(name);
  };
  const form = element('#form');
  form.elements = { apiKey: element('key'), duration: element('duration'), extra_params: element('extra_params') };
  form.elements.apiKey.value = 'mock-ui-key';
  element('#k3-base').value = 'https://mock.invalid/v1';
  let resolvePermission, resolveProbe, signal;
  const permissionResult = new Promise(resolve => { resolvePermission = resolve; });
  let notifications = 0, probes = 0;
  class Notification {
    static permission = permission;
    static requestPermission() { return permissionResult; }
    constructor() { notifications++; }
  }
  const document = { querySelector: element, querySelectorAll: () => [], title: '' };
  const context = vm.createContext({ document, window: { Notification, addEventListener() {} }, Notification, AvailabilityMonitor, URL, Date, Promise, AbortController, setTimeout, clearTimeout,
    fetch: (path, options) => {
      if (path === '/api/defaults') return new Promise(() => {});
      assert.equal(path, '/api/k3/probe'); probes++; signal = options.signal;
      const response = { ok: true, json: async () => ({ available: true, message: 'K3 已可用' }) };
      return probePending ? new Promise(resolve => { resolveProbe = () => resolve(response); }) : Promise.resolve(response);
    },
  });
  const source = (await readFile(new URL('../public/app.js', import.meta.url), 'utf8')).replace(/^import .*\n/, '');
  vm.runInContext(source, context);
  return { element, form, get probes() { return probes; }, get notifications() { return notifications; }, get signal() { return signal; }, grant() { Notification.permission = 'granted'; resolvePermission('granted'); }, resolveProbe: () => resolveProbe?.() };
}
const settle = () => new Promise(resolve => setImmediate(resolve));

test('actual UI starts probing immediately while notification permission stays pending', async () => {
  const ui = await page(); ui.element('#k3-start').click();
  assert.equal(ui.probes, 1); assert.match(ui.element('#k3-status').textContent, /正在探测/);
  assert.match(ui.element('#k3-notification').textContent, /等待浏览器通知权限/);
  await settle();
  assert.match(ui.element('#k3-status').textContent, /K3 已可用/); assert.equal(ui.notifications, 0);
  assert.equal(ui.element('#k3-start').disabled, false); assert.equal(ui.element('#k3-stop').hidden, true);
  ui.grant(); await settle(); assert.equal(ui.notifications, 1); assert.match(ui.element('#k3-notification').textContent, /权限已允许/);
  await settle(); assert.equal(ui.notifications, 1); assert.equal(ui.probes, 1);
});

test('immediate check starts monitoring when it is idle', async () => {
  const ui = await page(); ui.element('#k3-check').click();
  assert.equal(ui.probes, 1); assert.match(ui.element('#k3-status').textContent, /正在探测/);
  assert.equal(ui.element('#k3-start').disabled, true); assert.equal(ui.element('#k3-stop').hidden, false);
});

test('actual UI stop cancels probe and suppresses late permission/result notification', async () => {
  const ui = await page({ probePending: true }); ui.element('#k3-start').click();
  ui.element('#k3-stop').click(); assert.equal(ui.signal.aborted, true);
  ui.grant(); ui.resolveProbe(); await settle();
  assert.equal(ui.notifications, 0); assert.equal(ui.probes, 1);
  assert.equal(ui.element('#k3-status').textContent, '监测已停止。');
  assert.match(ui.element('#k3-notification').textContent, /不会重新启动/);
});

test('actual UI with previously granted notification permission notifies exactly once', async () => {
  const ui = await page({ permission: 'granted' }); ui.element('#k3-start').click(); await settle();
  assert.equal(ui.notifications, 1); assert.equal(ui.probes, 1); assert.equal(ui.element('#k3-start').disabled, false);
});

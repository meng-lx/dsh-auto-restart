#!/usr/bin/env node
// 通过 Chrome DevTools Protocol 往 DSH 页面里注入一句话并发送。
// 与"模拟点击/按键"的区别：CDP 的 Input 事件直接投递给页面，
// 不动系统鼠标、不抢窗口焦点、不需要窗口在前台。
//
// 用法：node say.js "<文本>" [调试端口]
// 退出码：0 成功；1 输入了但没发出去；2 参数错误；3 连不上 / 找不到输入框
'use strict';

const text = process.argv[2];
const port = process.argv[3] || process.env.DSH_CDP_PORT || '9222';

if (!text) {
  console.error('用法: node say.js "<文本>" [端口]');
  process.exit(2);
}

const BASE = `http://127.0.0.1:${port}`;

async function listTargets() {
  const r = await fetch(`${BASE}/json/list`, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) throw new Error(`/json/list 返回 ${r.status}`);
  return r.json();
}

function makeSender(ws) {
  let seq = 0;
  const pending = new Map();
  ws.addEventListener('message', (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch { return; }
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    }
  });
  return (method, params) => new Promise((resolve, reject) => {
    const id = ++seq;
    pending.set(id, { resolve, reject });
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}

const INPUT_SELECTOR = 'textarea, [contenteditable="true"], [contenteditable=""]';

const READ_INPUT = `(() => {
  const el = document.querySelector('${INPUT_SELECTOR}');
  if (!el) return { found: false };
  const v = el.value !== undefined ? el.value : el.innerText;
  return { found: true, tag: el.tagName, value: v || '' };
})()`;

async function main() {
  const targets = await listTargets();
  const page = targets.find(t => t.type === 'page' && !String(t.url).startsWith('devtools://'));
  if (!page || !page.webSocketDebuggerUrl) throw new Error('没有找到页面 target');

  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', () => resolve(), { once: true });
    ws.addEventListener('error', (e) => reject(new Error('WebSocket 连接失败')), { once: true });
    setTimeout(() => reject(new Error('WebSocket 连接超时')), 6000);
  });
  const send = makeSender(ws);

  // 1) 找到输入框并聚焦（页面内聚焦，不需要窗口在前台）
  const focused = await send('Runtime.evaluate', {
    expression: `(() => {
      const el = document.querySelector('${INPUT_SELECTOR}');
      if (!el) return null;
      el.focus();
      return el.tagName;
    })()`,
    returnByValue: true,
  });
  if (!focused.result || !focused.result.value) throw new Error('页面里找不到输入框');

  // 2) 走真实输入管线写入文本
  await send('Input.insertText', { text });
  await new Promise(r => setTimeout(r, 400));

  const afterType = await send('Runtime.evaluate', { expression: READ_INPUT, returnByValue: true });
  const typed = afterType.result && afterType.result.value;
  if (!typed || !typed.value || typed.value.indexOf(text) < 0) {
    throw new Error('文本没有进入输入框');
  }

  // 3) 回车发送
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r',
  });
  await send('Input.dispatchKeyEvent', {
    type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13,
  });

  // 4) 看输入框是否被清空（清空 = 已发出）
  let left = typed.value;
  for (let i = 0; i < 10; i++) {
    await new Promise(r => setTimeout(r, 400));
    const now = await send('Runtime.evaluate', { expression: READ_INPUT, returnByValue: true });
    const cur = now.result && now.result.value;
    left = cur && cur.found ? (cur.value || '') : '';
    if (!left.trim()) break;
  }

  const ok = !left.trim();
  console.log(JSON.stringify({ ok, port, target: page.url, left }));
  ws.close();
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error('CDP 注入失败: ' + e.message);
  process.exit(3);
});

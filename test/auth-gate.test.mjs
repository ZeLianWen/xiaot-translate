/**
 * 强制登录门禁静态守护 (V1.7.81)
 * 运行: node --test test/
 * 业务约束: 所有功能必须邮箱注册后可用——划词(background)、文档翻译页、统一设置页、弹窗入口都要拦。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { LOGIN_REQUIRED_MSG, hasSession, mountAuthGate } from '../lib/auth-gate.js';

const read = rel => fs.readFileSync(new URL('../' + rel, import.meta.url), 'utf8');

test('auth-gate: 统一提示文案 + 未登录判定不抛错', async () => {
  assert.ok(LOGIN_REQUIRED_MSG.includes('注册'), '提示需引导用户注册/登录');
  assert.equal(typeof mountAuthGate, 'function', '必须提供注册/登录浮层');
  // Node 测试环境没有 chrome.storage, 必须按未登录处理而不是抛异常
  assert.equal(await hasSession(), false);
});

test('background: 划词翻译消息通道未登录直接拒绝 (V1.7.81)', () => {
  const bg = read('background.js');
  assert.ok(bg.includes("from './lib/auth-gate.js'"), 'background 需引入门禁模块');
  const m = bg.match(/if \(msg\.type !== 'vtTranslate'\) return;[\s\S]*?const config = await loadConfig\(\);/);
  assert.ok(m, '未找到 vtTranslate 处理段');
  assert.ok(m[0].includes('await hasSession()'), '翻译前必须校验会话');
  assert.ok(m[0].includes('LOGIN_REQUIRED_MSG'), '未登录需返回统一提示');
});

test('文档翻译页: 未登录只显示注册/登录浮层, 成功后重载继续 (V1.7.81)', () => {
  const js = read('doc-translate.js');
  assert.ok(js.includes("from './lib/auth-gate.js'"), '需引入门禁模块');
  const m = js.match(/\(async function\(\) \{[\s\S]{0,400}?mountAuthGate/);
  assert.ok(m, 'IIFE 需在入口处拦截');
  assert.ok(m && m[0].includes('await hasSession()'), '必须先校验会话');
  assert.ok(js.includes("mountAuthGate({ onSuccess: () => location.reload() })"), '登录成功后需重载页面继续原流程');
});

test('统一设置页: 未登录同样只显示注册/登录浮层 (V1.7.81)', () => {
  const js = read('options.js');
  assert.ok(js.includes("from './lib/auth-gate.js'"), '需引入门禁模块');
  const m = js.match(/async function init\(\) \{[\s\S]{0,400}?mountAuthGate/);
  assert.ok(m, 'init 入口需拦截');
  assert.ok(m[0].includes('await hasSession()'), '必须先校验会话');
});

test('插件弹窗: 未登录隐藏全部功能入口, 只保留账户区 (V1.7.81)', () => {
  const html = read('popup.html');
  const js = read('popup.js');
  assert.ok(html.includes('id="loginNotice"'), '缺少未登录提示');
  assert.ok(/class="card feature-only"/.test(html), '引擎卡片需标记 feature-only');
  assert.ok(/class="doc-btn feature-only" id="translateCurrentBtn"/.test(html), '功能按钮需标记 feature-only');
  const m = js.match(/function showAuthState\(session\) \{[\s\S]*?\n  \}/);
  assert.ok(m, 'showAuthState 存在');
  assert.ok(m[0].includes("querySelectorAll('.feature-only')"), '需按登录态显隐功能入口');
  assert.ok(m[0].includes('loginNotice'), '需按登录态显隐提示');
});

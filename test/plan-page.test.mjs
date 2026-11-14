import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { PRO_UPSELL_TIP, PRO_PURCHASE_ENABLED, PRO_PURCHASE_COMING_SOON_TIP } from '../lib/translator.js';

const html = fs.readFileSync(new URL('../doc-translate.html', import.meta.url), 'utf8');
const js = fs.readFileSync(new URL('../doc-translate.js', import.meta.url), 'utf8');
const payJs = fs.readFileSync(new URL('../pay.js', import.meta.url), 'utf8');

test('权益对比页: 分组 + 额度当量 + 定价卡片 (V1.7.68)', () => {
  assert.ok(html.includes('以下功能免费永久可用'), '缺少免费分组标题');
  assert.ok(html.includes('Pro 专享（免配置，开箱即用）'), '缺少 Pro 分组标题');
  assert.ok(/class="plan-group"/.test(html), '分组行需要 plan-group 样式');
  // 额度配人话当量
  assert.ok(html.includes('5 万字/日（≈50 页论文）'), '官方引擎额度需配页数当量');
  assert.ok(html.includes('2 万字符/日（≈20 页深度问答）'), 'AI 额度需配当量');
  assert.ok(html.includes('2000 字符/日（≈7 分钟音频）'), 'TTS 额度需配时长当量');
  // 定价卡片
  assert.ok(html.includes('plan-price'), '缺少定价卡片');
  assert.ok(html.includes('¥19.9'), '缺少月付价格');
  assert.ok(html.includes('¥199'), '缺少年付价格');
  assert.ok(html.includes('¥10 / 100 万字符'), '缺少加量包说明');
  assert.ok(html.includes('首月 ¥9.9'), '缺少首月优惠');
  assert.ok(html.includes('7 天无理由退款'), '缺少退款承诺');
});

test('升级入口: 购买开放时进入支付页, 关闭时只提示 (V1.7.79)', () => {
  assert.ok(PRO_UPSELL_TIP.includes('50 页论文'), '升级引导文案需带当量');
  assert.equal(PRO_PURCHASE_ENABLED, false, '扫码支付暂未开放, 开关应为 false');
  assert.ok(PRO_PURCHASE_COMING_SOON_TIP.includes('自带密钥'), '提示需说明可先用自带密钥的免费引擎');
  assert.ok(html.includes('id="planBuyBtn"'), '缺少升级按钮');
  assert.ok(/planBuyBtn[\s\S]{0,500}addEventListener/.test(js), '升级按钮必须绑定点击事件');
  assert.ok(/!PRO_PURCHASE_ENABLED[\s\S]{0,300}PRO_PURCHASE_COMING_SOON_TIP/.test(js), '开关关闭时按钮应提示即将开放');
  assert.ok(js.includes("chrome.runtime.getURL('pay.html')"), '开放后应打开扩展内支付页');
  assert.ok(payJs.includes('PRO_PURCHASE_ENABLED'), '支付页需受同一购买开关控制');
});

test('支付页: 未开放时禁用下单按钮 (V1.7.79)', () => {
  assert.ok(/!PRO_PURCHASE_ENABLED[\s\S]{0,600}btn\.disabled = true/.test(payJs), '关闭时支付按钮应禁用');
  assert.ok(payJs.includes("btn.textContent = '购买入口即将开放'"), '关闭时按钮文案应显示即将开放');
});

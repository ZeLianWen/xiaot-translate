/**
 * 支付页 (V1.7.79): 选择套餐 → create-order 拿二维码 → 轮询 order-status → 支付成功刷新权益。
 * 依赖 Supabase 会话 (与扩展内其他页面一致), 未登录时引导先登录。
 */
import { getValidSession, SUPABASE_URL, SUPABASE_ANON_KEY } from './lib/supabase-auth.js';
import { PRO_PURCHASE_ENABLED, PRO_PURCHASE_COMING_SOON_TIP } from './lib/translator.js';

const $ = (id) => document.getElementById(id);
const btn = $('payBtn');
const qrBox = $('qrBox');
const qrImg = $('qrImg');
const statusEl = $('status');

let selectedPlan = 'pro_month';
let pollTimer = null;
let currentOutTradeNo = '';

function setStatus(msg, kind) {
  statusEl.textContent = msg || '';
  statusEl.className = 'status' + (kind ? ' ' + kind : '');
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

async function callFn(name, body, token) {
  const resp = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/' + name, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'apikey': SUPABASE_ANON_KEY,
      'Authorization': 'Bearer ' + token
    },
    body: JSON.stringify(body)
  });
  let data = {};
  try { data = await resp.json(); } catch (e) { /* 非 JSON */ }
  return { ok: resp.ok, status: resp.status, data: data };
}

async function pollOnce(token) {
  const r = await callFn('order-status', { outTradeNo: currentOutTradeNo }, token).catch(() => null);
  if (!r || !r.ok) return;
  if (r.data.status === 'paid') {
    stopPolling();
    setStatus('支付成功，Pro 已开通；关闭本页即可使用', 'ok');
    qrBox.style.display = 'none';
    btn.disabled = true;
    btn.textContent = '已完成支付';
  }
}

async function startPay() {
  if (!PRO_PURCHASE_ENABLED) {
    setStatus(PRO_PURCHASE_COMING_SOON_TIP, 'err');
    return;
  }
  stopPolling();
  setStatus('正在创建订单...');
  btn.disabled = true;
  const s = await getValidSession().catch(() => null);
  if (!s) {
    setStatus('请先登录：打开插件弹窗 → 底部「账户」登录后再来支付', 'err');
    btn.disabled = false;
    return;
  }
  const r = await callFn('create-order', { plan: selectedPlan }, s.accessToken).catch(() => null);
  if (!r) {
    setStatus('网络异常，请稍后重试', 'err');
    btn.disabled = false;
    return;
  }
  if (r.status === 503) {
    setStatus('购买入口即将开放，当前可先用自带密钥的免费引擎', 'err');
    btn.disabled = false;
    return;
  }
  if (!r.ok || !r.data || !r.data.payUrl) {
    setStatus('下单失败：' + ((r.data && r.data.error) || ('HTTP ' + r.status)), 'err');
    btn.disabled = false;
    return;
  }

  currentOutTradeNo = r.data.outTradeNo || '';
  if (r.data.qrcode) {
    qrImg.src = r.data.qrcode;
    qrBox.style.display = 'block';
    setStatus('请使用微信 / 支付宝扫码支付');
  } else {
    // 渠道未返回二维码图片时, 退化为打开支付链接
    qrBox.style.display = 'block';
    qrImg.style.display = 'none';
    qrBox.querySelector('.tip').innerHTML =
      '支付链接已生成：<a href="' + r.data.payUrl + '" target="_blank" rel="noopener">点击打开支付页</a>';
    setStatus('请在打开的页面完成支付');
  }
  btn.disabled = false;
  btn.textContent = '重新生成二维码';

  pollTimer = setInterval(() => { pollOnce(s.accessToken); }, 3000);
}

document.querySelectorAll('.plan').forEach(el => {
  el.addEventListener('click', () => {
    if (!PRO_PURCHASE_ENABLED) return;
    document.querySelectorAll('.plan').forEach(x => x.classList.remove('active'));
    el.classList.add('active');
    selectedPlan = el.dataset.plan;
    qrBox.style.display = 'none';
    btn.textContent = '扫码支付';
    setStatus('');
    stopPolling();
  });
});

btn.addEventListener('click', startPay);

// 购买入口未开放: 支付页直接打开时也明确提示, 并禁用下单
if (!PRO_PURCHASE_ENABLED) {
  const sub = $('paySub');
  if (sub) sub.textContent = '购买入口即将开放，当前可先用自带密钥的免费引擎';
  btn.disabled = true;
  btn.textContent = '购买入口即将开放';
  setStatus(PRO_PURCHASE_COMING_SOON_TIP, 'err');
}

window.addEventListener('beforeunload', stopPolling);

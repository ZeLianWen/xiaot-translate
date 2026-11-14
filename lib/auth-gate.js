/**
 * 强制登录门禁 (V1.7.81)
 *
 * 业务要求: 所有功能必须邮箱注册后才能使用。本地页面 (文档翻译页 / 统一设置页) 在入口处
 * 先查会话, 未登录时只显示注册/登录浮层; 登录成功回调里重载页面, 让原有初始化流程继续。
 * 划词翻译走 background 消息通道, 由 background.js 统一拦截 (同一个提示文案)。
 *
 * 注意: 这是客户端 UX 门禁, 不作为安全边界——真正的权限仍由服务端 RLS/Functions 判定。
 */
import { getValidSession, signIn, signUp, validateCredentials } from './supabase-auth.js';

export const LOGIN_REQUIRED_MSG = '请先注册/登录后使用：邮箱注册即可，免费使用全部功能';

// 当前是否已登录 (过期会自动续期; 网络/存储异常一律视为未登录, 不抛错)
export async function hasSession() {
  try {
    return !!(await getValidSession());
  } catch (e) {
    return false;
  }
}

const GATE_STYLE_ID = 'vt-auth-gate-style';
const GATE_CSS = `
.vt-auth-gate{position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;padding:24px;background:rgba(247,249,248,.97);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif}
.vt-auth-card{width:100%;max-width:360px;background:#fff;border-radius:14px;padding:26px 24px 22px;box-shadow:0 10px 34px rgba(0,0,0,.12)}
.vt-auth-card h2{margin:0 0 6px;font-size:18px;color:#181818}
.vt-auth-card .vt-auth-desc{margin:0 0 18px;font-size:12px;color:#8c8c8c;line-height:1.7}
.vt-auth-card input{display:block;width:100%;box-sizing:border-box;margin-bottom:10px;padding:10px 12px;font-size:13px;font-family:inherit;border:1px solid #e5e5e5;border-radius:8px;outline:none}
.vt-auth-card input:focus{border-color:#07c160}
.vt-auth-actions{display:flex;gap:10px;margin-top:4px}
.vt-auth-actions button{flex:1;padding:10px 0;font-size:13px;font-family:inherit;border-radius:8px;border:1px solid #e5e5e5;background:#fff;color:#333;cursor:pointer}
.vt-auth-actions button.primary{background:#07c160;border-color:#07c160;color:#fff}
.vt-auth-actions button:disabled{opacity:.6;cursor:default}
.vt-auth-status{min-height:18px;margin-top:10px;font-size:12px;line-height:1.6;color:#8c8c8c}
.vt-auth-status.ok{color:#07a352}
.vt-auth-status.err{color:#d33}
.vt-auth-tip{margin:12px 0 0;font-size:11px;color:#b2b2b2;line-height:1.7}
`;

function injectGateStyle() {
  if (document.getElementById(GATE_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = GATE_STYLE_ID;
  style.textContent = GATE_CSS;
  (document.head || document.documentElement).appendChild(style);
}

/**
 * 显示注册/登录浮层 (全屏遮罩, 自带样式)
 * @param {{ title?: string, desc?: string, onSuccess?: (session: object) => void }} [options]
 * @returns {{ remove: () => void }}
 */
export function mountAuthGate(options) {
  const opts = options || {};
  injectGateStyle();

  const root = document.createElement('div');
  root.className = 'vt-auth-gate';
  root.innerHTML =
    '<div class="vt-auth-card">' +
      '<h2>' + String(opts.title || '注册 / 登录后使用') + '</h2>' +
      '<p class="vt-auth-desc">' + String(opts.desc || '小T翻译的全部功能需邮箱注册后使用（免费）。已有账号直接登录。') + '</p>' +
      '<input type="email" id="vtAuthEmail" placeholder="邮箱" spellcheck="false" autocomplete="username">' +
      '<input type="password" id="vtAuthPassword" placeholder="密码（至少 6 位）" autocomplete="current-password">' +
      '<div class="vt-auth-actions">' +
        '<button type="button" class="primary" data-act="signin">登录</button>' +
        '<button type="button" data-act="signup">注册</button>' +
      '</div>' +
      '<div class="vt-auth-status" data-status></div>' +
      '<p class="vt-auth-tip">忘记密码请在插件弹窗「账户」中重置；注册后需按邮件提示完成验证。</p>' +
    '</div>';
  document.body.appendChild(root);

  const emailEl = root.querySelector('#vtAuthEmail');
  const pwdEl = root.querySelector('#vtAuthPassword');
  const statusEl = root.querySelector('[data-status]');
  const signInBtn = root.querySelector('[data-act="signin"]');
  const signUpBtn = root.querySelector('[data-act="signup"]');

  function setStatus(text, kind) {
    statusEl.textContent = text || '';
    statusEl.className = 'vt-auth-status' + (kind ? ' ' + kind : '');
  }

  function setBusy(busy) {
    signInBtn.disabled = busy;
    signUpBtn.disabled = busy;
  }

  async function submit(kind) {
    const email = String(emailEl.value || '').trim();
    const password = String(pwdEl.value || '');
    const invalid = validateCredentials(email, password);
    if (invalid) {
      setStatus(invalid, 'err');
      return;
    }
    setBusy(true);
    setStatus(kind === 'signup' ? '正在注册…' : '正在登录…');
    try {
      if (kind === 'signup') {
        const res = await signUp(email, password);
        if (res && res.needsConfirm) {
          setStatus('注册成功：请到邮箱点击验证链接或填写验证码后再登录', 'ok');
          return;
        }
      } else {
        await signIn(email, password);
      }
      setStatus('成功，正在进入…', 'ok');
      root.remove();
      if (typeof opts.onSuccess === 'function') opts.onSuccess();
    } catch (e) {
      setStatus((e && e.message) ? e.message : String(e), 'err');
    } finally {
      setBusy(false);
    }
  }

  signInBtn.addEventListener('click', () => { submit('signin'); });
  signUpBtn.addEventListener('click', () => { submit('signup'); });
  [emailEl, pwdEl].forEach(el => {
    el.addEventListener('keydown', e => {
      if (e.key === 'Enter') submit('signin');
    });
  });
  setTimeout(() => emailEl.focus(), 0);

  return {
    remove: () => { if (root.parentNode) root.parentNode.removeChild(root); }
  };
}

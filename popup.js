import { signUp, signIn, signOut, getValidSession, validateCredentials, isSupabaseConfigured, updatePassword, requestPasswordReset, resetPasswordWithProof } from './lib/supabase-auth.js';
import { getEntitlement, clearEntitlementCache } from './lib/entitlement.js';
import { PRO_PURCHASE_COMING_SOON_TIP } from './lib/translator.js';

document.addEventListener('DOMContentLoaded', async () => {
  const backend = document.getElementById('backend');
  const proxyConfig = document.getElementById('proxyConfig');
  const configMovedHint = document.getElementById('configMovedHint');
  const customSlotRow = document.getElementById('customSlotRow');
  const customSlots = document.getElementById('customSlots');
  let vtCfg = null;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  // V1.7.42: 槽位选择留在使用处 (popup); 设置页只维护槽位配置。
  function configuredSlots() {
    const arr = vtCfg && Array.isArray(vtCfg.customModels) ? vtCfg.customModels : [];
    const out = [];
    for (let i = 0; i < arr.length && i < 3; i++) {      const m = arr[i] || {};
      const baseUrl = String(m.baseUrl || '').trim();
      const model = String(m.model || '').trim();
      if (baseUrl || model) out.push({ index: i, model: model });
    }
    return out;
  }

  function renderCustomSlots() {
    if (!customSlotRow || !customSlots) return;
    if (backend.value !== 'custom') {
      customSlotRow.style.display = 'none';
      return;
    }
    customSlotRow.style.display = 'block';
    const slots = configuredSlots();
    if (!slots.length) {
      customSlots.innerHTML = '<div class="help" style="font-size:10px;color:#b2b2b2">暂未配置自定义模型，请在「⚙️ 统一设置」中填写</div>';
      return;
    }
    const maxIdx = Math.max(0, ((vtCfg && Array.isArray(vtCfg.customModels)) ? vtCfg.customModels.length : 1) - 1);
    const active = Math.min(Math.max(Number(vtCfg && vtCfg.customActive) || 0, 0), maxIdx);
    customSlots.innerHTML = slots.map(s => {
      return '<button type="button" class="slot-btn' + (s.index === active ? ' active' : '') + '" data-slot="' + s.index + '">'
        + '槽位 ' + (s.index + 1) + (s.model ? ' · ' + esc(s.model) : '') + '</button>';
    }).join('');
    customSlots.querySelectorAll('[data-slot]').forEach(btn => {
      btn.addEventListener('click', async () => {
        const idx = Number(btn.dataset.slot);
        try {
          const r = await chrome.storage.local.get(['vtConfig']);
          const cfg = (r && r.vtConfig) || {};
          cfg.customActive = idx;
          await chrome.storage.local.set({ vtConfig: cfg });
          vtCfg = cfg;
        } catch (e) { /* 持久化失败仅影响下次打开 */ }
        renderCustomSlots();
      });
    });
  }

  // V1.7.41: 各引擎的密钥/接口表单已迁移到「⚙️ 统一设置」页, popup 只负责切换当前引擎。
  // 旧配置字段保持原样, 不在这里清理; 统一设置页保存时会同步写回旧字段。
  try {
    const r = await chrome.storage.local.get(['vtConfig']);
    if (r.vtConfig) {
      const cfg = r.vtConfig;
      // 旧「本地翻译(v2)」引擎并入自定义模型 (纯数据迁移, 与表单无关)
      let migrated = false;
      if (cfg.backend === 'local') {
        cfg.backend = 'custom';
        if (!cfg.customBaseUrl || !cfg.customBaseUrl.trim()) {
          cfg.customBaseUrl = String(cfg.localBaseUrl || 'http://localhost:11434').trim().replace(/\/+$/, '') + '/v1';
        }
        if (!cfg.customModel || !cfg.customModel.trim()) {
          const m = String(cfg.localModel || 'v2').trim();
          cfg.customModel = m === 'v2' ? 'zh-en-mt-v2' : m === 'v1' ? 'zh-en-mt' : m === 'hy-mt2' ? 'hy-mt2' : m;
        }
        delete cfg.localBaseUrl;
        delete cfg.localModel;
        migrated = true;
      }
      backend.value = cfg.backend || 'baidu';
      vtCfg = cfg;
      if (migrated) await chrome.storage.local.set({ vtConfig: cfg });
    }
  } catch (e) {}

  function updateConfigVisibility() {
    proxyConfig.style.display = backend.value === 'proxy' ? 'block' : 'none';
    configMovedHint.style.display = backend.value === 'proxy' ? 'none' : 'block';
    renderCustomSlots();
  }
  updateConfigVisibility();
  backend.addEventListener('change', updateConfigVisibility);

  async function save() {
    // 只更新 backend, 保留其它字段 (包括统一设置页写入的 settings 结构)
    const r = await chrome.storage.local.get(['vtConfig']);
    const cfg = r.vtConfig || {};
    cfg.backend = backend.value;
    await chrome.storage.local.set({ vtConfig: cfg });
  }

  backend.addEventListener('change', save);

  // V1.7.1: 非 Pro 选官方引擎 → 即时提示 (不阻止选择; 翻译路径仍有预检兜底拦截)
  backend.addEventListener('change', async () => {
    if (backend.value !== 'proxy') return;
    const ent = await getEntitlement();
    if (!ent || ent.plan !== 'pro') {
      alert('官方引擎为 Pro 专享功能：当前账户未登录或未开通 Pro。\n\n' + PRO_PURCHASE_COMING_SOON_TIP + '。\n\n开通 Pro 后选择该引擎即可免配置免密钥直接翻译。');
    }
  });

  // 翻译当前PDF: 检测当前标签页是否为 PDF, 是则传 URL 打开文档翻译页
  document.getElementById('translateCurrentBtn').addEventListener('click', async () => {
    let url = '';
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      url = tab && tab.url ? tab.url : '';
    } catch (e) {}
    const pdfUrl = extractPdfUrl(url);
    if (!pdfUrl) {
      alert('当前页面不是 PDF 文件。\n\n请先打开一个 PDF 网页（如 arxiv.org 论文页），或使用「文档翻译」上传本地文件。');
      return;
    }
    chrome.tabs.create({ url: chrome.runtime.getURL('doc-translate.html?url=' + encodeURIComponent(pdfUrl)) }).catch(() => {});
  });

  function extractPdfUrl(url) {
    if (!url) return '';
    // 本地直接打开的 PDF (file://.../*.pdf) 同样支持 (V1.5.36 起翻译页可加载;
    // 需在 chrome://extensions 开启"允许访问文件网址", 未开启时翻译页会给出指引)
    if (/\.pdf(\?|#|$)/i.test(url)) return url;
    // 常见在线 PDF 查看器的文件参数 (viewer.html?file=... / ?src=...)
    try {
      const u = new URL(url);
      const src = u.searchParams.get('file') || u.searchParams.get('src');
      if (src && /^https?:\/\//i.test(src) && /\.pdf(\?|#|$)/i.test(src)) return src;
    } catch (e) {}
    return '';
  }

  document.getElementById('docTranslateBtn').addEventListener('click', () => {
    chrome.tabs.create({ url: chrome.runtime.getURL('doc-translate.html') }).catch(() => {});
  });

  // ===== 账户 (Supabase 邮箱注册/登录, 为云端同步做准备) =====
  const authEmail = document.getElementById('authEmail');
  const authPassword = document.getElementById('authPassword');
  const authStatus = document.getElementById('authStatus');
  const authLoggedOut = document.getElementById('authLoggedOut');
  const authLoggedIn = document.getElementById('authLoggedIn');
  const authUserEmail = document.getElementById('authUserEmail');
  const authPlan = document.getElementById('authPlan');
  const authSignInBtn = document.getElementById('authSignInBtn');
  const authSignUpBtn = document.getElementById('authSignUpBtn');
  const authSignOutBtn = document.getElementById('authSignOutBtn');

  // 忘记密码 / 修改密码 (V1.7.5)
  const authLoginBox = document.getElementById('authLoginBox');
  const authResetBox = document.getElementById('authResetBox');
  const authForgotBtn = document.getElementById('authForgotBtn');
  const authResetEmail = document.getElementById('authResetEmail');
  const authResetSendBtn = document.getElementById('authResetSendBtn');
  const authResetCode = document.getElementById('authResetCode');
  const authResetPassword = document.getElementById('authResetPassword');
  const authResetConfirmBtn = document.getElementById('authResetConfirmBtn');
  const authResetBackBtn = document.getElementById('authResetBackBtn');
  const authChangePwdBtn = document.getElementById('authChangePwdBtn');
  const authChangePwdBox = document.getElementById('authChangePwdBox');
  const authNewPwd = document.getElementById('authNewPwd');
  const authNewPwd2 = document.getElementById('authNewPwd2');
  const authChangePwdConfirmBtn = document.getElementById('authChangePwdConfirmBtn');

  function setAuthStatus(msg, isErr) {
    authStatus.textContent = msg || '';
    authStatus.className = 'auth-status' + (msg ? (isErr ? ' err' : ' ok') : '');
  }

  // 套餐行 (V1.6.1 阶段1): 登录后展示套餐与云端配额 (免费 30 条/50MB, Pro 300 条/200MB)。
  // 查询失败静默留空 (getEntitlement 永不抛错, 但仍防御)
  // V1.7.0: Pro 追加官方引擎今日用量展示 (entitlement Function 读 translate_usage)
  // V1.7.8: 官方引擎用量优先用服务端在翻译响应里回传的实时值 (vtProxyUsage), 仅展示不判定
  const PROXY_USAGE_FRESH_MS = 10 * 60 * 1000;
  async function readProxyUsage() {
    try {
      const items = await chrome.storage.local.get('vtProxyUsage');
      const u = items && items.vtProxyUsage;
      return u && Date.now() - (Number(u.time) || 0) < PROXY_USAGE_FRESH_MS ? u : null;
    } catch (_e) { return null; }
  }

  // 云端 AI 分析今日用量 (V1.7.10): 优先用 ai-chat Function 回传的实时值 (vtAiUsage),
  // 回退 entitlement 查询值; 仅展示不判定 (真实强制在服务端 ai_charge RPC)
  async function readAiUsage() {
    try {
      const items = await chrome.storage.local.get('vtAiUsage');
      const u = items && items.vtAiUsage;
      return u && Date.now() - (Number(u.time) || 0) < PROXY_USAGE_FRESH_MS ? u : null;
    } catch (_e) { return null; }
  }

  function renderPlan() {
    Promise.all([getEntitlement(true), readProxyUsage(), readAiUsage()]).then(([e, u, a]) => {
      if (!e) return;
      const mb = Math.round(e.maxBytes / (1024 * 1024));
      if (e.plan === 'pro') {
        const exp = e.expiresAt ? ' · ' + new Date(e.expiresAt).toLocaleDateString() + ' 到期' : '';
        const used = Number(u ? u.usedChars : e.proxyUsedChars) || 0;
        const limitNum = Number(u ? u.dailyLimit : e.proxyDailyLimit) || 50000;
        const usedW = used >= 10000 ? (used / 10000).toFixed(1) + '万' : String(used);
        const limitW = (limitNum / 10000).toFixed(0);
        // AI 分析用量: 有实时值或查询值才展示 (免费档/未用不显示)
        const aiUsed = Number(a ? a.usedChars : e.aiUsedChars) || 0;
        const aiLimitNum = Number(a ? a.dailyLimit : e.aiDailyLimit) || 100000;
        const aiText = ' · AI 分析 ' + (aiUsed >= 10000 ? (aiUsed / 10000).toFixed(1) + '万' : String(aiUsed))
          + '/' + (aiLimitNum / 10000).toFixed(0) + '万字';
        authPlan.textContent = 'Pro 套餐 · 云端 ' + e.maxRecords + ' 条 / ' + mb + 'MB' +
          ' · 官方引擎今日 ' + usedW + '/' + limitW + '万字' + aiText + exp;
      } else {
        authPlan.textContent = '免费版 · 云端 ' + e.maxRecords + ' 条 / ' + mb + 'MB';
      }
    }).catch(() => { authPlan.textContent = ''; });
  }

  // 登录视图 ⇄ 重置密码视图切换 (忘记密码入口)
  function showResetBox(show) {
    if (show && authEmail.value.trim()) authResetEmail.value = authEmail.value.trim(); // 带入已输入的邮箱
    authLoginBox.style.display = show ? 'none' : 'block';
    authResetBox.style.display = show ? 'block' : 'none';
    setAuthStatus('');
  }

  function showAuthState(session) {
    authLoggedOut.style.display = session ? 'none' : 'block';
    authLoggedIn.style.display = session ? 'block' : 'none';
    // 强制登录门禁 (V1.7.81): 未登录隐藏全部功能入口, 只保留账户注册/登录
    document.querySelectorAll('.feature-only').forEach(el => {
      el.style.display = session ? '' : 'none';
    });
    const notice = document.getElementById('loginNotice');
    if (notice) notice.style.display = session ? 'none' : 'block';
    if (session) {
      authUserEmail.textContent = session.email || '已登录';
      authChangePwdBox.style.display = 'none';
      setAuthStatus('');
      renderPlan();
    } else {
      authPlan.textContent = '';
      showResetBox(false); // 登出/未登录回到登录视图
    }
  }

  // 按钮置灰防重复提交, 结束恢复
  function withAuthBusy(btn, fn) {
    return (async () => {
      const old = btn.textContent;
      btn.disabled = true;
      btn.textContent = '...';
      try {
        await fn();
      } finally {
        btn.disabled = false;
        btn.textContent = old;
      }
    })();
  }

  // 打开 popup 恢复登录态 (临近过期自动续期)
  if (!isSupabaseConfigured()) {
    setAuthStatus('Supabase 未配置：请在 lib/supabase-auth.js 顶部填入 Project URL 与 anon key', true);
  }
  try {
    const session = await getValidSession();
    showAuthState(session);
  } catch (e) {
    showAuthState(null);
    setAuthStatus(e.message, true);
  }

  authSignUpBtn.addEventListener('click', () => withAuthBusy(authSignUpBtn, async () => {
    const email = authEmail.value.trim();
    const invalid = validateCredentials(email, authPassword.value);
    if (invalid) return setAuthStatus(invalid, true);
    try {
      const res = await signUp(email, authPassword.value);
      if (res.needsConfirm) {
        // Supabase 后台开启了 "Confirm email": 需到邮箱点验证链接后才能登录
        authPassword.value = '';
        setAuthStatus('注册成功！请到邮箱点击验证链接后登录', false);
      } else {
        showAuthState(res.session);
        authPassword.value = '';
        setAuthStatus('注册成功，已自动登录', false);
      }
    } catch (e) {
      setAuthStatus(e.message, true);
    }
  }));

  authSignInBtn.addEventListener('click', () => withAuthBusy(authSignInBtn, async () => {
    const email = authEmail.value.trim();
    const invalid = validateCredentials(email, authPassword.value);
    if (invalid) return setAuthStatus(invalid, true);
    try {
      const session = await signIn(email, authPassword.value);
      showAuthState(session);
      authPassword.value = '';
      setAuthStatus('登录成功', false);
    } catch (e) {
      setAuthStatus(e.message, true);
    }
  }));

  authSignOutBtn.addEventListener('click', () => withAuthBusy(authSignOutBtn, async () => {
    try {
      await signOut();
    } catch (e) {
      console.warn('[AUTH] 登出异常:', e);
    }
    await clearEntitlementCache(); // 套餐缓存随会话清除, 防换账号读到上一账户套餐
    try { await chrome.storage.local.remove('vtProxyUsage'); } catch (_e) { /* 用量展示缓存, 清理失败无影响 */ }
    try { await chrome.storage.local.remove('vtAiUsage'); } catch (_e) { /* 用量展示缓存, 清理失败无影响 */ }
    showAuthState(null);
    setAuthStatus('已退出登录', false);
  }));

  // ===== 忘记密码 (验证码 / 重置链接, V1.7.5 / V1.7.7) =====

  authForgotBtn.addEventListener('click', () => showResetBox(true));
  authResetBackBtn.addEventListener('click', () => showResetBox(false));

  // 第一步: 发送重置邮件 (免费版默认只含链接, 配置 SMTP 后模板可含验证码)
  authResetSendBtn.addEventListener('click', () => withAuthBusy(authResetSendBtn, async () => {
    try {
      await requestPasswordReset(authResetEmail.value);
      setAuthStatus('重置邮件已发送：请打开邮件，右键「Reset password」复制链接，粘贴到下方输入框', false);
    } catch (e) {
      setAuthStatus(e.message, true);
    }
  }));

  // 第二步: 验证码 或 重置链接 + 新密码 → 重置并自动登录
  // 两者自动识别 (lib 的 resetPasswordWithProof): 数字走 verify(email+token), 链接提取 token_hash 走 verify(token_hash)
  authResetConfirmBtn.addEventListener('click', () => withAuthBusy(authResetConfirmBtn, async () => {
    try {
      const session = await resetPasswordWithProof(authResetCode.value, authResetEmail.value, authResetPassword.value);
      showAuthState(session);
      setAuthStatus('密码已重置，已自动登录', false);
    } catch (e) {
      setAuthStatus(e.message, true);
    }
  }));

  // ===== 修改密码 (已登录, V1.7.5) =====

  authChangePwdBtn.addEventListener('click', () => {
    const show = authChangePwdBox.style.display === 'none';
    authChangePwdBox.style.display = show ? 'block' : 'none';
    if (!show) { authNewPwd.value = ''; authNewPwd2.value = ''; }
    setAuthStatus('');
  });

  authChangePwdConfirmBtn.addEventListener('click', () => withAuthBusy(authChangePwdConfirmBtn, async () => {
    const p1 = authNewPwd.value;
    const p2 = authNewPwd2.value;
    if (p1.length < 6) return setAuthStatus('新密码至少 6 位', true);
    if (p1 !== p2) return setAuthStatus('两次输入的新密码不一致', true);
    try {
      await updatePassword(p1);
      authNewPwd.value = '';
      authNewPwd2.value = '';
      authChangePwdBox.style.display = 'none';
      setAuthStatus('密码修改成功', false);
    } catch (e) {
      setAuthStatus(e.message, true);
    }
  }));
});

// V1.7.39: 统一设置入口 (options.html 只读总览)
document.getElementById('openSettingsBtn').addEventListener('click', () => {
  try {
    chrome.runtime.openOptionsPage();
  } catch (e) {
    chrome.tabs.create({ url: chrome.runtime.getURL('options.html') });
  }
});
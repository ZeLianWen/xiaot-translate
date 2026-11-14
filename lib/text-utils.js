/**
 * 文本处理纯函数 (ES Module)
 * 从 background.js 抽出以便单元测试 (V1.5.47); 逻辑与抽出前完全一致
 */

// 合并 PDF 复制/TextLayer 选区带来的逐行硬换行:
// 中日韩字符邻接的换行直接拼接, 其余以空格拼接, 行尾连字符断词还原; 空行保留为段落分隔
export function mergeHardWraps(text) {
  // \uac00-\ud7a3: 韩文谚文音节 (V1.5.55 补——此前缺失, 韩文硬换行合并会在词中插空格)
  const cjk = /[\u2e80-\u9fff\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uffef\u3000-\u303f]/;
  const lines = String(text).replace(/\r\n?/g, '\n').split('\n');
  let out = '';
  for (const raw of lines) {
    const line = raw.trim();
    if (!line) {
      if (out) out += '\n';
      continue;
    }
    if (!out || out.endsWith('\n')) {
      out += line;
      continue;
    }
    const last = out.charAt(out.length - 1);
    if (last === '-') out = out.slice(0, -1) + line;
    else if (cjk.test(last) || cjk.test(line.charAt(0))) out += line;
    else out += ' ' + line;
  }
  return out.trim();
}

// ===== 行内公式占位符保护 (V1.7.65) =====
// 目的: 整段是正文但夹带公式时 (如「当 M ≥ 2 时收敛更快」), 送翻译引擎会把符号改写/下标丢失。
// 做法: 送译前把行内数学片段替换为 [[n]] 标记, 译文返回后原位还原; 引擎丢失标记则追加到句末, 不丢公式。
const MATH_FN_WORDS = new Set([
  'sin', 'cos', 'tan', 'cot', 'sec', 'csc', 'log', 'ln', 'lim', 'max', 'min', 'exp',
  'arg', 'det', 'dim', 'sup', 'inf', 'mod', 'gcd', 'sinh', 'cosh', 'tanh',
  'arcsin', 'arccos', 'arctan', 'sqrt', 'abs', 'var', 'cov'
]);
// 数学指示符: 关系/算符/希腊字母 (出现其一才可能是公式, 避免把普通词句当公式)
const MATH_HINT_RE = /[=≈≤≥≠∝→←↔<>±∓×÷·√∫∑∂∇^_+\-*\/−]/;
const GREEK_RE = /[α-ωΑ-Ω]/;
// 连续数学字符片段 (不含空格), 长度 2~60
const MATH_RUN_RE = /[A-Za-z0-9α-ωΑ-Ω_^{}()\[\]<>+\-*\/=≈≤≥≠∝→←↔±∓×÷·√∫∑∂∇.,;:%°']{2,60}/g;
// 带空格的短式: 操作数 (算式) 操作数..., 如 "M ≥ 2" / "x 2 = r 2"
const SPACED_MATH_RE = /(?<![A-Za-z\u4e00-\u9fff])[A-Za-zα-ωΑ-Ω0-9]{1,6}(?:[ \t]*[=≈≤≥≠∝→←↔<>±∓×÷·√][ \t]*[A-Za-zα-ωΑ-Ω0-9]{1,6})+(?![A-Za-z\u4e00-\u9fff])/g;
// 还原用占位符匹配 (容忍引擎改写的中英文括号/空格)
const PLACEHOLDER_RE = /[\[［【]\s*[\[［【]\s*(\d+)\s*[\]］】]\s*[\]］】]/g;

// 判断一个字符片段是否像行内公式 (保守: 只保护高置信度的数学式)
export function isInlineMathFragment(s) {
  const t = String(s).trim();
  if (t.length < 2 || t.length > 60) return false;
  if (/[\u4e00-\u9fff]/.test(t)) return false;                 // 含中文 → 正文
  if (!/[A-Za-z0-9α-ωΑ-Ω]/.test(t)) return false;             // 纯符号无法判断
  if (!MATH_HINT_RE.test(t) && !GREEK_RE.test(t)) return false; // 无数学指示符 → 普通文字/数字
  const words = t.match(/[A-Za-z]{4,}/g) || [];
  for (const w of words) {
    if (!MATH_FN_WORDS.has(w.toLowerCase())) return false;     // 含普通英文词 → 正文 (如 state-of-the-art)
  }
  // 纯连字符英文词 (co-op / up-to-date) 不是公式
  if (/^[A-Za-z]+(-[A-Za-z]+)+$/.test(t)) return false;
  return true;
}

// 把行内公式替换为 [[n]] 占位符; 返回 { masked, items }
export function maskInlineMath(text) {
  const items = [];
  const put = (m) => {
    items.push(m);
    return ' [[' + (items.length - 1) + ']] ';
  };
  let masked = String(text)
    .replace(/\$\$[\s\S]{1,240}?\$\$/g, put)   // $$...$$
    .replace(/\$[^$\n]{1,160}\$/g, put)        // $...$
    .replace(/\\\[[\s\S]{1,300}?\\\]/g, put)   // \[...\]
    .replace(/\\\([\s\S]{1,300}?\\\)/g, put);  // \(...\)
  masked = masked.replace(MATH_RUN_RE, m => (isInlineMathFragment(m) ? put(m) : m));
  masked = masked.replace(SPACED_MATH_RE, m => (isInlineMathFragment(m) ? put(m) : m));
  return { masked, items };
}

// 把译文中的占位符还原为原公式; 引擎丢失的标记追加到句末 (公式信息不丢)
export function restoreInlineMath(translated, items) {
  const list = Array.isArray(items) ? items : [];
  const out0 = String(translated);
  if (!list.length) return out0;
  const used = new Set();
  let out = out0.replace(PLACEHOLDER_RE, (m, d) => {
    const k = Number(d);
    if (!Number.isInteger(k) || k < 0 || k >= list.length || used.has(k)) return m;
    used.add(k);
    return list[k];
  });
  const missing = [];
  for (let i = 0; i < list.length; i++) if (!used.has(i)) missing.push(list[i]);
  if (missing.length) {
    out = out.replace(/\s+$/, '');
    out += (out ? ' ' : '') + missing.join(' ');
  }
  return out;
}

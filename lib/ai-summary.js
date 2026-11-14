/**
 * 大模型全文分析总结 (V1.7.9, Pro 专享)
 * 文档翻译页「🤖 AI 总结」核心: 调用自定义模型 (OpenAI 兼容, 含 Ollama 本地部署) 对整篇
 * 文档做结构化分析总结。短文单次直出; 长文 map-reduce——分块提炼要点 → 汇总整合为全文分析。
 * 上下文自适应 (实测修复): 模型上下文窗口放不下提示词 (Ollama 默认仅 2048 tokens) 时,
 * 识别服务端返回的上下文类错误并自动减半分块重试; 分块要点总大小超限时汇总阶段分批多轮合并。
 * 分块/提示词/编排均为纯逻辑 (node --test 可测), 网络调用经注入的 chat (默认 customChat)。
 */
import { customChat, utf8Len, maxRequestBytes } from './translator.js';

// 单次直出的全文字节上限: 约 3 万字节 (1 万汉字), 大上下文模型一次吃下免分块;
// 上下文不足时该上限逐次减半 (自适应重试), 小上下文模型自动退到分块路径
export const SINGLE_MAX_BYTES = 30000;
// map-reduce 分块字节上限: 每块 2.4 万字节, 为提示词与模型输出留余量
export const CHUNK_BYTES = 24000;
// 分块数量上限: 超长文档 (数百页) 拒绝分析而非做数十次串行请求
export const MAX_CHUNKS = 64;
// 上下文自适应重试次数上限 (30000 → 15000 → … → 937, 逐次减半)
const MAX_ADJUST_ATTEMPTS = 6;
// 减半重试的分块字节下限: 再小则放弃, 报错并附环境变量引导
const MIN_LIMIT_BYTES = 800;

// 分析总结的固定小节结构 (单次/最终汇总提示词共用), 保证两路径输出形态一致
const SECTION_LIST = '## 一句话总结\n## 核心观点（分条）\n## 章节脉络\n## 关键术语与概念\n## 结论与启示';

// ===== 微信式 AI 对话 (V1.7.12): 每轮请求消息组装 (纯逻辑可单测) =====
// HTTP 无状态、服务端无会话记忆 → 文档上下文每轮注入 system; 历史 + 上下文统一裁剪。
// 云端 ai-chat Function 约束 (V1.7.12 放宽后): 消息 ≤32 条、单次输入 ≤4 万码点 (计费口径)。
// 文档上下文每轮都计费 (仅输入字符), 上下文默认 1.6 万码点 + 历史余量, 深聊多轮会消耗当日配额。

export const CHAT_DOC_CHARS = 16000;   // 文档上下文码点上限 (云端默认; 自定义引擎按 maxBytes 放宽)
export const CHAT_TOTAL_CHARS = 38000; // 单轮总输入码点上限 (服务端 4 万, 留 2 千余量)
export const CHAT_MAX_MESSAGES = 30;   // 历史消息条数上限 (服务端 32 条, 留 system + 余量)

// 组装单轮请求消息: [system(文档上下文+行为约束), ...裁剪后历史, 当前消息]。
// history 为完整对话 (含最后一条新消息, 必发); 从最新往旧收录, 超总码点/条数的旧消息静默丢弃;
// docText 超长按 maxDocChars 截断并注明 (大文档对话为"感知部分原文"而非全文分析, 与旧版总结取舍不同)。
export function buildChatMessages(docText, history, opts) {
  const o = opts || {};
  const maxDoc = Math.floor(o.maxDocChars) || CHAT_DOC_CHARS;
  const maxTotal = Math.floor(o.maxTotalChars) || CHAT_TOTAL_CHARS;
  const maxMsgs = Math.floor(o.maxMessages) || CHAT_MAX_MESSAGES;
  const hist = (Array.isArray(history) ? history : []).filter(m =>
    m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim());
  const last = hist.length ? hist[hist.length - 1] : { role: 'user', content: '' };
  const rest = hist.slice(0, -1);
  const doc = String(docText || '').trim();
  let sys = '你是「小T翻译」扩展内置的 AI 文档分析助手。用户「小T」正在阅读一篇文档，'
    + '你的职责是基于文档内容回答小T的问题：忠实原文、不编造；文档未涉及的内容如实说明；'
    + '回答语言与小T的提问语言一致；直接回答，不要无关开场白；'
    + '如果小T询问你基于哪个大模型，请如实回答，不要否认。';
  if (doc) {
    sys += '\n\n<文档内容>\n' + (doc.length > maxDoc
      ? doc.slice(0, maxDoc) + '\n\n（文档过长，以上为前 ' + maxDoc + ' 字符，后续内容未提供）'
      : doc) + '\n</文档内容>';
  }
  // 历史裁剪 (码点计数与服务端计费口径一致): 当前消息必发, 旧消息按预算从新到旧收录
  const kept = [];
  let total = Array.from(sys).length + Array.from(last.content).length;
  for (let i = rest.length - 1; i >= 0; i--) {
    if (kept.length + 1 >= maxMsgs) break;
    const len = Array.from(rest[i].content).length;
    if (total + len > maxTotal) break;
    kept.unshift(rest[i]);
    total += len;
  }
  return [{ role: 'system', content: sys }, ...kept, last];
}

export function buildSummaryPrompt(text, outLang) {
  return '你是一名专业的文档分析助手。请基于以下文档全文，用' + outLang + '输出一份结构化的分析与总结，依次包含以下小节：\n'
    + SECTION_LIST + '\n'
    + '要求：忠实原文，不编造内容；引用关键数据时保持原样；直接输出分析内容，不要开场白。\n\n'
    + '<文档>\n' + text + '\n</文档>';
}

export function buildChunkPrompt(text, outLang, idx, total) {
  return '你是一名专业的文档分析助手。以下是一篇长文档的第 ' + idx + '/' + total + ' 部分原文。'
    + '请用' + outLang + '提炼该部分的要点：保留关键论据、方法、数据与结论，分条列出并合并同类内容；'
    + '不要开场白与总结语（后续会统一整合）。直接输出要点。\n\n'
    + '<文档第 ' + idx + ' 部分>\n' + text + '\n</文档第 ' + idx + ' 部分>';
}

export function buildReducePrompt(parts, outLang) {
  const body = parts.map((p, i) => '【第 ' + (i + 1) + ' 部分要点】\n' + p).join('\n\n');
  return '你是一名专业的文档分析助手。以下是一篇长文档按原文顺序各部分的要点摘录。'
    + '请用' + outLang + '把它们整合成一份完整的全文分析与总结，依次包含以下小节：\n'
    + SECTION_LIST + '\n'
    + '要求：覆盖所有部分的要点，合并重复内容，不编造；直接输出分析内容，不要开场白。\n\n'
    + '<各部分要点>\n' + body + '\n</各部分要点>';
}

// 中间合并轮 (分批汇总): 一批要点 → 更紧凑要点, 不输出固定小节结构 (末轮才输出)
export function buildMergePrompt(parts, outLang) {
  const body = parts.map((p, i) => '【第 ' + (i + 1) + ' 部分要点】\n' + p).join('\n\n');
  return '你是一名专业的文档分析助手。以下是一篇长文档部分段落的要点摘录（全文仍在分批整合中）。'
    + '请用' + outLang + '把它们合并为更紧凑的要点：去重、合并同类项，保留全部关键论据、方法、数据与结论。'
    + '直接分条输出，不要开场白。\n\n' + body;
}

// 按段落边界分块 (\n 切段): 单段超限先按句子边界细分、超长单句按码点硬切 (不拆代理对);
// 细分单元再贪心装块, 每块 UTF-8 字节数 ≤ maxBytes, 段落文本原样保留不丢失
export function splitForSummary(text, maxBytes) {
  const max = Math.floor(maxBytes) || CHUNK_BYTES;
  const paras = String(text || '').split(/\n+/).map(s => s.trim()).filter(Boolean);
  // 第一步: 段落 → ≤max 的单元 (单段超限时句子边界优先、码点兜底)
  const units = [];
  for (const para of paras) {
    if (utf8Len(para) <= max) { units.push(para); continue; }
    const sentences = para.split(/(?<=[.!?;。！？；])/);
    for (const s of sentences) {
      if (utf8Len(s) <= max) { units.push(s); continue; }
      let piece = '';
      let pieceBytes = 0;
      for (const ch of Array.from(s)) {
        const b = utf8Len(ch);
        if (pieceBytes + b > max) { units.push(piece); piece = ch; pieceBytes = b; }
        else { piece += ch; pieceBytes += b; }
      }
      if (piece) units.push(piece);
    }
  }
  // 第二步: 贪心装块 (块内 \n 连接, 连接符 1 字节计入)
  const chunks = [];
  let cur = '';
  let curBytes = 0;
  for (const u of units) {
    const b = utf8Len(u);
    const sep = cur ? 1 : 0;
    if (curBytes + sep + b > max) { chunks.push(cur); cur = u; curBytes = b; }
    else { cur = cur ? cur + '\n' + u : u; curBytes += sep + b; }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

// 上下文溢出错误识别: 各家 OpenAI 兼容服务文案不一 (Ollama "exceeds the available
// context size" / OpenAI·vLLM "maximum context length" / LM Studio "prompt is too long")
function isContextOverflowError(e) {
  return /exceeds the available context|context[_ -]?(size|length|window)|maximum context|prompt is too long|prompt too long|too many tokens|reduce the length/i.test(String(e && e.message || ''));
}

// 多轮收敛汇总: 分块要点总大小可能超过模型上下文 → 按字节分批 (每批正文 ≤ 60% 上限,
// 每批至少 2 份保证收敛), 逐批合并为更紧凑要点, 直到一批装下 → 末轮输出固定小节的全文分析。
// 返回 { content, calls } (calls = 汇总阶段实际调用次数)。
async function reduceParts(parts, outLang, config, limitBytes, chat, onProgress) {
  let cur = parts;
  let calls = 0;
  let rounds = 0;
  while (cur.length > 1) {
    const cap = Math.floor(limitBytes * 0.6);
    const batches = [];
    let batch = [];
    let bytes = 0;
    for (const p of cur) {
      const pb = utf8Len(p);
      if (batch.length >= 2 && bytes + pb > cap) { batches.push(batch); batch = [p]; bytes = pb; }
      else { batch.push(p); bytes += pb; }
    }
    if (batch.length) batches.push(batch);
    const isFinal = batches.length === 1;
    const next = [];
    for (let i = 0; i < batches.length; i++) {
      if (onProgress) onProgress({ stage: 'reduce', cur: i + 1, total: batches.length });
      const prompt = isFinal ? buildReducePrompt(batches[i], outLang) : buildMergePrompt(batches[i], outLang);
      next.push(await chat([{ role: 'user', content: prompt }], config));
      calls++;
    }
    cur = next;
    if (++rounds > 8) throw new Error('汇总整合未能收敛，请重试');
  }
  return { content: cur[0], calls: calls };
}

// 单轮编排: limitBytes 同时决定单次直出阈值与分块上限 (上下文自适应重试时逐次减半)
// options.chunkBaseBytes 可覆盖分块基准 (V1.7.10 云端 DeepSeek 传 CHUNK_BYTES=24000,
// 64K token 上下文无需缩块; 本地/自定义不传则跟随 customMaxBytes 默认 4000)
async function analyzeWithLimit(t, outLang, config, limitBytes, chat, onProgress, options) {
  if (utf8Len(t) <= limitBytes) {
    if (onProgress) onProgress({ stage: 'single', cur: 1, total: 1 });
    const content = await chat([{ role: 'user', content: buildSummaryPrompt(t, outLang) }], config);
    return { content: content, mode: 'single', chunks: 1, calls: 1 };
  }
  // 分块基准跟随自定义引擎「单次请求字节上限」配置 (customMaxBytes, 默认 4000——与翻译
  // 分块同长, 小上下文模型也放得下), 上限 CHUNK_BYTES 控制单块时长; 自适应重试的 limitBytes 再压
  const base = Math.min(CHUNK_BYTES, Math.max(1000,
    options.chunkBaseBytes || maxRequestBytes('custom', config)));
  const chunkBytes = Math.min(base, limitBytes);
  const chunks = splitForSummary(t, chunkBytes);
  if (chunks.length > MAX_CHUNKS) {
    throw new Error('文档文本过长（需 ' + chunks.length + ' 个分块，上限 ' + MAX_CHUNKS + '），暂不支持 AI 总结');
  }
  const parts = [];
  for (let i = 0; i < chunks.length; i++) {
    if (onProgress) onProgress({ stage: 'map', cur: i + 1, total: chunks.length });
    parts.push(await chat([{ role: 'user', content: buildChunkPrompt(chunks[i], outLang, i + 1, chunks.length) }], config));
  }
  const reduced = await reduceParts(parts, outLang, config, limitBytes, chat, onProgress);
  return { content: reduced.content, mode: 'map-reduce', chunks: chunks.length, calls: chunks.length + reduced.calls };
}

// 全文分析编排入口: 上下文溢出错误自动减半 limitBytes 重试 (≤ MAX_ADJUST_ATTEMPTS 次;
// 重试成本低——服务端在生成前即拒绝), 耗尽后报错附 Ollama 环境变量引导。
// opts.chat 可注入 (测试打桩/云端引擎, 默认 customChat); opts.onProgress({stage, cur, total})
// 供 UI 展示; opts.chunkBaseBytes 覆盖分块基准 (云端大上下文引擎传大值免碎块)。
// 返回 { content, mode: 'single'|'map-reduce', chunks, calls }。
export async function analyzeDocument(text, outLang, config, opts) {
  const options = opts || {};
  const chat = options.chat || customChat;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;
  const t = String(text || '').trim();
  if (!t) throw new Error('文档没有可分析的文本内容');
  let limitBytes = SINGLE_MAX_BYTES;
  for (let attempt = 1; ; attempt++) {
    try {
      return await analyzeWithLimit(t, outLang, config, limitBytes, chat, onProgress, options);
    } catch (e) {
      if (!isContextOverflowError(e)) throw e; // 非上下文错误不重试
      if (attempt >= MAX_ADJUST_ATTEMPTS || Math.floor(limitBytes / 2) < MIN_LIMIT_BYTES) {
        throw new Error('模型上下文窗口不足以容纳分析分块：' + (e && e.message ? e.message : e)
          + '\n\n建议：Ollama 可设置环境变量 OLLAMA_CONTEXT_LENGTH=8192（或更大）后重启 Ollama；'
          + '或在「自定义模型」配置中调小「单次请求字节上限」；或更换长上下文模型。');
      }
      limitBytes = Math.floor(limitBytes / 2);
      if (onProgress) onProgress({ stage: 'retry', cur: attempt + 1, total: MAX_ADJUST_ATTEMPTS });
    }
  }
}

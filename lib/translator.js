/**
 * 统一翻译核心模块 (ES Module)
 * 供 background.js (划词翻译) 和 doc-translate.js (全文翻译) 共用
 * 引擎: proxy (官方引擎, Pro 专享, Edge Function 代理百度, 免配置) |
 *       baidu | volcengine | tencent | custom (OpenAI 兼容接口, 支持 Ollama 本地部署)
 */

import { SUPABASE_URL, SUPABASE_ANON_KEY } from './supabase-auth.js';
import { getEntitlement } from './entitlement.js';

// ===== MD5 (百度签名用) =====
function md5(s) {
  function RotateLeft(l,i){return(l<<i)|(l>>>(32-i))}
  function AddUnsigned(lX,lY){
    var lX8=(lX&0x80000000),lY8=(lY&0x80000000),lX4=(lX&0x40000000),lY4=(lY&0x40000000),lR=(lX&0x3FFFFFFF)+(lY&0x3FFFFFFF);
    if(lX4&lY4)return(lR^0x80000000^lX8^lY8);
    if(lX4|lY4){if(lR&0x40000000)return(lR^0xC0000000^lX8^lY8);else return(lR^0x40000000^lX8^lY8)}else return(lR^lX8^lY8)
  }
  function F(x,y,z){return(x&y)|((~x)&z)}
  function G(x,y,z){return(x&z)|(y&(~z))}
  function H(x,y,z){return(x^y^z)}
  function I(x,y,z){return(y^(x|(~z)))}
  function FF(a,b,c,d,x,s,ac){a=AddUnsigned(a,AddUnsigned(AddUnsigned(F(b,c,d),x),ac));return AddUnsigned(RotateLeft(a,s),b)}
  function GG(a,b,c,d,x,s,ac){a=AddUnsigned(a,AddUnsigned(AddUnsigned(G(b,c,d),x),ac));return AddUnsigned(RotateLeft(a,s),b)}
  function HH(a,b,c,d,x,s,ac){a=AddUnsigned(a,AddUnsigned(AddUnsigned(H(b,c,d),x),ac));return AddUnsigned(RotateLeft(a,s),b)}
  function II(a,b,c,d,x,s,ac){a=AddUnsigned(a,AddUnsigned(AddUnsigned(I(b,c,d),x),ac));return AddUnsigned(RotateLeft(a,s),b)}
  function ConvertToWordArray(bytes){
    var lML=bytes.length,lNWT1=lML+8,lNWT2=(lNWT1-(lNWT1%64))/64,lNW=(lNWT2+1)*16,lWA=new Array(lNW-1),lBC=0;
    while(lBC<lML){lWA[lBC>>2]=(lWA[lBC>>2]|(bytes[lBC]<<((lBC%4)*8)));lBC++}
    lWA[lBC>>2]=(lWA[lBC>>2]|(0x80<<((lBC%4)*8)));lWA[lNW-2]=lML<<3;lWA[lNW-1]=lML>>>29;return lWA
  }
  function WordToHex(lV){
    var WTHV="",lB,lC;for(lC=0;lC<=3;lC++){lB=(lV>>>(lC*8))&255;var WTHVT="0"+lB.toString(16);WTHV=WTHV+WTHVT.substr(WTHVT.length-2,2)}return WTHV
  }
  var x=[],k,AA,BB,CC,DD,a,b,c,d,S11=7,S12=12,S13=17,S14=22,S21=5,S22=9,S23=14,S24=20,S31=4,S32=11,S33=16,S34=23,S41=6,S42=10,S43=15,S44=21;
  // V1.5.55: 签名按 UTF-8 字节计算 (TextEncoder, 代理对正确编为 4 字节)。
  // 旧 Utf8Encode 有两处缺陷: ① 把签名输入的 CRLF 改写为 LF 而发送的 q 原样 (URLSearchParams
  // 编码 %0D%0A) → 服务端按收到的 q 重算签名不一致 (54001); ② 代理对 (emoji 等增补平面字符)
  // 走 3 字节分支被编成 CESU-8 → 含此类字符时签名必错。
  x=ConvertToWordArray(new TextEncoder().encode(s));a=0x67452301;b=0xEFCDAB89;c=0x98BADCFE;d=0x10325476;
  for(k=0;k<x.length;k+=16){
    AA=a;BB=b;CC=c;DD=d;
    a=FF(a,b,c,d,x[k+0],S11,0xD76AA478);d=FF(d,a,b,c,x[k+1],S12,0xE8C7B756);c=FF(c,d,a,b,x[k+2],S13,0x242070DB);b=FF(b,c,d,a,x[k+3],S14,0xC1BDCEEE);
    a=FF(a,b,c,d,x[k+4],S11,0xF57C0FAF);d=FF(d,a,b,c,x[k+5],S12,0x4787C62A);c=FF(c,d,a,b,x[k+6],S13,0xA8304613);b=FF(b,c,d,a,x[k+7],S14,0xFD469501);
    a=FF(a,b,c,d,x[k+8],S11,0x698098D8);d=FF(d,a,b,c,x[k+9],S12,0x8B44F7AF);c=FF(c,d,a,b,x[k+10],S13,0xFFFF5BB1);b=FF(b,c,d,a,x[k+11],S14,0x895CD7BE);
    a=FF(a,b,c,d,x[k+12],S11,0x6B901122);d=FF(d,a,b,c,x[k+13],S12,0xFD987193);c=FF(c,d,a,b,x[k+14],S13,0xA679438E);b=FF(b,c,d,a,x[k+15],S14,0x49B40821);
    a=GG(a,b,c,d,x[k+1],S21,0xF61E2562);d=GG(d,a,b,c,x[k+6],S22,0xC040B340);c=GG(c,d,a,b,x[k+11],S23,0x265E5A51);b=GG(b,c,d,a,x[k+0],S24,0xE9B6C7AA);
    a=GG(a,b,c,d,x[k+5],S21,0xD62F105D);d=GG(d,a,b,c,x[k+10],S22,0x02441453);c=GG(c,d,a,b,x[k+15],S23,0xD8A1E681);b=GG(b,c,d,a,x[k+4],S24,0xE7D3FBC8);
    a=GG(a,b,c,d,x[k+9],S21,0x21E1CDE6);d=GG(d,a,b,c,x[k+14],S22,0xC33707D6);c=GG(c,d,a,b,x[k+3],S23,0xF4D50D87);b=GG(b,c,d,a,x[k+8],S24,0x455A14ED);
    a=GG(a,b,c,d,x[k+13],S21,0xA9E3E905);d=GG(d,a,b,c,x[k+2],S22,0xFCEFA3F8);c=GG(c,d,a,b,x[k+7],S23,0x676F02D9);b=GG(b,c,d,a,x[k+12],S24,0x8D2A4C8A);
    a=HH(a,b,c,d,x[k+5],S31,0xFFFA3942);d=HH(d,a,b,c,x[k+8],S32,0x8771F681);c=HH(c,d,a,b,x[k+11],S33,0x6D9D6122);b=HH(b,c,d,a,x[k+14],S34,0xFDE5380C);
    a=HH(a,b,c,d,x[k+1],S31,0xA4BEEA44);d=HH(d,a,b,c,x[k+4],S32,0x4BDECFA9);c=HH(c,d,a,b,x[k+7],S33,0xF6BB4B60);b=HH(b,c,d,a,x[k+10],S34,0xBEBFBC70);
    a=HH(a,b,c,d,x[k+13],S31,0x289B7EC6);d=HH(d,a,b,c,x[k+0],S32,0xEAA127FA);c=HH(c,d,a,b,x[k+3],S33,0xD4EF3085);b=HH(b,c,d,a,x[k+6],S34,0x04881D05);
    a=HH(a,b,c,d,x[k+9],S31,0xD9D4D039);d=HH(d,a,b,c,x[k+12],S32,0xE6DB99E5);c=HH(c,d,a,b,x[k+15],S33,0x1FA27CF8);b=HH(b,c,d,a,x[k+2],S34,0xC4AC5665);
    a=II(a,b,c,d,x[k+0],S41,0xF4292244);d=II(d,a,b,c,x[k+7],S42,0x432AFF97);c=II(c,d,a,b,x[k+14],S43,0xAB9423A7);b=II(b,c,d,a,x[k+5],S44,0xFC93A039);
    a=II(a,b,c,d,x[k+12],S41,0x655B59C3);d=II(d,a,b,c,x[k+3],S42,0x8F0CCC92);c=II(c,d,a,b,x[k+10],S43,0xFFEFF47D);b=II(b,c,d,a,x[k+1],S44,0x85845DD1);
    a=II(a,b,c,d,x[k+8],S41,0x6FA87E4F);d=II(d,a,b,c,x[k+15],S42,0xFE2CE6E0);c=II(c,d,a,b,x[k+6],S43,0xA3014314);b=II(b,c,d,a,x[k+13],S44,0x4E0811A1);
    a=II(a,b,c,d,x[k+4],S41,0xF7537E82);d=II(d,a,b,c,x[k+11],S42,0xBD3AF235);c=II(c,d,a,b,x[k+2],S43,0x2AD7D2BB);b=II(b,c,d,a,x[k+9],S44,0xEB86D391);
    a=AddUnsigned(a,AA);b=AddUnsigned(b,BB);c=AddUnsigned(c,CC);d=AddUnsigned(d,DD);
  }
  return(WordToHex(a)+WordToHex(b)+WordToHex(c)+WordToHex(d)).toLowerCase();
}

// ===== SHA-256 / HMAC-SHA256 (火山V4、腾讯TC3签名、缓存哈希用) =====
function sha256Hex(str) {
  return Array.from(sha256Bytes(new TextEncoder().encode(str)))
    .map(b => b.toString(16).padStart(2, '0')).join('');
}

function sha256Bytes(data) {
  function rightRotate(value, amount) { return (value >>> amount) | (value << (32 - amount)); }
  const K = [
    0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,
    0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,
    0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,
    0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,
    0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,
    0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,
    0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,
    0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2
  ];
  const H = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const msgLen = data.length;
  const bitLen = msgLen * 8;
  const padLen = ((56 - (msgLen + 1) % 64) + 64) % 64;
  const totalLen = msgLen + 1 + padLen + 8;
  const padded = new Uint8Array(totalLen);
  padded.set(data);
  padded[msgLen] = 0x80;
  const dv = new DataView(padded.buffer);
  dv.setUint32(totalLen - 4, bitLen, false);
  dv.setUint32(totalLen - 8, 0, false);
  for (let offset = 0; offset < totalLen; offset += 64) {
    const W = new Uint32Array(64);
    for (let i = 0; i < 16; i++) W[i] = dv.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i++) {
      const s0 = rightRotate(W[i-15], 7) ^ rightRotate(W[i-15], 18) ^ (W[i-15] >>> 3);
      const s1 = rightRotate(W[i-2], 17) ^ rightRotate(W[i-2], 19) ^ (W[i-2] >>> 10);
      W[i] = (W[i-16] + s0 + W[i-7] + s1) | 0;
    }
    let [a,b,c,d,e,f,g,h] = H;
    for (let i = 0; i < 64; i++) {
      const S1 = rightRotate(e, 6) ^ rightRotate(e, 11) ^ rightRotate(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + S1 + ch + K[i] + W[i]) | 0;
      const S0 = rightRotate(a, 2) ^ rightRotate(a, 13) ^ rightRotate(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (S0 + maj) | 0;
      h = g; g = f; f = e; e = (d + temp1) | 0; d = c; c = b; b = a; a = (temp1 + temp2) | 0;
    }
    H[0] = (H[0] + a) | 0; H[1] = (H[1] + b) | 0; H[2] = (H[2] + c) | 0; H[3] = (H[3] + d) | 0;
    H[4] = (H[4] + e) | 0; H[5] = (H[5] + f) | 0; H[6] = (H[6] + g) | 0; H[7] = (H[7] + h) | 0;
  }
  const result = new Uint8Array(32);
  const rv = new DataView(result.buffer);
  for (let i = 0; i < 8; i++) rv.setUint32(i * 4, H[i] >>> 0, false);
  return result;
}

function hmacSha256(message, key) {
  return hmacSha256Bytes(
    typeof message === 'string' ? new TextEncoder().encode(message) : message,
    typeof key === 'string' ? new TextEncoder().encode(key) : key
  );
}

function hmacSha256Bytes(msgBytes, keyBytes) {
  const blockLen = 64;
  let kPad = new Uint8Array(blockLen);
  if (keyBytes.length > blockLen) {
    kPad.set(sha256Bytes(keyBytes));
  } else {
    kPad.set(keyBytes);
  }
  const iPad = new Uint8Array(blockLen + msgBytes.length);
  const oPad = new Uint8Array(blockLen);
  for (let i = 0; i < blockLen; i++) {
    iPad[i] = kPad[i] ^ 0x36;
    oPad[i] = kPad[i] ^ 0x5c;
  }
  iPad.set(msgBytes, blockLen);
  const innerHash = sha256Bytes(iPad);
  const outerData = new Uint8Array(blockLen + innerHash.length);
  outerData.set(oPad);
  outerData.set(innerHash, blockLen);
  return sha256Bytes(outerData);
}

function hmacSha256Hex(message, key) {
  const result = hmacSha256(message, key);
  return Array.from(result).map(b => b.toString(16).padStart(2, '0')).join('');
}

// 各引擎单次请求字节上限 (UTF-8 字节数, 官方限制留安全余量)
// 文档翻译分块按此值切分: 切换引擎后分块长度随之变化 (缓存键含引擎, 互不串)
// 自定义引擎可通过配置项 customMaxBytes 调整 (500~200000, 空/非法回退 4000)
const ENGINE_MAX_BYTES = {
  proxy: 2000,        // 官方引擎 (V1.7.75): 缩短单次输出, 单页可切出更多批次填满并发
  baidu: 5500,       // 官方 6000 字节/次
  volcengine: 12000, // 官方 5000 字符/次 (汉字 3 字节, 按 4000 汉字折算)
  tencent: 1800,     // 官方 2000 字节/次 (最紧, 汉字约 600 字/次)
  custom: 4000       // 自定义端点默认值, 可由 customMaxBytes 配置覆盖
};

export function maxRequestBytes(backend, config) {
  if (backend === 'custom' && config) {
    const n = Number(resolveCustomSlot(config).maxBytes);
    if (n >= 500 && n <= 200000) return Math.floor(n);
  }
  return ENGINE_MAX_BYTES[backend] || 4000;
}

export function utf8Len(text) {
  return new TextEncoder().encode(text).length;
}

// ===== 段落批处理 (V1.7.24): 连续段落合并为一次请求 =====
// 动机: 百度/官方引擎 QPS 1 次/秒 (请求间隔硬限), 逐段请求是文档翻译的主要速度瓶颈;
// 把连续段落以 '\n\n' 合并到引擎单次字节上限内, 请求数可降一个数量级。
// 贪心分组: 返回 [{ idx... }] 形态的索引数组; 单段超限也独占一批 (调用方自行切块)。
export function groupParagraphBatches(texts, maxBytes) {
  const limit = Math.max(Number(maxBytes) || 0, 1);
  const batches = [];
  let cur = [];
  let curBytes = 0;
  for (let i = 0; i < texts.length; i++) {
    const t = String(texts[i] == null ? '' : texts[i]);
    const b = utf8Len(t);
    const add = cur.length ? b + 2 : b; // '\n\n' 分隔符 2 字节
    if (cur.length && curBytes + add > limit) {
      batches.push(cur);
      cur = [i];
      curBytes = b;
      continue;
    }
    cur.push(i);
    curBytes += add;
  }
  if (cur.length) batches.push(cur);
  return batches;
}

// 批量译文按段落还原: 双换行优先 (引擎保留段落分隔), 其次单换行 (百度按行返回);
// 段数不符返回 null —— 调用方回退逐段翻译, 保证译文不错位。
export function splitBatchTranslation(translated, count) {
  const n = Math.floor(Number(count) || 0);
  const s = String(translated == null ? '' : translated).trim();
  if (n <= 0 || !s) return null;
  if (n === 1) return [s];
  for (const re of [/\n{2,}/, /\n+/]) {
    const parts = s.split(re).map(p => p.trim()).filter(p => p);
    if (parts.length === n) return parts;
  }
  return null;
}

// ===== 引擎并发度 (V1.7.25) =====
// 百度/官方: 账户 QPS 1 次/秒 (客户端 1.2s 间隔 + 服务端串行队列), 并发只会排队, 保持 1;
// 火山默认 10 QPS、腾讯默认 5 QPS, 取 3 路并发留余量; 自定义端点未知, 保守 2。
const ENGINE_CONCURRENCY = {
  proxy: 12, // V1.7.78: 回退 20 -> 12 (高并发下输出内容出现错乱, 优先保证译文质量)
  baidu: 1,
  volcengine: 3,
  tencent: 3,
  custom: 2
};

export function concurrencyForEngine(backend) {
  return ENGINE_CONCURRENCY[backend] || 1;
}

// 受限并发执行: 最多 limit 个任务同时运行, 全部完成后返回;
// worker 按序取任务 (顺序稳定), 单个任务失败向上抛 (调用方自行捕获)。
export async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const max = Math.max(Math.floor(Number(limit) || 1), 1);
  let cursor = 0;
  const runners = [];
  for (let k = 0; k < Math.min(max, list.length); k++) {
    runners.push((async () => {
      while (true) {
        const i = cursor;
        cursor += 1;
        if (i >= list.length) return;
        await worker(list[i], i);
      }
    })());
  }
  await Promise.all(runners);
}

// 百度 QPS 限速 (免费版 1次/秒, 留 20% 余量)
let _lastBaiduCall = 0;
// 串行化队列: 检查-等待-更新非原子, 并发调用会同时判定"无需等待"同时发出 → 54003。
// 同一上下文内经 promise 链按序执行 (V1.5.55); 跨上下文 (background 与文档翻译页)
// 各持一份队列无法互斥, 为已知限制。
let _baiduChain = Promise.resolve();

// ===== 统一入口 =====
export async function translateText(text, from, to, backend, config) {
  if (backend === 'proxy') return await translateProxy(text, from, to, config);
  if (backend === 'baidu') return await translateBaidu(text, from, to, config);
  if (backend === 'volcengine') return await translateVolcengine(text, from, to, config);
  if (backend === 'tencent') return await translateTencent(text, from, to, config);
  if (backend === 'custom') return await translateCustom(text, from, to, config);
  return await translateBaidu(text, from, to, config);
}

// 自定义模型槽位解析 (V1.5.49): 最多 3 个模型槽位, customActive 指定启用位
// 优先读新结构 customModels 数组 (非空数组才视为已迁移); 否则回退旧扁平字段 (存量配置兼容)
export function resolveCustomSlot(config) {
  const normalize = s => ({
    baseUrl: String(s.baseUrl || '').trim().replace(/\/+$/, ''),
    apiKey: String(s.apiKey || '').trim(),
    model: String(s.model || '').trim() || 'gpt-3.5-turbo',
    maxBytes: Number(s.maxBytes) || 0
  });
  const arr = config && Array.isArray(config.customModels) ? config.customModels : null;
  if (arr && arr.length) {
    // 槽位数量 1~3 可动态增删 (V1.7.46): 运行期选中位可能超出当前数组, 收敛到最后一槽
    const idx = Math.min(Math.max(Number(config.customActive) || 0, 0), arr.length - 1);
    const slot = arr[idx];
    // 新结构已存在时, 启用槽位未配置 → 返回空槽 (由 validateBackendConfig 报错提示配置),
    // 不再穿透回旧扁平字段 (V1.5.55: 避免打到与用户所选槽位不符的旧端点)
    return normalize(slot || {});
  }
  // 旧扁平字段 (customBaseUrl/customApiKey/customModel/customMaxBytes)
  return normalize({
    baseUrl: config && config.customBaseUrl,
    apiKey: config && config.customApiKey,
    model: config && config.customModel,
    maxBytes: config && config.customMaxBytes
  });
}

// 缓存层后端标识 (V1.5.50): 非 custom 原样透传;
// custom 追加端点+模型名 ("custom:baseUrl|model") 作缓存键的引擎段——
// 三个槽位各自独立命中, 切换模型不会拿到旧模型译文, 切回即复用
// (cache.js 依 "custom" / "custom:" 前缀识别走本地单层)
export function cacheBackendId(backend, config) {
  if (backend !== 'custom') return backend;
  const s = resolveCustomSlot(config);
  return 'custom:' + s.baseUrl + '|' + s.model;
}

// 校验指定引擎配置是否完整, 返回错误信息或 null
// proxy (官方引擎) 免配置: 密钥在服务端; 未登录/非 Pro 由 Function 返回 401/403, 在此给出可读引导
export function validateBackendConfig(backend, config) {
  if (backend === 'proxy') return null;
  if (backend === 'baidu' && (!config.baiduAppId || !config.baiduKey)) {
    return '请先在插件设置中配置百度 APP ID 和密钥';
  }
  if (backend === 'volcengine' && (!config.volcAccessKeyId || !config.volcSecretAccessKey)) {
    return '请先在插件设置中配置火山 Access Key ID 和 Secret Access Key';
  }
  if (backend === 'tencent' && (!config.tencentSecretId || !config.tencentSecretKey)) {
    return '请先在插件设置中配置腾讯 SecretId 和 SecretKey';
  }
  if (backend === 'custom' && !resolveCustomSlot(config).baseUrl) {
    return '请先在插件设置中配置自定义模型接口地址';
  }
  return null;
}

// ===== 官方引擎 (V1.7.0 阶段2, Pro 专享) =====
// Edge Function translate 代理百度: 客户端免配置免密钥, 计费/门控/QPS 全在服务端。
// 语言映射在服务端做, 此处透传原始语言码; 错误按状态码映射为可读引导。
async function translateProxy(text, from, to, config) {
  // 读原始会话 (不触发续期: 翻译路径高频, 过期会话交给 Function 401 引导重登)
  const s = await readRawSession();
  if (!s) {
    throw new Error('官方引擎需要登录：请点击插件图标，在底部「账户」注册/登录后使用');
  }
  // V1.7.1: 非 Pro 本地预检快速拦截——此前每段都完整走一次服务端 403 往返
  // (数百段文档 × 每段约 1s, 失败等待数分钟且页面锁死在"翻译中"无法返回)。
  // getEntitlement 带 10 分钟缓存 (高频路径零网络), Pro 判定客户端最多滞后 10 分钟,
  // 服务端仍是最终强制者 (entitlement Function 判 pro + charge RPC)。
  const ent = await getEntitlement();
  if (!ent || ent.plan !== 'pro') {
    throw new Error('官方引擎为 Pro 专享功能：当前账户未开通 Pro（或套餐未生效），暂时无法使用');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 100000); // V1.7.71: 官方引擎改为 LLM 生成式翻译, 单段耗时可达 30~60s
  try {
    const resp = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/translate', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + s.accessToken
      },
      body: JSON.stringify({ text: text, from: from, to: to }),
      signal: ctrl.signal
    });
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new Error('官方引擎需要登录：请点击插件图标，在底部「账户」重新登录');
      }
      if (resp.status === 403) {
        throw new Error('官方引擎为 Pro 专享功能，需要 Pro 套餐生效后使用');
      }
      if (resp.status === 429) {
        throw new Error('今日官方翻译额度已用完（5 万字/日）——次日 0 点恢复，或加购 100 万字符（¥10）');
      }
      if (resp.status === 503) {
        throw new Error('官方引擎暂未开放（服务端未配置）');
      }
      let errMsg = '';
      try { const e = await resp.json(); errMsg = e.error || ''; } catch(_) {}
      throw new Error(`HTTP ${resp.status}${errMsg ? ': ' + errMsg : ''}`);
    }
    const data = await resp.json();
    const result = data && data.translated ? String(data.translated) : '';
    if (!result) throw new Error('官方引擎返回空结果');
    // V1.7.8: 服务端回传当日用量 (唯一真相) → 仅落本地供 popup 展示, 不参与任何判定
    if (data && typeof data.proxyUsedChars === 'number') {
      try {
        const p = chrome.storage.local.set({
          vtProxyUsage: {
            userId: s.userId,
            usedChars: Number(data.proxyUsedChars) || 0,
            dailyLimit: Number(data.proxyDailyLimit) || 100000,
            time: Date.now()
          }
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_e) { /* 展示用途, 失败静默 */ }
    }
    return result;
  } catch(e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('官方引擎: 超时');
    throw e;
  }
}

// 读 chrome.storage 原始会话 (不续期/不清会话, 纯读)
async function readRawSession() {
  try {
    const items = await chrome.storage.local.get('vtAuthSession');
    const s = items && items.vtAuthSession;
    return (s && s.accessToken && s.userId) ? s : null;
  } catch (e) {
    return null; // chrome 不可用 (如 Node 测试环境) 视为未登录
  }
}

// ===== 配额类错误升级引导 (V1.7.4) =====
// 三大 BYOK 引擎撞免费额度/限流时, 错误文案附官方引擎引导——用户最痛时刻的转化点。
// 百度按 error_code 白名单精确识别; 火山/腾讯各家错误码不统一, 按 Code+Message 关键字模糊识别。
export const PRO_UPSELL_TIP = '\n💡 升级 Pro：免配置直译，5 万字/日（≈50 页论文）';

// ===== 购买入口开关 (V1.7.79) =====
// 扫码支付链路尚未开放: 权益页「升级 Pro」只提示"即将开放", 支付页禁用下单按钮。
// 开放时改为 true (并确认 create-order 的渠道密钥已配置), 其余代码无需改动。
export const PRO_PURCHASE_ENABLED = false;
export const PRO_PURCHASE_COMING_SOON_TIP = '购买入口即将开放，当前可先用自带密钥的免费引擎（百度 / 火山 / 腾讯 / 自定义模型）';

const BAIDU_QUOTA_CODES = ['54003', '54004']; // 访问频率受限(QPS 超限) / 账户余额不足(免费月额度耗尽)
function quotaUpsellTip(code, msg) {
  const s = String(code || '') + ' ' + String(msg || '');
  return /flowlimit|limitexceeded|soldout|quota|arrear|balance|overdue|流控|限流|额度|欠费|售罄|余额不足/i.test(s) ? PRO_UPSELL_TIP : '';
}

// ===== 百度翻译 =====
async function translateBaidu(text, from, to, config) {
  // QPS 限速串行化: 并发调用按序排队, 防竞态下同时发出触发 54003
  const run = _baiduChain.then(() => translateBaiduInner(text, from, to, config));
  _baiduChain = run.then(() => {}, () => {});
  return run;
}

async function translateBaiduInner(text, from, to, config) {
  const appId = config.baiduAppId;
  const key = config.baiduKey;
  if (!appId || !key) throw new Error('请先配置百度 APP ID 和密钥');

  const now = Date.now();
  const gap = 1200 - (now - _lastBaiduCall);
  if (gap > 0) await new Promise(r => setTimeout(r, gap));
  _lastBaiduCall = Date.now();

  const langMap = { 'ja': 'jp', 'ko': 'kor', 'zh-CN': 'zh', 'auto': 'auto' };
  const fromLang = langMap[from] || from;
  const toLang = langMap[to] || to;

  const salt = String(Date.now());
  const signStr = appId + text + salt + key;
  const sign = md5(signStr);

  const body = new URLSearchParams({
    q: text, from: fromLang, to: toLang, appid: appId, salt: salt, sign: sign
  }).toString();

  const url = 'https://fanyi-api.baidu.com/api/trans/vip/translate';

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body,
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let errMsg = '';
      try { const e = await resp.json(); errMsg = e.error_msg || ''; } catch(_) {}
      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data = await resp.json();
    if (data && data.error_code) throw new Error(`百度错误 ${data.error_code}: ${data.error_msg}` + (BAIDU_QUOTA_CODES.includes(String(data.error_code)) ? PRO_UPSELL_TIP : ''));

    const result = data && data.trans_result ? data.trans_result.map(t => t.dst).join('\n') : '';
    if (!result) throw new Error('百度返回空结果: ' + JSON.stringify(data).substring(0, 200));
    return result;
  } catch(e) {
    clearTimeout(timer);
    throw new Error('百度翻译: ' + (e.name === 'AbortError' ? '超时' : e.message));
  }
}

// ===== 火山翻译 =====
async function translateVolcengine(text, from, to, config) {
  const accessKeyId = config.volcAccessKeyId;
  const secretAccessKey = config.volcSecretAccessKey;
  if (!accessKeyId || !secretAccessKey) throw new Error('请先配置火山 Access Key ID 和 Secret Access Key');

  const langMap = { 'zh-CN': 'zh' };
  // 显式处理 auto: 火山不支持自动检测源语言, 必须落到空串由下方守卫报错;
  // 若写成 langMap[from] || from 会把 '' 吞掉变回 'auto', 直接把非法值发给上游 (V1.7.43 修复)
  const sourceLang = from === 'auto' ? '' : (langMap[from] || from);
  const targetLang = langMap[to] || to;
  // 火山 TranslateText 不支持自动检测源语言; 此前静默兜成 'en', 非英语原文会被
  // 当英语翻译产出错误译文 (V1.5.55 修复), 现在明确报错引导用户手选源语言
  if (!sourceLang) throw new Error('火山翻译不支持自动检测源语言，请在设置中手动选择源语言');

  const body = JSON.stringify({
    SourceLanguage: sourceLang,
    TargetLanguage: targetLang,
    TextList: [text]
  });

  const service = 'translate';
  const host = 'open.volcengineapi.com';
  const region = 'cn-north-1';
  const action = 'TranslateText';
  const version = '2020-06-01';
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z');
  const date = timestamp.substring(0, 8);

  const credScope = `${date}/${region}/${service}/request`;
  const payloadHash = sha256Hex(body);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-date:${timestamp}\n`;
  const signedHeaders = 'content-type;host;x-date';
  const canonicalRequest = `POST\n/\nAction=${action}&Version=${version}\n${canonicalHeaders}\n${signedHeaders}\n${payloadHash}`;
  const stringToSign = `HMAC-SHA256\n${timestamp}\n${credScope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmacSha256(date, secretAccessKey);
  const kRegion = hmacSha256(region, kDate);
  const kService = hmacSha256(service, kRegion);
  const kSigning = hmacSha256('request', kService);
  const signature = hmacSha256Hex(stringToSign, kSigning);

  const authorization = `HMAC-SHA256 Credential=${accessKeyId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}/?Action=${action}&Version=${version}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorization,
        'X-Date': timestamp
      },
      body: body,
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let errMsg = '';
      let errCode = '';
      try { const e = await resp.json(); const er = e && e.ResponseMetadata && e.ResponseMetadata.Error; errCode = (er && er.Code) || ''; errMsg = (er && er.Message) || e.Message || ''; } catch(_) {}
      throw new Error(`HTTP ${resp.status}: ${errMsg}` + quotaUpsellTip(errCode, errMsg));
    }

    const data = await resp.json();
    if (data && data.ResponseMetadata && data.ResponseMetadata.Error) throw new Error(`火山错误: ${data.ResponseMetadata.Error.Message}` + quotaUpsellTip(data.ResponseMetadata.Error.Code, data.ResponseMetadata.Error.Message));
    const result = data && data.TranslationList ? data.TranslationList.map(t => t.Translation).join(' ') : '';
    if (!result) throw new Error('火山返回空结果: ' + JSON.stringify(data).substring(0, 200));
    return result;
  } catch(e) {
    clearTimeout(timer);
    throw new Error('火山翻译: ' + (e.name === 'AbortError' ? '超时' : e.message));
  }
}

// ===== 腾讯翻译 =====
async function translateTencent(text, from, to, config) {
  const secretId = config.tencentSecretId;
  const secretKey = config.tencentSecretKey;
  if (!secretId || !secretKey) throw new Error('请先配置腾讯 SecretId 和 SecretKey');

  const langMap = { 'zh-CN': 'zh', 'auto': 'auto' };
  const source = langMap[from] || from;
  const target = langMap[to] || to;

  const host = 'tmt.tencentcloudapi.com';
  const service = 'tmt';
  const action = 'TextTranslate';
  const version = '2018-03-21';
  const region = 'ap-beijing';
  const timestamp = Math.floor(Date.now() / 1000);
  const date = new Date(timestamp * 1000).toISOString().split('T')[0];

  const payload = JSON.stringify({
    SourceText: text,
    Source: source,
    Target: target,
    ProjectId: 0
  });

  const credScope = `${date}/${service}/tc3_request`;
  const hashedPayload = sha256Hex(payload);
  const canonicalHeaders = `content-type:application/json\nhost:${host}\nx-tc-action:${action.toLowerCase()}\n`;
  const signedHeaders = 'content-type;host;x-tc-action';
  const canonicalRequest = `POST\n/\n\n${canonicalHeaders}\n${signedHeaders}\n${hashedPayload}`;
  const stringToSign = `TC3-HMAC-SHA256\n${timestamp}\n${credScope}\n${sha256Hex(canonicalRequest)}`;

  const kDate = hmacSha256(date, 'TC3' + secretKey);
  const kService = hmacSha256(service, kDate);
  const kSigning = hmacSha256('tc3_request', kService);
  const signature = hmacSha256Hex(stringToSign, kSigning);

  const authorization = `TC3-HMAC-SHA256 Credential=${secretId}/${credScope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  const url = `https://${host}`;

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': authorization,
        'X-TC-Action': action,
        'X-TC-Version': version,
        'X-TC-Region': region,
        'X-TC-Timestamp': String(timestamp)
      },
      body: payload,
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let errMsg = '';
      try { const e = await resp.json(); errMsg = (e.Response && e.Response.Error && e.Response.Error.Message) || ''; } catch(_) {}
      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data = await resp.json();
    if (data && data.Response && data.Response.Error) throw new Error(`腾讯错误: ${data.Response.Error.Message}` + quotaUpsellTip(data.Response.Error.Code, data.Response.Error.Message));
    const result = data && data.Response ? data.Response.TargetText : '';
    if (!result) throw new Error('腾讯返回空结果: ' + JSON.stringify(data).substring(0, 200));
    return result;
  } catch(e) {
    clearTimeout(timer);
    throw new Error('腾讯翻译: ' + (e.name === 'AbortError' ? '超时' : e.message));
  }
}

// ===== 自定义模型 (OpenAI 兼容接口, 支持 Ollama 本地部署) =====
async function translateCustom(text, from, to, config) {
  // 多槽位: 按启用位解析 (V1.5.49), 旧扁平字段自动兼容
  const slot = resolveCustomSlot(config);
  const baseUrl = slot.baseUrl;
  if (!baseUrl) throw new Error('请先配置自定义模型接口地址');
  const model = slot.model;
  const apiKey = slot.apiKey;

  const langNames = { 'en': 'English', 'zh': 'Simplified Chinese', 'zh-CN': 'Simplified Chinese', 'auto': '' };
  const srcName = langNames[from] || from;
  const tgtName = langNames[to] || to;
  const srcPart = srcName ? `The source language is ${srcName}.` : 'Auto-detect the source language.';
  const prompt = `You are a professional academic translation engine. ${srcPart} Translate the following text into ${tgtName}. Output ONLY the translated text without any explanations, quotes or extra formatting.\n\n${text}`;

  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers['Authorization'] = 'Bearer ' + apiKey;

  const ctrl = new AbortController();
  // 本地模型推理较慢, 超时放宽到 60s
  const timer = setTimeout(() => ctrl.abort(), 60000);
  try {
    const resp = await fetch(baseUrl + '/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: model,
        messages: [{ role: 'user', content: prompt }],
        temperature: 0.2,
        stream: false
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (!resp.ok) {
      let errMsg = '';
      try { const e = await resp.json(); errMsg = (e.error && e.error.message) || e.message || ''; } catch(_) {}
      if (resp.status === 403 && /localhost|127\.0\.0\.1/i.test(baseUrl)) {
        throw new Error('Ollama 拒绝了扩展的跨域请求 (403)。请设置环境变量 OLLAMA_ORIGINS=chrome-extension://* 后重启 Ollama');
      }
      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }

    const data = await resp.json();
    const result = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim() : '';
    if (!result) throw new Error('模型返回空结果: ' + JSON.stringify(data).substring(0, 200));
    return result;
  } catch(e) {
    clearTimeout(timer);
    throw new Error('自定义模型: ' + (e.name === 'AbortError' ? '超时' : e.message));
  }
}

// ===== 大模型对话 (V1.7.9): OpenAI 兼容 /chat/completions 通用调用 =====
// 供全文分析总结 (lib/ai-summary.js) 等非翻译任务复用: 与 translateCustom 共用槽位解析/
// 请求头/Ollama 403 跨域提示/错误文案, 提示词由调用方组织 (messages 数组整传)。
// opts.temperature 默认 0.3 (分析总结略高于翻译的 0.2), opts.timeoutMs 默认 60s。
// V1.7.11: opts.slot 显式连接参数 { baseUrl, apiKey, model } (独立 AI 模型配置,
// 与翻译引擎槽位分离); 未传/无 baseUrl 时回退翻译引擎槽位 (向后兼容)。
export async function customChat(messages, config, opts) {
  const o = opts || {};
  const slot = (o.slot && o.slot.baseUrl)
    ? {
        baseUrl: String(o.slot.baseUrl).trim().replace(/\/+$/, ''),
        apiKey: String(o.slot.apiKey || '').trim(),
        model: String(o.slot.model || '').trim() || 'gpt-3.5-turbo'
      }
    : resolveCustomSlot(config);
  if (!slot.baseUrl) throw new Error('请先配置自定义模型接口地址');
  const headers = { 'Content-Type': 'application/json' };
  if (slot.apiKey) headers['Authorization'] = 'Bearer ' + slot.apiKey;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && Number(opts.timeoutMs)) || 60000);
  try {
    const resp = await fetch(slot.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: headers,
      body: JSON.stringify({
        model: slot.model,
        messages: messages,
        temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.3,
        stream: false
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      let errMsg = '';
      try { const e = await resp.json(); errMsg = (e.error && e.error.message) || e.message || ''; } catch(_) {}
      if (resp.status === 403 && /localhost|127\.0\.0\.1/i.test(slot.baseUrl)) {
        throw new Error('Ollama 拒绝了扩展的跨域请求 (403)。请设置环境变量 OLLAMA_ORIGINS=chrome-extension://* 后重启 Ollama');
      }
      throw new Error(`HTTP ${resp.status}: ${errMsg}`);
    }
    const data = await resp.json();
    const result = data && data.choices && data.choices[0] && data.choices[0].message
      ? String(data.choices[0].message.content || '').trim() : '';
    if (!result) throw new Error('模型返回空结果: ' + JSON.stringify(data).substring(0, 200));
    return result;
  } catch(e) {
    clearTimeout(timer);
    throw new Error('自定义模型: ' + (e.name === 'AbortError' ? '超时' : e.message));
  }
}

// 云端语音合成 (V1.7.37): Pro 专享, 服务端代理百度 TTS, 返回 mp3 字节 (ArrayBuffer)。
// 客户端只发文本, Key 全在服务端; 计费走 tts_charge RPC (每日字符上限, 北京日)。
export async function cloudTts(text, opts) {
  const s = await readRawSession();
  if (!s) {
    throw new Error('云端语音合成需要登录：请点击插件图标，在底部「账户」注册/登录后使用');
  }
  const ent = await getEntitlement();
  if (!ent || ent.plan !== 'pro') {
    throw new Error('云端语音合成是 Pro 专享功能：当前账户未开通 Pro（或套餐未生效）');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && Number(opts.timeoutMs)) || 60000);
  try {
    const resp = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/tts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + s.accessToken
      },
      body: JSON.stringify({
        text: text,
        lang: (opts && opts.lang) || 'zh',
        speed: (opts && typeof opts.speed === 'number') ? opts.speed : 5,
        voice: (opts && opts.voice) || ''
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new Error('云端语音合成需要登录：请点击插件图标，在底部「账户」重新登录');
      }
      if (resp.status === 403) {
        throw new Error('云端语音合成为 Pro 专享功能，需要 Pro 套餐生效后使用');
      }
      if (resp.status === 429) {
        throw new Error('今日云端语音合成额度已用完（2 万字符/日，北京时间 0 点重置）');
      }
      if (resp.status === 503) {
        throw new Error('云端语音合成暂未开放：服务端缺少 BAIDU_TTS_AK / BAIDU_TTS_SK（或 tts 函数未部署）。可先改用「百度（自带密钥）」或「自定义接口」');
      }
      let detail = '';
      try {
        const e = await resp.json();
        detail = e && e.error ? String(e.error) : '';
      } catch (_e) { /* 非 JSON 响应 */ }
      throw new Error('云端语音合成失败（HTTP ' + resp.status + (detail ? '：' + detail : '') + '）');
    }
    return await resp.arrayBuffer();
  } finally {
    clearTimeout(timer);
  }
}


// ===== 百度语音合成 (V1.7.38, 免费用户 BYOK): 客户端直连百度, 只需自己的 AK/SK =====
// 语音技术控制台与翻译开放平台的密钥不是同一套; token 有效期 30 天, 会话内缓存。
let _baiduTtsToken = '';
let _baiduTtsTokenAt = 0;
let _baiduTtsTokenKey = '';

async function baiduTtsToken(ak, sk) {
  const cacheKey = ak + '|' + sk;
  if (_baiduTtsToken && _baiduTtsTokenKey === cacheKey && Date.now() - _baiduTtsTokenAt < 25 * 24 * 3600 * 1000) {
    return _baiduTtsToken;
  }
  const url = 'https://aip.baidubce.com/oauth/2.0/token?grant_type=client_credentials'
    + '&client_id=' + encodeURIComponent(ak) + '&client_secret=' + encodeURIComponent(sk);
  const resp = await fetch(url, { method: 'POST' });
  const data = await resp.json().catch(() => ({}));
  if (!data || !data.access_token) {
    const msg = (data && (data.error_description || data.error)) || ('HTTP ' + resp.status);
    throw new Error('百度鉴权失败：' + msg + '（请确认 AK/SK 来自「语音技术」应用）');
  }
  _baiduTtsToken = data.access_token;
  _baiduTtsTokenAt = Date.now();
  _baiduTtsTokenKey = cacheKey;
  return _baiduTtsToken;
}

export async function baiduTts(text, opts) {
  const o = opts || {};
  const ak = String(o.ak || '').trim();
  const sk = String(o.sk || '').trim();
  if (!ak || !sk) {
    throw new Error('百度语音合成需要 API Key 与 Secret Key（语音技术控制台创建应用）');
  }
  const token = await baiduTtsToken(ak, sk);
  const form = new URLSearchParams({
    tex: String(text || ''),
    tok: token,
    cuid: 'xiaoti-tts',
    ctp: '1',
    lan: o.lang === 'en' ? 'en' : 'zh',
    spd: String(Math.min(Math.max(Number(o.speed) || 5, 0), 15)),
    pit: '5',
    vol: '5',
    per: String(o.voice || '0'),
    aue: '3' // mp3
  });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 30000);
  try {
    const resp = await fetch('https://tsn.baidu.com/text2audio', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
      signal: ctrl.signal
    });
    const ctype = resp.headers.get('content-type') || '';
    if (ctype.indexOf('json') >= 0) {
      const err = await resp.json().catch(() => ({}));
      throw new Error('百度语音合成失败：' + ((err && err.err_msg) || ('err_no ' + (err && err.err_no))));
    }
    if (!resp.ok) {
      throw new Error('百度语音合成失败（HTTP ' + resp.status + '）');
    }
    const buf = await resp.arrayBuffer();
    if (!buf || buf.byteLength < 512) {
      throw new Error('百度返回音频为空或过短');
    }
    return buf;
  } finally {
    clearTimeout(timer);
  }
}

// 与 customChat 同签名 (可直接注入 lib/ai-summary.js analyzeDocument 的 opts.chat)。
// 密钥/限额全在服务端 (Edge Function ai-chat): 网关验签 → 判 pro → ai_charge 原子扣减
// 当日输入字符 (默认 10 万/天) → 调 DeepSeek → 失败退款 → 用量回传。
// opts.temperature 默认 0.3, opts.timeoutMs 默认 120s (长文生成 60~120s, 比翻译宽)。
export async function cloudChat(messages, config, opts) {
  // 读原始会话 (不触发续期, 过期会话交给 Function 401 引导重登)
  const s = await readRawSession();
  if (!s) {
    throw new Error('云端 AI 分析需要登录：请点击插件图标，在底部「账户」注册/登录后使用');
  }
  // 非 Pro 本地预检快速拦截 (getEntitlement 带 3 分钟缓存, 零等待;
  // 服务端仍是最终强制者——ai-chat Function 判 pro + ai_charge RPC)
  const ent = await getEntitlement();
  if (!ent || ent.plan !== 'pro') {
    throw new Error('云端 AI 分析为 Pro 专享功能：当前账户未开通 Pro（或套餐未生效），暂时无法使用');
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), (opts && Number(opts.timeoutMs)) || 120000);
  try {
    const resp = await fetch(SUPABASE_URL.replace(/\/+$/, '') + '/functions/v1/ai-chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_ANON_KEY,
        'Authorization': 'Bearer ' + s.accessToken
      },
      body: JSON.stringify({
        messages: messages,
        temperature: (opts && typeof opts.temperature === 'number') ? opts.temperature : 0.3,
        // V1.7.29: 深度思考开关 (默认关闭); 服务端据此给 DeepSeek 传 thinking.type
        deepThink: !!(opts && opts.deepThink)
      }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    if (!resp.ok) {
      if (resp.status === 401) {
        throw new Error('云端 AI 分析需要登录：请点击插件图标，在底部「账户」重新登录');
      }
      if (resp.status === 403) {
        throw new Error('云端 AI 分析为 Pro 专享功能，需要 Pro 套餐生效后使用');
      }
      if (resp.status === 429) {
        throw new Error('今日云端 AI 分析字符配额已用完（每日 10 万字符，北京时间 0 点重置）');
      }
      if (resp.status === 503) {
        throw new Error('云端 AI 分析暂未开放（服务端未配置）');
      }
      let errMsg = '';
      try { const e = await resp.json(); errMsg = e.error || ''; } catch (_) {}
      throw new Error(`HTTP ${resp.status}${errMsg ? ': ' + errMsg : ''}`);
    }
    const data = await resp.json();
    const result = data && typeof data.content === 'string' ? data.content.trim() : '';
    if (!result) throw new Error('云端 AI 返回空结果');
    // 服务端回传当日用量 (唯一真相) → 仅落本地供 popup 展示, 不参与任何判定
    if (data && typeof data.aiUsedChars === 'number') {
      try {
        const p = chrome.storage.local.set({
          vtAiUsage: {
            userId: s.userId,
            usedChars: Number(data.aiUsedChars) || 0,
            dailyLimit: Number(data.aiDailyLimit) || 100000,
            time: Date.now()
          }
        });
        if (p && typeof p.catch === 'function') p.catch(() => {});
      } catch (_e) { /* 展示用途, 失败静默 */ }
    }
    return result;
  } catch (e) {
    clearTimeout(timer);
    if (e.name === 'AbortError') throw new Error('云端 AI 分析超时（长文生成耗时较长，请重试）');
    throw e;
  }
}

export { sha256Hex };

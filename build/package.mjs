/**
 * 发布打包脚本 (V1.5.54): node build/package.mjs
 * 产物: dist/xiaoti-translator_v{manifest版本}.zip —— manifest.json 位于 zip 根目录,
 *       结构符合 Chrome Web Store 上传要求; 亦可解压后"加载已解压的扩展程序"。
 * 排除策略: 运行时文件白名单收集, 文档/测试/云端部署/.git 等开发内容天然不入包;
 *           lib/ 下排除未引用的 .mjs (pdf.js ESM 冗余构建, 扩展只用 UMD 版 .js)。
 * 依赖: 仅 Node 内置模块; 压缩经 PowerShell Compress-Archive (Windows)。
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const ROOT = path.resolve(__dirname, '..');

// 运行时文件白名单: 扩展加载/商店上架实际需要的全部内容 (目录以 / 结尾)
export const RUNTIME_FILES = [
  'manifest.json',
  'background.js',
  'content.js',
  'content.css',
  'popup.html',
  'popup.js',
  'options.html',
  'options.css',
  'options.js',
  'options-profile.html',
  'options-profile.js',
  'doc-translate.html',
  'doc-translate.js',
  'pay.html',
  'pay.js',
  'offscreen.html',
  'offscreen.js',
  'icons/',
  'lib/'
];

// lib/ 内排除的扩展名 (pdf.js 的 ESM 构建未被任何代码引用)
export const LIB_EXCLUDE_EXTS = ['.mjs'];

// 读取 manifest 版本号 (zip 文件名与扩展版本对齐)
export function readVersion(root = ROOT) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'), 'utf8'));
  return manifest.version;
}

// 递归收集目录下文件的相对路径
function walkFiles(dir, prefix) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    const full = path.join(dir, name);
    const rel = prefix ? prefix + '/' + name : name;
    if (fs.statSync(full).isDirectory()) {
      out.push(...walkFiles(full, rel));
    } else {
      out.push(rel);
    }
  }
  return out;
}

// 白名单复制到 staging (先清空), 返回 staging 内文件相对路径列表
export function stage(root = ROOT, staging = path.join(root, 'dist', 'staging')) {
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true });
  for (const entry of RUNTIME_FILES) {
    const src = path.join(root, entry);
    const dst = path.join(staging, entry);
    if (entry.endsWith('/')) {
      fs.cpSync(src, dst, {
        recursive: true,
        filter: (s) => !LIB_EXCLUDE_EXTS.includes(path.extname(s))
      });
    } else {
      fs.copyFileSync(src, dst);
    }
  }
  return walkFiles(staging, '').sort();
}

// staging → zip (manifest.json 等位于 zip 根: -Path "staging\*")
export function zip(staging, outZip) {
  fs.rmSync(outZip, { force: true });
  execFileSync('powershell.exe', [
    '-NoProfile', '-Command',
    `Compress-Archive -Path "${path.join(staging, '*')}" -DestinationPath "${outZip}" -CompressionLevel Optimal -Force`
  ], { stdio: 'inherit' });
  return fs.statSync(outZip).size;
}

// ===== 入口: node build/package.mjs =====
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const version = readVersion();
  const dist = path.join(ROOT, 'dist');
  const staging = path.join(dist, 'staging');
  const outZip = path.join(dist, `xiaoti-translator_v${version}.zip`);
  const files = stage(ROOT, staging);
  const size = zip(staging, outZip);
  fs.rmSync(staging, { recursive: true, force: true });
  console.log(`[package] v${version}: ${files.length} 个文件 → ${outZip} (${(size / 1024).toFixed(0)}KB)`);
}

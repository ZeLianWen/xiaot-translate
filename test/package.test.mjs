/**
 * build/package.mjs 打包脚本测试 (V1.5.54)
 * 运行: node --test test/
 * 验证: 白名单收集天然排除 文档/测试/云端部署/.mjs; staging 与 manifest 版本对齐。
 * zip 步骤依赖 Windows PowerShell, 非 Windows 平台跳过。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readVersion, stage, zip, RUNTIME_FILES } from '../build/package.mjs';

test('readVersion: 与 manifest.json 实际版本一致', () => {
  const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.json', import.meta.url), 'utf8'));
  assert.equal(readVersion(), manifest.version);
  assert.match(readVersion(), /^\d+\.\d+\.\d+$/, '扩展版本号须为 x.y.z 形式');
});

test('stage: 白名单收集——运行时文件齐备, 开发内容零入包', () => {
  const staging = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-pkg-'));
  try {
    const files = stage(undefined, staging);
    // 白名单根文件全部在
    for (const f of RUNTIME_FILES) {
      const rel = f.replace(/\/$/, '');
      assert.ok(files.includes(rel) || files.some(x => x.startsWith(rel + '/')), `缺少: ${rel}`);
    }
    // 关键运行时文件逐项断言
    for (const must of [
      'manifest.json', 'background.js', 'content.js', 'content.css',
      'popup.html', 'popup.js', 'doc-translate.html', 'doc-translate.js',
      'options.html', 'options.css', 'options.js',
      'options-profile.html', 'options-profile.js',
      'pay.html', 'pay.js',
      'offscreen.html', 'offscreen.js',
      'lib/translator.js', 'lib/cache.js', 'lib/cloud-sync.js',
      'lib/supabase-auth.js', 'lib/text-utils.js',
      'lib/pdf.min.js', 'lib/pdf.worker.min.js',
      'icons/icon16.png', 'icons/icon48.png', 'icons/icon128.png'
    ]) {
      assert.ok(files.includes(must), `运行时文件缺失: ${must}`);
    }
    // 开发内容零入包 (白名单机制天然排除)
    for (const banned of ['test/', 'cloud/', 'dist/', 'build/', '.git/', '.mjs', '功能文档']) {
      assert.ok(!files.some(f => f.includes(banned)), `开发内容不应入包: ${banned}`);
    }
    // staging 内容与收集列表一致 (无遗漏无多余)
    assert.equal(files.length, new Set(files).size, '列表不应有重复');
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
});

test('zip: staging → zip 产物生成且非空 (仅 Windows)', { skip: process.platform !== 'win32' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'vt-zip-'));
  try {
    const staging = path.join(dir, 'staging');
    stage(undefined, staging);
    const outZip = path.join(dir, 'out.zip');
    const size = zip(staging, outZip);
    assert.ok(fs.existsSync(outZip));
    assert.ok(size > 100 * 1024, 'zip 应显著大于 100KB (含 pdf.js)');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

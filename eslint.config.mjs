// ESLint 静态检查 (V1.7.23): 只查「未声明/未导入标识符」这类只有运行时才暴露的错误。
// 背景: V1.7.18 (dayKeyLocal 漏导入) 与 V1.7.22 (cloudByDay 漏声明) 两次页面空白,
// node --check 只管语法、单测只覆盖 lib 纯函数, 都需要 npm run lint 兜住。
import globals from 'globals';

const rules = {
  // 核心: 使用未声明/未导入的标识符 → 直接报错 (这正是上面两个 bug 的类型)
  'no-undef': 'error',
  // 声明了不用 → 警告 (多为改代码后的残留, 不阻断)
  'no-unused-vars': ['warn', { args: 'none', caughtErrors: 'none' }]
};

export default [
  { ignores: ['node_modules/**', 'dist/**', 'supabase/**', 'lib/*.min.js', 'lib/*.min.mjs'] },
  {
    // 扩展前端脚本 (浏览器 + chrome.* 扩展 API; pdfjsLib 由 lib/pdf.min.js UMD 挂到全局)
    files: ['*.js', 'lib/**/*.js'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.browser, ...globals.webextensions, pdfjsLib: 'readonly' }
    },
    rules
  },
  {
    // 测试与 node 侧脚本
    files: ['test/**/*.mjs', 'build/**/*.mjs', '*.mjs'],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: 'module',
      globals: { ...globals.node, ...globals.browser, ...globals.webextensions }
    },
    rules
  }
];

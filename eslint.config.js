// ESLint 禁令（计划 2.2、docs/AGENTS.md）。只放"禁令"类规则，不做风格检查。
// - packages/*/src：不用 enum / namespace，类型一律 import type。
// - packages/sim/src 与 packages/contracts/src（会被打进 sim.js 的确定性代码）：
//   Math 只许 abs/min/max/floor/ceil/trunc/round/sign/imul/fround；禁 **、Date、
//   DOM / Node / 微信 / Cocos 全局；只许相对路径导入（零依赖），类型可从 @badminton/contracts 导入；
//   热路径函数（名字以 step / cross / fnvMix / fnvHash / rngNext 开头）内禁止 new、数组/对象字面量、闭包与展开。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MATH_ALLOWED = 'abs|min|max|floor|ceil|trunc|round|sign|imul|fround';
const HOT_FN = '/^(step|cross|fnvMix|fnvHash|rngNext)/';

const hotPathSelectors = (inner, message) => [
  `FunctionDeclaration[id.name=${HOT_FN}] ${inner}`,
  `MethodDefinition[key.name=${HOT_FN}] ${inner}`,
  `VariableDeclarator[id.name=${HOT_FN}] > :function ${inner}`,
  `Property[key.name=${HOT_FN}] > :function ${inner}`,
].map((selector) => ({ selector, message }));

const deterministicSyntax = [
  {
    selector: `MemberExpression[object.name='Math'][computed=false][property.name!=/^(${MATH_ALLOWED})$/]`,
    message: `模拟核心只许 Math.${MATH_ALLOWED.split('|').join('/')}；平方根用 dsqrt，随机数用 rng.ts。`,
  },
  { selector: "MemberExpression[object.name='Math'][computed=true]", message: '禁止以计算属性访问 Math 成员。' },
  { selector: ":not(MemberExpression) > Identifier[name='Math']", message: '禁止把 Math 当作值传递或起别名。' },
  { selector: "BinaryExpression[operator='**']", message: '禁止 **（实现相关的 pow）；用连乘。' },
  { selector: "AssignmentExpression[operator='**=']", message: '禁止 **=（实现相关的 pow）；用连乘。' },
  { selector: 'TSEnumDeclaration', message: '不用 enum：用 const 常量。' },
  { selector: 'TSModuleDeclaration[kind!="global"]', message: '不用 namespace / module 声明。' },
  ...hotPathSelectors('NewExpression', '热路径函数内禁止 new（零分配）。'),
  ...hotPathSelectors('ArrayExpression', '热路径函数内禁止数组字面量（零分配）。'),
  ...hotPathSelectors('ObjectExpression', '热路径函数内禁止对象字面量（零分配）。'),
  ...hotPathSelectors(':function', '热路径函数内禁止闭包（零分配）。'),
  ...hotPathSelectors('SpreadElement', '热路径函数内禁止展开（零分配）。'),
];

const bannedGlobals = [
  'Date',
  'performance',
  'window',
  'document',
  'navigator',
  'self',
  'global',
  'globalThis',
  'GameGlobal',
  'wx',
  'cc',
  'process',
  'require',
  'module',
  'exports',
  'Buffer',
  'setTimeout',
  'setInterval',
  'setImmediate',
  'requestAnimationFrame',
  'queueMicrotask',
  'console',
  'eval',
  'Function',
  'crypto',
].map((name) => ({ name, message: `模拟核心不得使用 ${name}（确定性与零依赖：不引用 cc / wx / DOM / Node）。` }));

export default tseslint.config(
  {
    ignores: [
      '**/node_modules/**',
      '**/dist/**',
      '.tsbuild/**',
      '.worktrees/**',
      'client/**',
      'tools/wx-selftest/sim.js',
      'docs/spike/**',
    ],
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    ...js.configs.recommended,
    languageOptions: { ecmaVersion: 2022, sourceType: 'module' },
  },
  {
    files: ['**/*.ts'],
    languageOptions: { parser: tseslint.parser, ecmaVersion: 2022, sourceType: 'module' },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: {},
  },
  {
    files: ['packages/*/src/**/*.ts'],
    rules: {
      '@typescript-eslint/consistent-type-imports': ['error', { prefer: 'type-imports', fixStyle: 'inline-type-imports' }],
      'no-restricted-syntax': [
        'error',
        { selector: 'TSEnumDeclaration', message: '不用 enum：用 const 常量。' },
        { selector: 'TSModuleDeclaration[kind!="global"]', message: '不用 namespace / module 声明。' },
      ],
    },
  },
  {
    files: ['packages/sim/src/**/*.ts', 'packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...deterministicSyntax],
      'no-restricted-globals': ['error', ...bannedGlobals],
      '@typescript-eslint/no-restricted-imports': [
        'error',
        {
          patterns: [
            {
              regex: '^(?!\\.{1,2}/)(?!@badminton/contracts$)',
              message: '模拟核心零依赖：只许相对路径导入（不引用 cc / wx / DOM / Node 内置模块）。',
            },
            {
              regex: '^@badminton/contracts$',
              allowTypeImports: true,
              message: '从 @badminton/contracts 只许 import type。',
            },
          ],
        },
      ],
    },
  },
  {
    // 唯一的例外：入口文件要把 API 挂到 GameGlobal / globalThis 上（计划 2.2）。
    files: ['packages/sim/src/index.ts'],
    rules: {
      'no-restricted-globals': ['error', ...bannedGlobals.filter((g) => g.name !== 'GameGlobal' && g.name !== 'globalThis')],
    },
  },
);

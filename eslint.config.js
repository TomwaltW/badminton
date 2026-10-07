// ESLint 禁令（计划 2.2、docs/AGENTS.md）。只放"禁令"类规则，不做风格检查。
// - packages/*/src：不用 enum / namespace，类型导入带 type 修饰，导入不写 .ts 扩展名。
// - packages/sim/src 与 packages/contracts/src（会被打进 sim.js 的确定性代码）：
//   Math 只许 abs/min/max/floor/ceil/trunc/round/sign/imul/fround；禁 **、Date、
//   DOM / Node / 微信 / Cocos 全局；禁名为 Math / Date 的成员访问（不论对象，挡住全局对象的别名）与
//   对全局对象的计算属性访问；只许静态的相对路径导入（零依赖、不用动态 import()），且只许留在本包内或指向 packages/contracts/src
//   （契约用 ../../contracts/src/<模块>，不用包名 @badminton/contracts）；
//   热路径函数（名字以 step / cross / fnvMix / fnvHash / rngNext 开头的函数声明、变量、对象方法、类方法、类字段）
//   内禁止 new、数组/对象字面量、闭包与展开。
// flat config 里同名规则后面的块整体覆盖前面的块：下面的 no-restricted-syntax、@typescript-eslint/no-restricted-imports
// 在模拟核心那一块里要把通用块的条目一并带上；index.ts 那一块只覆盖 no-restricted-globals，语法与导入禁令照样继承。
import js from '@eslint/js';
import tseslint from 'typescript-eslint';

const MATH_ALLOWED = 'abs|min|max|floor|ceil|trunc|round|sign|imul|fround';
const HOT_FN = '/^(step|cross|fnvMix|fnvHash|rngNext)/';
const GLOBAL_OBJECTS = 'globalThis|GameGlobal|self|window|global';

// 都从"热路径函数"往下找后代。类方法的值本身就是 FunctionExpression，必须写成 MethodDefinition > FunctionExpression
// 再找后代，否则 ':function' 会命中方法自己（step(){} 被当成闭包误报）。
const hotPathSelectors = (inner, message) => [
  `FunctionDeclaration[id.name=${HOT_FN}] ${inner}`,
  `MethodDefinition[key.name=${HOT_FN}] > FunctionExpression ${inner}`,
  `PropertyDefinition[key.name=${HOT_FN}] > :function ${inner}`,
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
  // 全局对象可以被起别名或包进条件表达式（root.Math.sin、(c ? GameGlobal : globalThis).Date），对象一侧无法静态判断，
  // 所以只看成员名：模拟核心里不应有名为 Math / Date 的成员访问，不论对象是什么（与 sim:scan 一致）。
  {
    selector: 'MemberExpression[property.name=/^(Math|Date)$/]',
    message: '模拟核心里不应有名为 Math / Date 的成员访问（x.Math、x?.Date，不论 x 是什么）：x 可能是全局对象的别名。',
  },
  {
    selector: 'MemberExpression[computed=true][property.value=/^(Math|Date)$/]',
    message: "模拟核心里不应有名为 Math / Date 的成员访问（x['Math']，不论 x 是什么）：x 可能是全局对象的别名。",
  },
  {
    selector: "MemberExpression[computed=true][property.type='TemplateLiteral'][property.quasis.0.value.cooked=/^(Math|Date)$/]",
    message: '模拟核心里不应有名为 Math / Date 的成员访问（x[`Math`]，不论 x 是什么）：x 可能是全局对象的别名。',
  },
  {
    // import D = globalThis.Date：tsc 接受，esbuild 编成 var D = globalThis.Date
    selector: 'TSImportEqualsDeclaration TSQualifiedName[right.name=/^(Math|Date)$/]',
    message: '模拟核心里不应有名为 Math / Date 的成员访问（import D = x.Date，不论 x 是什么）：x 可能是全局对象的别名。',
  },
  {
    selector: 'ObjectPattern > Property[key.name=/^(Math|Date)$/], ObjectPattern > Property[key.value=/^(Math|Date)$/]',
    message: '模拟核心里不应从任何对象解构出 Math / Date（const { Date: D } = x）：x 可能是全局对象的别名。',
  },
  {
    selector: `MemberExpression[computed=true][object.name=/^(${GLOBAL_OBJECTS})$/]`,
    message: '禁止以计算属性访问全局对象（globalThis[k] 等）：成员名无法静态检查。',
  },
  {
    // no-restricted-imports 只看静态导入：import('typescript') 能过 tsc，esbuild 照样打进 sim.js
    selector: 'ImportExpression',
    message: '模拟核心不用动态 import()：只许静态的相对路径导入（导入范围检查只看静态导入）。',
  },
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

// 导入不写 .ts 扩展名（含 import type、export … from）。
const TS_EXT_IMPORT = { regex: '\\.ts$', message: '导入不写 .ts 扩展名（Cocos 与 esbuild 产物要求）。' };

// 模拟核心的导入范围（同一条规则也禁止 contracts/src 导入 sim）：
// - 只许相对路径（包名一律不许，含 @badminton/contracts 的 import type：工作区未链接，tsc 与 sim.d.ts 都解析不了）；
// - 向上越过两级及以上时，去掉开头所有 ../ 之后必须以 contracts/src/ 开头（(?!\.\./) 防止回溯少吃一个 ../）；
// - 不许非规范的相对路径（./../、a/../、/./、空段 //、以 . 或 .. 结尾）：它们能绕过上一条只看开头的判断
//   （esbuild 与 tsc 都把 // 当作 /：.//../../../tools/x、..//..//..//tools/x 实际指向 tools/x）。
const simImportPatterns = [
  {
    regex: '^(?!\\.{1,2}/)',
    message:
      '模拟核心零依赖：只许相对路径导入（不引用 cc / wx / DOM / Node 内置模块与 npm 包）；契约请用相对路径 ../../contracts/src/<模块>，不用包名 @badminton/contracts。',
  },
  {
    regex: '^(\\.\\./){2,}(?!\\.\\./)(?!contracts/src/)',
    message: '模拟核心的相对导入只许留在本包内，或指向 packages/contracts/src（../../contracts/src/<模块>）；contracts 不得导入 sim。',
  },
  {
    regex: '(^|/)\\.\\.?$|//|(^|/)([^/]*[^./][^/]*|\\.|\\.{3,})/\\.\\.?(/|$)',
    message: '相对路径写成规范形式（不写 ./../、a/../、/./、//，不以 . 或 .. 结尾）：非规范路径会绕过导入范围检查。',
  },
  TS_EXT_IMPORT,
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
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: [TS_EXT_IMPORT] }],
    },
  },
  {
    files: ['packages/sim/src/**/*.ts', 'packages/contracts/src/**/*.ts'],
    rules: {
      'no-restricted-syntax': ['error', ...deterministicSyntax],
      'no-restricted-globals': ['error', ...bannedGlobals],
      // 整体覆盖通用块的同名规则，所以 simImportPatterns 里带着 TS_EXT_IMPORT。
      '@typescript-eslint/no-restricted-imports': ['error', { patterns: simImportPatterns }],
    },
  },
  {
    // 唯一的例外：入口文件要把 API 挂到 GameGlobal / globalThis 上（计划 2.2）。只覆盖 no-restricted-globals，
    // 上一块的 no-restricted-syntax（含 Math / Date 成员名与全局对象计算属性禁令）与导入禁令照样生效。
    files: ['packages/sim/src/index.ts'],
    rules: {
      'no-restricted-globals': ['error', ...bannedGlobals.filter((g) => g.name !== 'GameGlobal' && g.name !== 'globalThis')],
    },
  },
);

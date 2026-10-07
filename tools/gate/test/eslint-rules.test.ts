/**
 * eslint.config.js 禁令的直接测试（docs/AGENTS.md §2–§4）：用 ESLint Node API 对虚拟路径 lintText，
 * 不落盘、不依赖 git，也不依赖仓库里真实源码的内容。每条禁令都有"报错"与"通过"两面：
 * - 模拟核心（packages/sim/src、packages/contracts/src）：Math 白名单、**、Date、console、导入范围
 *   （只许静态的相对路径，不用动态 import()；契约用 ../../contracts/src/<模块>；不越界；路径规范（含不写 //）；
 *   不写 .ts 扩展名）、名为 Math / Date 的成员访问、
 *   对全局对象的计算属性访问；
 * - 热路径零分配：类方法 step(){} 本身不算闭包，类字段 stepX = () => … 里的分配要报；
 * - index.ts 例外：只放开 globalThis / GameGlobal 这两个全局名，语法禁令照样继承；
 * - packages/*\/src 通用：不写 .ts 扩展名、不用 enum。
 */
import { describe, expect, test } from 'bun:test';
import { resolve } from 'node:path';
import { ESLint } from 'eslint';

const ROOT = resolve(import.meta.dir, '..', '..', '..');
const eslint = new ESLint({ cwd: ROOT });

const SIM = 'packages/sim/src/zz-probe.ts';
const SIM_SUB = 'packages/sim/src/sub/zz-probe.ts';
const CONTRACTS = 'packages/contracts/src/zz-probe.ts';
const INDEX = 'packages/sim/src/index.ts';
const OTHER_PKG = 'packages/protocol/src/zz-probe.ts';

interface Msg {
  rule: string | null;
  line: number;
  message: string;
}

/** 对虚拟路径 lintText，返回全部消息（含解析错误；虚拟路径不会被忽略）。 */
async function lint(code: string, file: string): Promise<Msg[]> {
  const [r] = await eslint.lintText(code, { filePath: resolve(ROOT, file) });
  return r!.messages.map((m) => ({ rule: m.ruleId, line: m.line, message: m.message }));
}

/** 只取规则 id（按 ESLint 报告的顺序；解析错误的 id 是 null）。 */
async function ruleIds(code: string, file: string): Promise<(string | null)[]> {
  return (await lint(code, file)).map((m) => m.rule);
}

const SYNTAX = 'no-restricted-syntax';
const GLOBALS = 'no-restricted-globals';
const IMPORTS = '@typescript-eslint/no-restricted-imports';

describe('模拟核心：数学与时钟', () => {
  test('Math.sin / Math.sqrt / Math.random、** 报错；Math.floor / Math.imul 通过', async () => {
    expect(await ruleIds('export const a = Math.sin(1);\n', SIM)).toEqual([SYNTAX]);
    expect(await ruleIds('export const a = Math.sqrt(2);\n', SIM)).toEqual([SYNTAX]);
    expect(await ruleIds('export const a = Math.random();\n', SIM)).toEqual([SYNTAX]);
    expect(await ruleIds('export const a = 2 ** 3;\n', SIM)).toEqual([SYNTAX]);
    expect(await ruleIds('export const a = Math.floor(1.5) + Math.imul(3, 5);\n', SIM)).toEqual([]);
  });

  test('Date、console 报错（no-restricted-globals）', async () => {
    expect(await ruleIds('export const t = Date.now();\n', SIM)).toEqual([GLOBALS]);
    expect(await ruleIds('console.log(1);\n', SIM)).toEqual([GLOBALS]);
  });

  test('contracts/src 同样受这些禁令约束', async () => {
    expect(await ruleIds('export const a = Math.cos(1);\n', CONTRACTS)).toEqual([SYNTAX]);
    expect(await ruleIds('export const t = Date.now();\n', CONTRACTS)).toEqual([GLOBALS]);
  });

  test('名为 Math / Date 的成员访问不论对象是什么都报（别名、条件表达式、可选链、字符串下标、模板下标）', async () => {
    for (const code of [
      'declare const root: typeof globalThis;\nexport const a = root.Math.sin(1);\n',
      'declare const root: typeof globalThis;\nexport const a = root.Date.now();\n',
      'declare const o: any;\nexport const a = o?.Date;\n',
      "declare const o: any;\nexport const a = o['Math'].floor(1);\n",
      'declare const o: any;\nexport const a = o[`Date`];\n',
      'declare const o: any;\nexport const a = o.Math.imul(1, 2);\n',
    ]) {
      const ids = await ruleIds(code, SIM);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => id === SYNTAX)).toBe(true);
    }
    const [m] = await lint('declare const root: any;\nexport const a = root.Math;\n', SIM);
    expect(m?.message).toContain('名为 Math / Date 的成员访问');
  });

  test('从任意对象解构出 Math / Date 报错；对象字面量里的 Date 键、类方法名不报', async () => {
    expect(await ruleIds('declare const root: any;\nexport const { Date: D } = root;\n', SIM)).toEqual([SYNTAX]);
    expect(await ruleIds("declare const root: any;\nexport const { 'Date': D } = root;\n", SIM)).toEqual([SYNTAX]);
    expect(await ruleIds('declare const root: any;\nlet D: unknown;\n({ Date: D } = root);\nexport { D };\n', SIM)).toEqual([
      SYNTAX,
    ]);
    expect(await ruleIds('export const o = { Date: 1 };\nexport class C { Date(): number { return 1; } }\n', SIM)).toEqual([]);
  });
});

describe('模拟核心：导入范围', () => {
  test('Node 内置模块、npm 包、包名 @badminton/contracts（含 import type）都报', async () => {
    expect(await ruleIds("import { readFileSync } from 'node:fs';\nexport const f = readFileSync;\n", SIM)).toEqual([IMPORTS]);
    expect(await ruleIds("import { readFileSync } from 'fs';\nexport const f = readFileSync;\n", SIM)).toEqual([IMPORTS]);
    expect(await ruleIds("import { Vec3 } from 'cc';\nexport const v = Vec3;\n", SIM)).toEqual([IMPORTS]);
    const typeOnly = await lint("import type { MatchCfg } from '@badminton/contracts';\nexport type M = MatchCfg;\n", SIM);
    expect(typeOnly.map((m) => m.rule)).toEqual([IMPORTS]);
    expect(typeOnly[0]!.message).toContain('../../contracts/src/');
    expect(await ruleIds("import { INPUT_KIND } from '@badminton/contracts';\nexport const k = INPUT_KIND;\n", SIM)).toEqual([
      IMPORTS,
    ]);
  });

  test('../../contracts/src/<模块> 的类型与运行时导入、本包内的相对导入都通过', async () => {
    const code = [
      "import type { MatchCfg } from '../../contracts/src/api';",
      "import { INPUT_KIND } from '../../contracts/src/api';",
      "import { SNAPSHOT_SCHEMA_VER } from '../../contracts/src/snapshot.schema';",
      "import { dsqrt } from './math';",
      "export type { InputEvent } from '../../contracts/src/api';",
      'export const k: MatchCfg | number = INPUT_KIND.press + SNAPSHOT_SCHEMA_VER + dsqrt(1);',
      '',
    ].join('\n');
    expect(await lint(code, SIM)).toEqual([]);
    // 子目录里多一级 ../ 也一样（去掉所有 ../ 之后以 contracts/src/ 开头）
    expect(await lint("import { dsqrt } from '../math';\nimport type { MatchCfg } from '../../../contracts/src/api';\nexport type M = MatchCfg;\nexport const d = dsqrt;\n", SIM_SUB)).toEqual([]);
    // contracts 内部互相导入
    expect(await lint("import type { MatchCfg } from './match-cfg';\nexport type M = MatchCfg;\n", CONTRACTS)).toEqual([]);
  });

  test('越界的相对导入报错：sim → tools、contracts → sim、非规范的 ./../', async () => {
    expect(await ruleIds("import { x } from '../../../tools/x';\nexport const y = x;\n", SIM)).toEqual([IMPORTS]);
    expect(await ruleIds("import { x } from '../../client/assets/x';\nexport const y = x;\n", SIM)).toEqual([IMPORTS]);
    expect(await ruleIds("import { api } from '../../sim/src/api';\nexport const y = api;\n", CONTRACTS)).toEqual([IMPORTS]);
    expect(await ruleIds("import type { BadmintonSimApi } from '../../sim/src/api';\nexport type Y = BadmintonSimApi;\n", CONTRACTS)).toEqual([
      IMPORTS,
    ]);
    // 非规范路径（./../、中途的 ../、/./、空段 //）能绕过"开头连续 ../"的判断，一律报；
    // esbuild 与 tsc 都把 // 当作 /，.//../../../tools/x 实际指向 tools/x
    for (const spec of [
      './../../../tools/x',
      '../../contracts/src/../../../tools/x',
      '.././../../tools/x',
      './a/./b',
      './/../../../tools/x',
      '..//..//..//tools/x',
      '..//../contracts/src/api',
      '../../contracts/src//../../../tools/x',
    ]) {
      const ids = await ruleIds(`import { x } from '${spec}';\nexport const y = x;\n`, SIM);
      expect(ids.length).toBeGreaterThan(0);
      expect(ids.every((id) => id === IMPORTS)).toBe(true);
    }
  });

  test('动态 import() 报错（导入范围检查只看静态导入；import(\'typescript\') 能过 tsc 并被 esbuild 打进 sim.js）', async () => {
    for (const spec of ['typescript', './math', '../../contracts/src/api']) {
      const msgs = await lint(`export async function f(): Promise<unknown> {\n  return import('${spec}');\n}\n`, SIM);
      expect(msgs.map((m) => m.rule)).toEqual([SYNTAX]);
      expect(msgs[0]!.message).toContain('import()');
    }
    expect(await ruleIds("export async function f(): Promise<unknown> {\n  return import('./a');\n}\n", CONTRACTS)).toEqual([SYNTAX]);
  });

  test('.ts 扩展名报错（含 import type 与 export … from）', async () => {
    for (const code of [
      "import { dsqrt } from './math.ts';\nexport const d = dsqrt;\n",
      "import type { SqrtFn } from './math.ts';\nexport type F = SqrtFn;\n",
      "export { dsqrt } from './math.ts';\n",
      "export * from './math.ts';\n",
      "import type { MatchCfg } from '../../contracts/src/api.ts';\nexport type M = MatchCfg;\n",
    ]) {
      const msgs = await lint(code, SIM);
      expect(msgs.map((m) => m.rule)).toEqual([IMPORTS]);
      expect(msgs[0]!.message).toContain('.ts 扩展名');
    }
  });
});

describe('热路径零分配', () => {
  test('类方法 step(){ this.t = 1 } 通过（方法本身不是闭包）', async () => {
    const code = 'export class K {\n  t = 0;\n  step(): void {\n    this.t = 1;\n  }\n  crossX(a: number): number {\n    return a + this.t;\n  }\n}\n';
    expect(await lint(code, SIM)).toEqual([]);
  });

  test('类方法 step 内 new / 数组字面量 / 对象字面量 / 闭包 / 展开都报', async () => {
    const cases: [string, string][] = [
      ['new Int32Array(1)', 'new'],
      ['[1, 2]', '数组字面量'],
      ['{ a: 1 }', '对象字面量'],
      ['() => 1', '闭包'],
      ['[...xs]', '展开'],
    ];
    for (const [expr, word] of cases) {
      const code = `declare const xs: number[];\nexport class K {\n  step(): unknown {\n    return ${expr};\n  }\n}\n`;
      const msgs = await lint(code, SIM);
      expect(msgs.length).toBeGreaterThan(0);
      expect(msgs.every((m) => m.rule === SYNTAX)).toBe(true);
      expect(msgs.some((m) => m.message.includes(word))).toBe(true);
    }
  });

  test('非热路径的类方法不受限', async () => {
    expect(await lint('export class K {\n  init(): Int32Array {\n    return new Int32Array([1]);\n  }\n}\n', SIM)).toEqual([]);
  });

  test('类字段 stepX = () => new X() 报错（含私有字段）；不分配的类字段箭头通过', async () => {
    const bad = await lint('export class K {\n  stepX = (): Int32Array => new Int32Array(1);\n}\n', SIM);
    expect(bad.map((m) => m.rule)).toEqual([SYNTAX]);
    expect(bad[0]!.message).toContain('new');
    expect(await ruleIds('export class K {\n  #stepY = (): number[] => [1];\n  get y(): number[] {\n    return this.#stepY();\n  }\n}\n', SIM)).toEqual([
      SYNTAX,
    ]);
    expect(await lint('export class K {\n  t = 0;\n  stepZ = (): number => this.t + 1;\n}\n', SIM)).toEqual([]);
  });

  test('对象字面量方法与函数声明保持原有行为', async () => {
    expect(await lint('export const o = {\n  step(): number {\n    return 1;\n  },\n};\n', SIM)).toEqual([]);
    expect(await ruleIds('export const o = {\n  step(): Int32Array {\n    return new Int32Array(1);\n  },\n};\n', SIM)).toEqual([SYNTAX]);
    expect(await ruleIds('export const o = {\n  stepA: function (): () => number {\n    return () => 1;\n  },\n};\n', SIM)).toEqual([SYNTAX]);
    expect(await lint('export function stepB(a: number): number {\n  return a + 1;\n}\n', SIM)).toEqual([]);
    expect(await ruleIds('export function stepB(): number[] {\n  return [1];\n}\n', SIM)).toEqual([SYNTAX]);
  });
});

describe('index.ts 例外：只放开 globalThis / GameGlobal 两个全局名', () => {
  const HEAD = [
    "import { api, type BadmintonSimApi } from './api';",
    'declare global {',
    '  var BadmintonSim: BadmintonSimApi;',
    '}',
    'declare const GameGlobal: typeof globalThis;',
    '',
  ].join('\n');
  const ASSIGN = "(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api;\n";

  test('入口那句全局赋值不报', async () => {
    expect(await lint(HEAD + ASSIGN, INDEX)).toEqual([]);
  });

  test('经由别名或条件表达式取 Math / Date 报错', async () => {
    const alias = `${HEAD}const root = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis;\nroot.Math.sin(root.Date.now());\n${ASSIGN}`;
    const msgs = await lint(alias, INDEX);
    expect(msgs.map((m) => [m.line, m.rule])).toEqual([
      [7, SYNTAX],
      [7, SYNTAX],
    ]);
    const cond = `${HEAD}(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).Math.log(2);\n${ASSIGN}`;
    expect(await ruleIds(cond, INDEX)).toEqual([SYNTAX]);
    // import D = globalThis.Date：tsc 接受，esbuild 编成 var D = globalThis.Date
    expect(await ruleIds(`${HEAD}import D = globalThis.Date;\nexport const t = D.now();\n${ASSIGN}`, INDEX)).toEqual([SYNTAX]);
    // Math 那一句另有"Math 当作值"的老禁令一起命中
    expect(await ruleIds(`${HEAD}import M = globalThis.Math;\nexport const s = M.sin(1);\n${ASSIGN}`, INDEX)).toEqual([
      SYNTAX,
      SYNTAX,
    ]);
  });

  test('对全局对象的计算属性访问报错；其他全局（Date、console）照样禁', async () => {
    expect(await ruleIds(`${HEAD}declare const k: string;\nexport const v = globalThis[k as keyof typeof globalThis];\n${ASSIGN}`, INDEX)).toEqual([
      SYNTAX,
    ]);
    expect(await ruleIds(`${HEAD}export const t = Date.now();\n${ASSIGN}`, INDEX)).toEqual([GLOBALS]);
    expect(await ruleIds(`${HEAD}console.log(1);\n${ASSIGN}`, INDEX)).toEqual([GLOBALS]);
  });

  test('index.ts 以外的文件不许出现 globalThis / GameGlobal', async () => {
    expect(await ruleIds('export const g = globalThis;\n', SIM)).toEqual([GLOBALS]);
    expect(await ruleIds('export const g = typeof GameGlobal;\n', SIM)).toEqual([GLOBALS]);
  });
});

describe('packages/*/src 通用禁令', () => {
  test('不写 .ts 扩展名（含 import type）、不用 enum', async () => {
    expect(await ruleIds("import { a } from './a.ts';\nexport const b = a;\n", OTHER_PKG)).toEqual([IMPORTS]);
    expect(await ruleIds("import type { A } from './a.ts';\nexport type B = A;\n", OTHER_PKG)).toEqual([IMPORTS]);
    expect(await ruleIds('export enum E {\n  A,\n}\n', OTHER_PKG)).toEqual([SYNTAX]);
  });

  test('模拟核心以外的包不受零依赖与 Math 禁令约束', async () => {
    expect(await lint("import { a } from './a';\nimport { b } from 'some-lib';\nexport const c = a + b + Math.sin(1);\n", OTHER_PKG)).toEqual([]);
  });
});

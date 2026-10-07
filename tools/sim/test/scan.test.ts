/**
 * sim:scan 的测试：每条规则一个正例一个反例；注释、字符串、模板字符串不误报；允许清单全部放行；
 * 名为 Math / Date 的成员访问不论对象一律报（全局对象的别名、条件 / 逻辑 / 逗号表达式绕不过去）；
 * 对全局对象的非字面量计算属性访问报 global-computed；
 * TS 与 JS 都测；真实构建的 sim.js 扫描 0 违规；scanStaged 扫的是 git 索引而不是工作树（含 contracts/src）；
 * 超深语法树不爆栈；CLI 的输出与退出码。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSim } from '../build';
import {
  MATH_ALLOWED,
  formatViolation,
  runCli,
  scanFiles,
  scanSource,
  scanStaged,
  type CliOptions,
  type Violation,
} from '../scan';

const FIXTURES = resolve(import.meta.dir, 'fixtures');

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `sim-scan-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 规则 id 列表（按出现顺序）。 */
function rules(code: string, file: string): string[] {
  return scanSource(code, file).map((v) => v.rule);
}

/** 同一段代码分别当 TS 与 JS 扫，两边结果必须相同。 */
function rulesBoth(code: string): string[] {
  const asTs = rules(code, 'case.ts');
  const asJs = rules(code, 'case.js');
  expect(asJs).toEqual(asTs);
  return asTs;
}

describe('math-member', () => {
  test('正例：不在允许清单里的 Math 成员', () => {
    expect(rulesBoth('const y = Math.sin(1);')).toEqual(['math-member']);
    expect(rulesBoth('const y = Math.PI;')).toEqual(['math-member']);
    expect(rulesBoth('const y = Math?.cos(1);')).toEqual(['math-member']);
    expect(rulesBoth('const y = (Math).exp(1);')).toEqual(['math-member']);
    expect(rulesBoth('const y = Math.clz32(1) + Math.hypot(3, 4);')).toEqual(['math-member', 'math-member']);
  });

  test('Math.random、Math.sqrt、Math.pow 有专门说明', () => {
    const [random] = scanSource('Math.random();', 'a.js');
    const [sqrt] = scanSource('Math.sqrt(2);', 'a.js');
    const [pow] = scanSource('Math.pow(2, 3);', 'a.js');
    expect(random?.rule).toBe('math-member');
    expect(random?.message).toContain('rng');
    expect(sqrt?.rule).toBe('math-member');
    expect(sqrt?.message).toContain('dsqrt');
    expect(pow?.message).toContain('连乘');
  });

  test('经由全局对象访问 Math 同样拒绝', () => {
    expect(rulesBoth('globalThis.Math.sin(1);')).toEqual(['math-member']);
    expect(rulesBoth('self.Math.sin(1);')).toEqual(['math-member']);
    expect(rulesBoth("window['Math'].tan(1);")).toEqual(['math-member']);
    expect(rulesBoth('GameGlobal.Math.log(1);')).toEqual(['math-member']);
    expect(rulesBoth('global.Math.random();')).toEqual(['math-member']);
    expect(rulesBoth('globalThis.self.Math.atan2(1, 2);')).toEqual(['math-member']);
  });

  test('TS 外壳（as、!、<T>、satisfies）不能绕过', () => {
    expect(rules('(Math as any).sin(1);', 'a.ts')).toEqual(['math-member']);
    expect(rules('Math!.sin(1);', 'a.ts')).toEqual(['math-member']);
    expect(rules('(<any>Math).sin(1);', 'a.ts')).toEqual(['math-member']);
    expect(rules('(Math satisfies object as any).sin(1);', 'a.ts')).toEqual(['math-member']);
  });

  test('反例：允许清单全部放行', () => {
    const code = [...MATH_ALLOWED].map((n, i) => `const v${i} = Math.${n}(1, 2);`).join('\n');
    expect(MATH_ALLOWED.size).toBe(10);
    expect(rulesBoth(code)).toEqual([]);
    expect(rulesBoth('const m = Math.max.apply(null, [1, 2]);')).toEqual([]);
  });

  test('反例：别的对象上的同名函数（obj.sin）不报', () => {
    expect(rulesBoth('const y = obj.sin(1) + obj.math.sin(2) + x.y.sqrt(3);')).toEqual([]);
  });

  test('正例：脚本顶层的 this（含顶层箭头函数里的 this）就是全局对象', () => {
    expect(rulesBoth('this.Math.sin(1);')).toEqual(['math-member']);
    expect(rulesBoth("const m = this['Math'];")).toEqual(['math-value']);
    expect(rulesBoth('const f = () => this.Date.now();')).toEqual(['date']);
    expect(rulesBoth('const { Date: D } = this;')).toEqual(['date']);
    expect(rulesBoth('class A extends this.Date {}')).toEqual(['date']);
    // 计算属性名在外层求值，this 仍是顶层的
    expect(rulesBoth('const o = { [this.Math]: 1 };')).toEqual(['math-value']);
  });

  test('反例：函数、方法、类字段、静态块里的 this 不当作全局对象（this[k] 不报 global-computed）', () => {
    const code = [
      'function f(a = this[k]) { return this[k](1); }',
      'const o = { m() { return this[k]; } };',
      'class K { x = this[k]; static s = this[k]; static { this[k](1); } m() { return () => this[k]; } }',
    ].join('\n');
    expect(rulesBoth(code)).toEqual([]);
    // 对照：同样的写法放在脚本顶层就是全局对象的计算属性访问
    expect(rulesBoth('const v = this[k]; const f = () => this[k];')).toEqual(['global-computed', 'global-computed']);
  });
});

describe('名为 Math / Date 的成员访问：不论对象是什么一律报', () => {
  test('正例：全局对象包在条件 / 逻辑 / 逗号表达式里、或先起别名', () => {
    expect(rulesBoth("(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).Math.log(2);")).toEqual(['math-member']);
    expect(
      rulesBoth("const root = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis; root.Math.sin(root.Date.now());"),
    ).toEqual(['math-member', 'date']);
    expect(rulesBoth('(GameGlobal || globalThis).Date.now();')).toEqual(['date']);
    expect(rulesBoth('(GameGlobal ?? globalThis).Math.random();')).toEqual(['math-member']);
    expect(rulesBoth('(0, globalThis).Math.cos(1);')).toEqual(['math-member']);
    expect(rules('(root as typeof globalThis).Math.exp(1);', 'a.ts')).toEqual(['math-member']);
  });

  test('正例：任意对象上的 .Math / [\'Math\'] / ?.Date / [`Date`]，允许清单里的成员也报', () => {
    expect(rulesBoth('const y = obj.Math.sin(2) + x.y.Math.sin(3);')).toEqual(['math-member', 'math-member']);
    expect(rulesBoth('const y = obj.Math.floor(2);')).toEqual(['math-value']);
    expect(rulesBoth('const g = globalThis.Math.imul(3, 5);')).toEqual(['math-value']);
    expect(rulesBoth("const m = obj['Math'];")).toEqual(['math-value']);
    expect(rulesBoth('const m = obj?.Math;')).toEqual(['math-value']);
    expect(rulesBoth('const d = obj?.Date;')).toEqual(['date']);
    expect(rulesBoth('const d = obj[`Date`].now();')).toEqual(['date']);
    expect(rulesBoth('function f() { return this.Math.sin(1) + this.Date.now(); }')).toEqual(['math-member', 'date']);
  });

  test('说明里写明"不应有名为 Math / Date 的成员访问"', () => {
    const [m] = scanSource('const y = obj.Math.floor(2);', 'a.js');
    const [d] = scanSource('const t = root.Date.now();', 'a.js');
    expect(m?.message).toContain('不应有名为 Math 的成员访问');
    expect(d?.message).toContain('不应有名为 Date 的成员访问');
  });

  test('正例：从任意对象解构出 Date（Math 本来就报）', () => {
    expect(rulesBoth('const { Date: D } = root;')).toEqual(['date']);
    expect(rulesBoth("const { 'Date': D } = cond ? self : globalThis;")).toEqual(['date']);
    expect(rulesBoth('let D; ({ Date: D } = root);')).toEqual(['date']);
  });

  test('反例：对象字面量键、类成员声明、方法名不是成员访问', () => {
    expect(rulesBoth('const o = { Math: 1, Date: 2 }; class C { Math = 1; Date() { return 1; } }')).toEqual([]);
  });

  test('正例：import D = ns.Date（esbuild 编成 var D = ns.Date）；import type 不报', () => {
    expect(rules('import D = ns.Date;', 'a.ts')).toEqual(['date']);
    expect(rules('import M = ns.Math;', 'a.ts')).toEqual(['math-value']);
    expect(rules('import type D = ns.Date;', 'a.ts')).toEqual([]);
  });
});

describe('global-computed：对全局对象做非字面量的计算属性访问', () => {
  test('正例：globalThis[k]、条件 / 逻辑 / 逗号表达式包着的全局对象、拼接出来的名字、计算键解构', () => {
    expect(rulesBoth('const v = globalThis[k];')).toEqual(['global-computed']);
    expect(rulesBoth("const v = (typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis)[k];")).toEqual(['global-computed']);
    expect(rulesBoth("const v = (GameGlobal || globalThis)['Ma' + 'th'].sin(1);")).toEqual(['global-computed']);
    expect(rulesBoth('const v = (0, self)[k];')).toEqual(['global-computed']);
    expect(rulesBoth('const v = (cond ? window : x)[k];')).toEqual(['global-computed']);
    expect(rulesBoth('const { [k]: v } = globalThis;')).toEqual(['global-computed']);
  });

  test('反例：字面量下标、普通对象的计算属性、入口的全局赋值', () => {
    expect(rulesBoth("globalThis['BadmintonSim'] = api; const v = arr[i] + obj[k] + (a || b)[k];")).toEqual([]);
    expect(rulesBoth("(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api;")).toEqual([]);
    expect(rulesBoth('const { [k]: v } = obj;')).toEqual([]);
  });

  test('说明', () => {
    expect(scanSource('globalThis[k];', 'a.js')[0]?.message).toContain('全局对象');
  });
});

describe('math-computed', () => {
  test('正例：Math[...]（字面量与变量）', () => {
    expect(rulesBoth("Math['sin'](1);")).toEqual(['math-computed']);
    expect(rulesBoth("Math['abs'](1);")).toEqual(['math-computed']);
    expect(rulesBoth('Math[name](1);')).toEqual(['math-computed']);
    expect(rulesBoth('globalThis.Math[name](1);')).toEqual(['math-computed']);
    expect(scanSource("Math['sin'](1);", 'a.js')[0]?.message).toContain("Math['sin']");
  });

  test('反例：用 Math 的结果做下标不算', () => {
    expect(rulesBoth('const v = arr[Math.floor(i)] + obj["sin"];')).toEqual([]);
  });
});

describe('math-value', () => {
  test('正例：起别名、传参、解构、typeof', () => {
    expect(rulesBoth('const M = Math;')).toEqual(['math-value']);
    expect(rulesBoth('f(Math);')).toEqual(['math-value']);
    expect(rulesBoth('const { sin } = Math;')).toEqual(['math-value']);
    expect(rulesBoth('const o = { Math };')).toEqual(['math-value']);
    expect(rulesBoth('const t = typeof Math;')).toEqual(['math-value']);
    expect(rulesBoth('const s = (0, Math).sin;')).toEqual(['math-value']);
    expect(rulesBoth('export default Math;')).toEqual(['math-value']);
  });

  test('正例：经由全局对象拿到 Math', () => {
    expect(rulesBoth('const m = globalThis.Math;')).toEqual(['math-value']);
    expect(rulesBoth("const m = self['Math'];")).toEqual(['math-value']);
    expect(rulesBoth('const { Math: M } = globalThis;')).toEqual(['math-value']);
    expect(rulesBoth('const { Math } = window;')).toEqual(['math-value']);
    expect(rulesBoth('let M; ({ Math: M } = globalThis);')).toEqual(['math-value']);
    expect(rulesBoth('function f({ Math: M }) { return M; }')).toEqual(['math-value']);
  });

  test('反例：对象字面量键、方法名、标签、类型位置', () => {
    expect(rulesBoth('const b = { Math: 1 }; class C { Math() { return 1; } }')).toEqual([]);
    expect(rulesBoth('Math: for (;;) { break Math; }')).toEqual([]);
    expect(rules('let t: typeof Math; type S = typeof Math.sin; interface I { Math: Math }', 'a.ts')).toEqual([]);
    expect(rules('function f(m: Math): Math { return m; }', 'a.ts')).toEqual([]);
  });

  test('正例：import M = Math（esbuild 编成 var M = Math）、export { Math as M }', () => {
    expect(rules('import M = Math; export const y = M.sin(1);', 'a.ts')).toEqual(['math-value']);
    expect(rules('import S = Math.sin;', 'a.ts')).toEqual(['math-value']);
    expect(rules('export { Math as M };', 'a.ts')).toEqual(['math-value']);
  });

  test('反例：导出名、从别的模块转导出、只有类型的导入导出', () => {
    expect(rules('const x = 1; export { x as Math }; export { Math } from "./m"; export { Math as M2 } from "./m";', 'a.ts')).toEqual(
      [],
    );
    expect(rules('import type M = Math; export type { Math as M3 }; export { type Date as D };', 'a.ts')).toEqual([]);
  });

  test('正例：嵌套在解构赋值目标里的 { Math: M }', () => {
    expect(rulesBoth('let M; [{ Math: M }] = [globalThis];')).toEqual(['math-value']);
    expect(rulesBoth('let M; ({ a: { Math: M } } = o);')).toEqual(['math-value']);
    expect(rulesBoth('let M; [...{ 0: { Math: M } }] = [globalThis];')).toEqual(['math-value']);
    expect(rulesBoth('let M; for ([{ Math: M }] of xs);')).toEqual(['math-value']);
  });

  test('反例：不是解构目标的对象字面量里的 Math 键', () => {
    expect(rulesBoth('f([{ Math: m }]); const a = [{ Math: 1 }]; ({ a: { Math: 1 } });')).toEqual([]);
    expect(rulesBoth('let x; [x = { Math: 1 }] = y; ({ b = { Math: 1 } } = y);')).toEqual([]);
  });
});

describe('pow / pow-assign', () => {
  test('正例：**', () => {
    expect(rulesBoth('const y = a ** b;')).toEqual(['pow']);
    expect(rulesBoth('const y = 2 ** 10 ** 2;')).toEqual(['pow', 'pow']);
  });
  test('反例：连乘', () => {
    expect(rulesBoth('const y = a * a * a;')).toEqual([]);
  });
  test('正例：**=', () => {
    expect(rulesBoth('x **= 2;')).toEqual(['pow-assign']);
  });
  test('反例：*=', () => {
    expect(rulesBoth('x *= x;')).toEqual([]);
  });
});

describe('date', () => {
  test('正例：Date.now()、new Date()、Date 本身、instanceof、继承', () => {
    expect(rulesBoth('const t = Date.now();')).toEqual(['date']);
    expect(rulesBoth('const d = new Date();')).toEqual(['date']);
    expect(rulesBoth('const D = Date;')).toEqual(['date']);
    expect(rulesBoth('const b = x instanceof Date;')).toEqual(['date']);
    expect(rulesBoth('class A extends Date {}')).toEqual(['date']);
    expect(rulesBoth('const o = { Date };')).toEqual(['date']);
  });

  test('正例：经由全局对象', () => {
    expect(rulesBoth('const t = globalThis.Date.now();')).toEqual(['date']);
    expect(rulesBoth("const D = self['Date'];")).toEqual(['date']);
    expect(rulesBoth('const { Date: D } = globalThis;')).toEqual(['date']);
    expect(rules('import D = Date; export const t = D.now();', 'a.ts')).toEqual(['date']);
  });

  test('正例：嵌套解构，外层键是全局对象名、来源是全局对象', () => {
    expect(rulesBoth('const { self: { Date: D } } = globalThis;')).toEqual(['date']);
    expect(rulesBoth('const { self: { Date: D } = {} } = globalThis;')).toEqual(['date']);
    expect(rulesBoth('let D; ({ self: { Date: D } } = globalThis);')).toEqual(['date']);
  });

  test('正例：x.Date 与从任意对象解构 Date 也报（x 可能是全局对象的别名）', () => {
    expect(rulesBoth('const a = x.Date; const b = x.Date.now();')).toEqual(['date', 'date']);
    expect(rulesBoth('const { Date: d } = record;')).toEqual(['date']);
    expect(rulesBoth('const { record: { Date: d } } = globalThis; let e; [{ Date: e }] = [record];')).toEqual(['date', 'date']);
  });

  test('反例：对象字面量键、类成员', () => {
    expect(rulesBoth('const c = { Date: 1 }; class C { Date() { return 1; } }')).toEqual([]);
  });

  test('反例：类型位置（注解、as、泛型实参、implements）', () => {
    const code = [
      'let d: Date;',
      'function f(x: Date): Date { return x; }',
      'const m = new Map<string, Date>();',
      'const y = z as Date;',
      'interface I extends Date { Date: Date }',
      'class K implements Date {}',
      'type T = typeof Date;',
    ].join('\n');
    expect(rules(code, 'a.ts')).toEqual([]);
  });
});

describe('parse', () => {
  test('正例：解析失败的文件不能当作干净', () => {
    expect(rules('let q = 1 +;', 'a.js')).toEqual(['parse']);
  });
  test('反例：合法文件', () => {
    expect(rules('let q = 1 + 2;', 'a.js')).toEqual([]);
  });
});

describe('注释、字符串、模板字符串、正则不误报', () => {
  const quiet = [
    '// Math.sin(1) Date.now() a ** b',
    '/* Math.random(); Math.sqrt(2); new Date(); x **= 2 */',
    "const s1 = 'Math.sin(1)';",
    'const s2 = "Date.now() ** 2";',
    'const s3 = `Math.sqrt(${1 + 2}) Date.now()`;',
    'const r = /Math\\.sin\\(Date\\)/;',
    '/** @type {typeof Math.sin} */',
    'const ok = 1;',
  ].join('\n');

  test('TS 与 JS 都是 0 违规', () => {
    expect(rulesBoth(quiet)).toEqual([]);
    expect(rules(quiet, 'a.mjs')).toEqual([]);
    expect(rules(quiet, 'a.cjs')).toEqual([]);
  });

  test('模板字符串的替换部分是代码，照样检查', () => {
    expect(rulesBoth('const s = `x = ${Math.sin(1)}`;')).toEqual(['math-member']);
  });
});

describe('按扩展名选解析方式', () => {
  // .js/.cjs/.mjs 按 JS 解析（与 tsc 一样允许 JSX）；.ts 按 TS 解析（<div> 是类型断言，后面的 JSX 是语法错误）
  const jsx = 'const el = <div>{Math.sin(1)}</div>;';
  test('JS：能解析，照样抓到 Math.sin', () => {
    expect(rules(jsx, 'a.js')).toEqual(['math-member']);
    expect(rules(jsx, 'a.mjs')).toEqual(['math-member']);
    expect(rules(jsx, 'a.cjs')).toEqual(['math-member']);
  });
  test('TS：同一段文本解析失败', () => {
    expect(rules(jsx, 'a.ts')).toContain('parse');
  });
});

describe('位置与格式', () => {
  test('行列从 1 开始，按位置排序', () => {
    const vs = scanSource('const a = 1;\nconst b = Date.now() + Math.sin(a);\n', 'p/q.ts');
    expect(vs.map((v) => [v.line, v.col, v.rule])).toEqual([
      [2, 11, 'date'],
      [2, 24, 'math-member'],
    ]);
    expect(vs[0]?.file).toBe('p/q.ts');
  });

  test('formatViolation：path:line:col [rule] 说明', () => {
    const v: Violation = { file: 'a/b.js', line: 3, col: 7, rule: 'pow', message: '说明' };
    expect(formatViolation(v)).toBe('a/b.js:3:7 [pow] 说明');
  });
});

describe('超深语法树', () => {
  test('压缩产物式的 10 万项逗号表达式不爆栈，末尾的 Math.sin 照样抓到', () => {
    const terms = Array.from({ length: 100_000 }, (_, i) => `e.p${i}=${i}`).join(',');
    const vs = scanSource(`${terms},e.q=Math.sin(1);`, 'big.min.js');
    expect(vs.map((v) => v.rule)).toEqual(['math-member']);
  });
});

describe('CLI（runCli）', () => {
  /** 运行 runCli，收集输出行。 */
  function cli(argv: string[], opts: Omit<CliOptions, 'out' | 'err'> = {}): { code: number; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    const code = runCli(argv, { ...opts, out: (s) => out.push(s), err: (s) => err.push(s) });
    return { code, out, err };
  }

  test('有违规：逐条打印、最后一行汇总、退出 1；干净：退出 0', () => {
    const root = tmp('cli');
    const bad = join(root, 'bad.js');
    const good = join(root, 'good.js');
    writeFileSync(bad, 'const t = Date.now();\n');
    writeFileSync(good, 'const t = Math.abs(-1);\n');
    const r1 = cli([bad, good]);
    expect(r1.code).toBe(1);
    expect(r1.out.length).toBe(2);
    expect(r1.out[0]).toMatch(/bad\.js:1:11 \[date\] /);
    expect(r1.out.at(-1)).toBe('[sim:scan] 2 个文件，1 处违规');
    const r0 = cli([good]);
    expect(r0.code).toBe(0);
    expect(r0.out).toEqual(['[sim:scan] 1 个文件，0 处违规']);
  });

  test('无参数：扫 sim.js；不存在时提示先 sim:build 并退出 1', () => {
    const root = tmp('cli-default');
    const simJs = join(root, 'sim.js');
    const missing = cli([], { simJs });
    expect(missing.code).toBe(1);
    expect(missing.err.join('\n')).toContain('先运行 bun run sim:build');
    writeFileSync(simJs, '(function () { globalThis.BadmintonSim = { r: Math.random() }; })();\n');
    const found = cli([], { simJs });
    expect(found.code).toBe(1);
    expect(found.out.at(-1)).toBe('[sim:scan] 1 个文件，1 处违规');
  });

  test('参数错误退出 2；路径不存在退出 1', () => {
    expect(cli(['--nope']).code).toBe(2);
    expect(cli(['--staged', 'x.js']).code).toBe(2);
    const missing = cli([join(tmp('cli-missing'), 'nope.js')]);
    expect(missing.code).toBe(1);
    expect(missing.err.join('\n')).toContain('路径不存在');
  });

  test('作为脚本运行（import.meta.main）：退出码与汇总行', () => {
    const root = tmp('cli-proc');
    writeFileSync(join(root, 'x.ts'), 'export const y = 2 ** 8;\n');
    const r = spawnSync(process.execPath, [resolve(import.meta.dir, '../scan.ts'), root], { encoding: 'utf8', timeout: 20_000 });
    expect(r.status).toBe(1);
    expect(r.stdout.trimEnd().split('\n').at(-1)).toBe('[sim:scan] 1 个文件，1 处违规');
  });
});

describe('scanFiles', () => {
  test('目录递归扫 .js/.cjs/.mjs/.ts，跳过 node_modules 与其他扩展名', () => {
    const root = tmp('files');
    mkdirSync(join(root, 'sub/deeper'), { recursive: true });
    mkdirSync(join(root, 'node_modules/pkg'), { recursive: true });
    writeFileSync(join(root, 'a.js'), 'Math.sin(1);');
    writeFileSync(join(root, 'b.cjs'), 'const ok = Math.abs(-1);');
    writeFileSync(join(root, 'sub/c.mjs'), 'x **= 2;');
    writeFileSync(join(root, 'sub/deeper/d.ts'), 'const t: number = Date.now();');
    writeFileSync(join(root, 'sub/e.txt'), 'Math.sin(1);');
    writeFileSync(join(root, 'sub/f.json'), '{"Math.sin": 1}');
    writeFileSync(join(root, 'node_modules/pkg/index.js'), 'Math.random();');
    const r = scanFiles([root]);
    expect(r.files).toBe(4);
    expect(r.violations.map((v) => [v.file, v.rule])).toEqual([
      [join(root, 'a.js'), 'math-member'],
      [join(root, 'sub/c.mjs'), 'pow-assign'],
      [join(root, 'sub/deeper/d.ts'), 'date'],
    ]);
  });

  test('显式给出的文件不论扩展名都扫；重复路径只扫一次；目录符号链接不跟随', () => {
    const root = tmp('explicit');
    const f = join(root, 'plugin.bundle');
    writeFileSync(f, 'Math.exp(1);');
    symlinkSync(root, join(root, 'loop'));
    const r = scanFiles([f, f, root]);
    expect(r.files).toBe(1);
    expect(r.violations.map((v) => v.rule)).toEqual(['math-member']);
  });

  test('路径不存在时抛错', () => {
    expect(() => scanFiles([join(tmp('missing'), 'nope.js')])).toThrow('路径不存在');
  });
});

describe('构建产物', () => {
  test('真实构建的 sim.js 扫描 0 违规', async () => {
    const out = tmp('real');
    const r = await buildSim({ outDir: out, dts: false });
    const s = scanFiles([r.jsPath]);
    expect(s.files).toBe(1);
    expect(s.violations.map(formatViolation)).toEqual([]);
  });

  test('对照：用了 Math.sin / Math.random / Math.sqrt / ** / Date 的入口，打包后都被抓到', async () => {
    const out = tmp('bad');
    const r = await buildSim({ entry: join(FIXTURES, 'bad-entry.js'), outDir: out, dts: false });
    const s = scanFiles([r.jsPath]);
    expect(s.violations.map((v) => v.rule).sort()).toEqual(['date', 'math-member', 'math-member', 'math-member', 'pow']);
  });

  test('对照：入口经由全局对象的别名 / 条件表达式取 Math、Date（tsc、ESLint 旧规则都放过），打包后被抓到', async () => {
    const dir = tmp('alias');
    const entry = join(dir, 'index.ts');
    writeFileSync(
      entry,
      [
        'declare const GameGlobal: typeof globalThis;',
        "const root = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis;",
        "const api = { t: root.Math.sin(root.Date.now()), l: (typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).Math.log(2) };",
        "(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis as any).BadmintonSim = api;",
        '',
      ].join('\n'),
    );
    const r = await buildSim({ entry, outDir: join(dir, 'out'), dts: false });
    const s = scanFiles([r.jsPath]);
    expect(s.violations.map((v) => v.rule).sort()).toEqual(['date', 'math-member', 'math-member']);
  });
});

// ---------------------------------------------------------------- scanStaged

const GIT = Bun.which('git');

/** 去掉 GIT_DIR / GIT_INDEX_FILE 等变量，防止测试在 git 钩子里运行时误操作外层仓库。 */
function cleanGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) if (!k.startsWith('GIT_') && v !== undefined) env[k] = v;
  return env;
}

function git(cwd: string, ...args: string[]): void {
  const r = spawnSync(
    'git',
    ['-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgsign=false', '-c', 'user.name=t', '-c', 'user.email=t@t', ...args],
    { cwd, env: cleanGitEnv(), encoding: 'utf8' },
  );
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} 失败：${r.stderr}`);
}

/**
 * 在去掉 GIT_* 环境变量（再叠加 extra）的环境里执行 fn，结束后恢复。
 * scanStaged 本身有意继承环境（pre-commit 里要读 GIT_INDEX_FILE 指向的索引），测试里要隔离外层仓库。
 */
function withGitEnv<T>(fn: () => T, extra: Record<string, string> = {}): T {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(process.env)) {
    if (k.startsWith('GIT_')) {
      saved[k] = process.env[k];
      delete process.env[k];
    }
  }
  for (const [k, v] of Object.entries(extra)) {
    if (!(k in saved)) saved[k] = process.env[k];
    process.env[k] = v;
  }
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

function stagedClean(repo: string): { files: number; violations: Violation[] } {
  return withGitEnv(() => scanStaged(repo));
}

describe.skipIf(!GIT)('scanStaged（临时 git 仓库）', () => {
  test('扫的是索引而不是工作树', () => {
    const repo = tmp('git');
    git(repo, 'init', '-q', '-b', 'main');
    const src = join(repo, 'packages/sim/src');
    mkdirSync(src, { recursive: true });
    const x = join(src, 'x.ts');

    // 1. 暂存含 Math.sin 的文件 → 报违规（仓库还没有任何提交也要能扫）
    writeFileSync(x, 'export const y = Math.sin(1);\n');
    git(repo, 'add', 'packages/sim/src/x.ts');
    let r = stagedClean(repo);
    expect(r.files).toBe(1);
    expect(r.violations.map((v) => [v.file, v.line, v.col, v.rule])).toEqual([
      ['packages/sim/src/x.ts', 1, 18, 'math-member'],
    ]);

    // 2. 只把工作树改干净、不 git add → 仍报违规（证明读的是暂存版本）
    writeFileSync(x, 'export const y = Math.abs(1);\n');
    r = stagedClean(repo);
    expect(r.violations.map((v) => v.rule)).toEqual(['math-member']);

    // 3. 暂存干净内容 → 0 违规
    git(repo, 'add', 'packages/sim/src/x.ts');
    r = stagedClean(repo);
    expect(r.files).toBe(1);
    expect(r.violations).toEqual([]);

    // 4. 反方向：提交后工作树写坏但暂存区干净 → 0 违规（未改动的文件不在 diff --cached 里）
    git(repo, 'commit', '-q', '--no-verify', '-m', 'init');
    writeFileSync(x, 'export const y = Math.random();\n');
    r = stagedClean(repo);
    expect(r.files).toBe(0);
    expect(r.violations).toEqual([]);
  });

  test('范围：packages/sim/src/**/*.ts、packages/contracts/src/**/*.ts 与被暂存的 dist/sim.js；其他路径不扫', () => {
    const repo = tmp('git-scope');
    git(repo, 'init', '-q', '-b', 'main');
    const files: Record<string, string> = {
      'packages/sim/src/deep/er/a.ts': 'export const t = Date.now();\n',
      'packages/sim/src/note.md': 'Math.sin(1)\n',
      'packages/sim/dist/sim.js': '(() => { globalThis.BadmintonSim = { p: 2 ** 3 }; })();\n',
      'packages/sim/test/t.test.ts': 'Math.sin(1);\n',
      'packages/contracts/src/c.ts': 'export const c = Math.cos(1);\n',
      'packages/contracts/src/gen/g.ts': 'export const g = 2 ** 3;\n',
      'packages/contracts/src/README.md': 'Math.sin(1)\n',
      'packages/contracts/scripts/s.ts': 'Math.sin(1);\n',
      'packages/contracts/test/t.test.ts': 'Math.sin(1);\n',
      'tools/x.ts': 'Math.random();\n',
    };
    for (const [p, text] of Object.entries(files)) {
      mkdirSync(join(repo, p, '..'), { recursive: true });
      writeFileSync(join(repo, p), text);
    }
    git(repo, 'add', '-A');
    const r = stagedClean(repo);
    expect(r.files).toBe(4);
    expect(r.violations.map((v) => [v.file, v.rule])).toEqual([
      ['packages/contracts/src/c.ts', 'math-member'],
      ['packages/contracts/src/gen/g.ts', 'pow'],
      ['packages/sim/dist/sim.js', 'pow'],
      ['packages/sim/src/deep/er/a.ts', 'date'],
    ]);
  });

  test('契约运行时代码会被打进 sim.js：暂存的 packages/contracts/src/*.ts 照样拦', () => {
    const repo = tmp('git-contracts');
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'packages/contracts/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/contracts/src/replay.ts'), 'export const stamp = (): number => Date.now();\n');
    git(repo, 'add', '-A');
    const r = stagedClean(repo);
    expect(r.files).toBe(1);
    expect(r.violations.map((v) => [v.file, v.line, v.rule])).toEqual([['packages/contracts/src/replay.ts', 1, 'date']]);
  });

  test('继承 GIT_INDEX_FILE：pre-commit 用临时索引（git commit -a / git commit <路径>）时扫的是那份索引', () => {
    const repo = tmp('git-index');
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'packages/sim/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/sim/src/x.ts'), 'export const y = Math.abs(1);\n');
    git(repo, 'add', '-A');
    // 另一份索引里暂存的是坏内容；默认索引里是好内容
    const altIndex = join(repo, '.git', 'alt-index');
    writeFileSync(join(repo, 'packages/sim/src/x.ts'), 'export const y = Math.exp(1);\n');
    const r0 = spawnSync('git', ['add', '-A'], { cwd: repo, env: { ...cleanGitEnv(), GIT_INDEX_FILE: altIndex } });
    expect(r0.status).toBe(0);
    expect(stagedClean(repo).violations).toEqual([]);
    const viaAlt = withGitEnv(() => scanStaged(repo), { GIT_INDEX_FILE: altIndex });
    expect(viaAlt.violations.map((v) => v.rule)).toEqual(['math-member']);
  });

  test('CLI --staged 扫给定仓库的暂存区', () => {
    const repo = tmp('git-cli');
    git(repo, 'init', '-q', '-b', 'main');
    mkdirSync(join(repo, 'packages/sim/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/sim/src/x.ts'), 'export const y = Math.tan(1);\n');
    git(repo, 'add', '-A');
    const out: string[] = [];
    const code = withGitEnv(() => runCli(['--staged'], { repoRoot: repo, out: (s) => out.push(s), err: (s) => out.push(s) }));
    expect(code).toBe(1);
    expect(out).toEqual([
      expect.stringMatching(/^packages\/sim\/src\/x\.ts:1:18 \[math-member\] /) as unknown as string,
      '[sim:scan] 1 个文件，1 处违规',
    ]);
  });

  test('不在 git 仓库里时抛错', () => {
    const notRepo = tmp('not-git');
    expect(() => withGitEnv(() => scanStaged(notRepo), { GIT_CEILING_DIRECTORIES: tmpdir() })).toThrow('git');
  });
});

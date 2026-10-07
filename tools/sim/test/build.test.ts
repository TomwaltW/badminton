/**
 * sim:build 的测试（计划 2.2）：全部构建到临时目录，不依赖预先构建好的 packages/sim/dist。
 * - sim.js 末尾是 IIFE 内最后一条显式全局赋值，没有 --global-name 式的顶层 var；
 * - 连续构建两次逐字节相同；sim.version = 文件字节的 FNV-1a（与 hash.ts 的 fnvBytes 一致）；
 * - node 与 bun 子进程 require 后都能拿到 globalThis.BadmintonSim，内核语料哈希相等；
 * - 模拟微信（vm 新上下文里预先定义 GameGlobal）时挂在 GameGlobal 上；
 * - sim.d.ts 能被 lib ES2017、types [] 的消费者通过 /// <reference path> 类型检查；
 * - sim 以相对路径引用的契约（packages/contracts/src）：用到的常量打进 sim.js，类型一并编进 sim.d.ts
 *   （模块名 badminton-sim/contracts/<x>），sim.d.ts 里没有任何指向 badminton-sim/* 以外的导入，
 *   独立消费者工程（lib ES2017、types []、skipLibCheck false）能用到契约类型。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import ts from 'typescript';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import {
  DTS_INDEX_MODULE,
  SIM_BANNER,
  buildSim,
  bundleSim,
  dtsModuleName,
  dtsModuleRefs,
  finalizeDts,
  type BuildResult,
} from '../build';
import { fnv1aBytes } from '../fnv';
import { TSC_BIN } from '../paths';
import { fnvBytes, hex8 } from '../../../packages/sim/src/hash';

const FIXTURES = resolve(import.meta.dir, 'fixtures');
const BUILD_TIMEOUT = 30_000;

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `sim-build-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** 两次独立构建（各自的临时目录，都生成 sim.d.ts），所有用例共用。 */
let builds: Promise<[BuildResult, BuildResult]> | undefined;
function getBuilds(): Promise<[BuildResult, BuildResult]> {
  builds ??= (async () => {
    const a = await buildSim({ outDir: tmp('a') });
    const b = await buildSim({ outDir: tmp('b') });
    return [a, b] as [BuildResult, BuildResult];
  })();
  return builds;
}

function unwrapParens(e: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(e)) e = e.expression;
  return e;
}

/** 外部 node：优先 /opt/node22/bin/node，否则 PATH 上的 node。 */
const NODE = existsSync('/opt/node22/bin/node') ? '/opt/node22/bin/node' : Bun.which('node');

describe('sim:build 产物', () => {
  test(
    'sim.js 末尾是 IIFE 内最后一条显式全局赋值，没有顶层 var',
    async () => {
      const [a] = await getBuilds();
      const text = readFileSync(a.jsPath, 'utf8');
      expect(text.startsWith(`${SIM_BANNER}\n`)).toBe(true);
      expect(text).toMatch(
        /\n {2}\(typeof GameGlobal !== "undefined" \? GameGlobal : globalThis\)\.BadmintonSim = api;\n\}\)\(\);\n$/,
      );

      const sf = ts.createSourceFile('sim.js', text, ts.ScriptTarget.ES2017, true, ts.ScriptKind.JS);
      // 顶层：只有 "use strict" 指令与一条 IIFE 调用语句；没有 var / let / const / function / class
      const top = sf.statements.filter(
        (s) => !(ts.isExpressionStatement(s) && ts.isStringLiteral(s.expression) && s.expression.text === 'use strict'),
      );
      expect(top.length).toBe(1);
      expect(sf.statements.some((s) => ts.isVariableStatement(s) || ts.isFunctionDeclaration(s) || ts.isClassDeclaration(s))).toBe(
        false,
      );
      const iife = top[0]!;
      if (!ts.isExpressionStatement(iife) || !ts.isCallExpression(iife.expression)) throw new Error('顶层不是 IIFE 调用');
      expect(iife.expression.arguments.length).toBe(0);
      const fn = unwrapParens(iife.expression.expression);
      if (!ts.isArrowFunction(fn) && !ts.isFunctionExpression(fn)) throw new Error('IIFE 的被调用者不是函数');
      if (!fn.body || !ts.isBlock(fn.body)) throw new Error('IIFE 没有块体');

      // IIFE 内最后一条：(typeof GameGlobal !== "undefined" ? GameGlobal : globalThis).BadmintonSim = api
      const last = fn.body.statements[fn.body.statements.length - 1]!;
      if (!ts.isExpressionStatement(last) || !ts.isBinaryExpression(last.expression)) throw new Error('最后一条不是赋值');
      const asg = last.expression;
      expect(asg.operatorToken.kind).toBe(ts.SyntaxKind.EqualsToken);
      if (!ts.isPropertyAccessExpression(asg.left)) throw new Error('赋值左边不是属性访问');
      expect(asg.left.name.text).toBe('BadmintonSim');
      const target = unwrapParens(asg.left.expression);
      if (!ts.isConditionalExpression(target)) throw new Error('赋值目标不是 GameGlobal / globalThis 的条件表达式');
      expect(target.condition.getText(sf)).toBe('typeof GameGlobal !== "undefined"');
      expect(target.whenTrue.getText(sf)).toBe('GameGlobal');
      expect(target.whenFalse.getText(sf)).toBe('globalThis');
      expect(ts.isIdentifier(asg.right) && asg.right.text).toBe('api');
    },
    BUILD_TIMEOUT,
  );

  test(
    '连续构建两次逐字节相同（sim.js、sim.version、sim.d.ts）',
    async () => {
      const [a, b] = await getBuilds();
      expect(a.bytes).toBe(b.bytes);
      expect(a.simVer).toBe(b.simVer);
      expect(Buffer.compare(readFileSync(a.jsPath), readFileSync(b.jsPath))).toBe(0);
      const dir = (p: string) => resolve(p, '..');
      for (const name of ['sim.version', 'sim.d.ts']) {
        expect(Buffer.compare(readFileSync(join(dir(a.jsPath), name)), readFileSync(join(dir(b.jsPath), name)))).toBe(0);
      }
    },
    BUILD_TIMEOUT,
  );

  test(
    'sim.version = sim.js 字节的 FNV-1a（8 位十六进制，与 hash.ts 的 fnvBytes 一致）',
    async () => {
      const [a] = await getBuilds();
      const bytes = new Uint8Array(readFileSync(a.jsPath));
      expect(bytes.length).toBe(a.bytes);
      const version = readFileSync(join(resolve(a.jsPath, '..'), 'sim.version'), 'utf8');
      expect(version).toMatch(/^[0-9a-f]{8}\n$/);
      const expected = hex8(fnvBytes(bytes));
      expect(version).toBe(`${expected}\n`);
      expect(a.simVer).toBe(expected);
      // 工具侧的 fnv1aBytes 与模拟核心的 fnvBytes 是同一个定义
      expect(fnv1aBytes(bytes)).toBe(fnvBytes(bytes));
      const probe = new TextEncoder().encode('羽毛球 sim.version');
      expect(fnv1aBytes(probe)).toBe(fnvBytes(probe));
      expect(hex8(fnvBytes(new Uint8Array(0)))).toBe('811c9dc5');
      expect(hex8(fnvBytes(new TextEncoder().encode('a')))).toBe('e40c292c');
    },
    BUILD_TIMEOUT,
  );

  test(
    'dts: false 时不生成 sim.d.ts',
    async () => {
      const out = tmp('nodts');
      const r = await buildSim({ outDir: out, dts: false });
      expect(r.dtsPath).toBeNull();
      expect(existsSync(join(out, 'sim.d.ts'))).toBe(false);
      expect(existsSync(join(out, 'sim.version'))).toBe(true);
    },
    BUILD_TIMEOUT,
  );

  test(
    '契约 packages/contracts/src/api.ts 被打进 sim.js（flight 的 SIM_HZ / U_PER_TICK 以它为单一来源）',
    async () => {
      const [a] = await getBuilds();
      const text = readFileSync(a.jsPath, 'utf8');
      // esbuild 不压缩时在每个被打包的模块前写 "// <路径>" 注释
      expect(text).toContain('\n  // packages/contracts/src/api.ts\n');
      expect(text).toContain('\n  // packages/sim/src/flight.ts\n');
    },
    BUILD_TIMEOUT,
  );

  test('bundleSim 拒绝末尾没有显式全局赋值的入口', async () => {
    await expect(bundleSim(join(FIXTURES, 'no-global-entry.js'))).rejects.toThrow('末尾不是显式的全局赋值');
  });
});

describe('加载：node / bun / 模拟微信', () => {
  /** 在子进程里 require sim.js，返回 typeof 与 20 拍内核语料的结果。 */
  function probe(exe: string, jsPath: string): { type: string; hash: number; steps: number; exported: number } {
    const dir = tmp('probe');
    const script = join(dir, 'probe.cjs');
    writeFileSync(
      script,
      [
        '/* 由 build.test.ts 生成：require sim.js 后检查全局 BadmintonSim。 */',
        'const exported = require(process.argv[2]);',
        'const s = globalThis.BadmintonSim;',
        'const r = typeof s === "object" && s !== null ? s.kernel.run({ shots: 20 }) : null;',
        'process.stdout.write(JSON.stringify({ type: typeof s, hash: r && r.hash, steps: r && r.steps,',
        '  exported: Object.keys(exported).length }));',
      ].join('\n'),
    );
    const r = spawnSync(exe, [script, jsPath], { encoding: 'utf8', timeout: 20_000 });
    if (r.status !== 0) throw new Error(`${exe} 运行失败（${r.status}）：${r.stderr}`);
    return JSON.parse(r.stdout) as { type: string; hash: number; steps: number; exported: number };
  }

  test(
    `bun（${process.execPath}）子进程 require 后有 globalThis.BadmintonSim，且不导出任何东西`,
    async () => {
      const [a] = await getBuilds();
      const viaBun = probe(process.execPath, a.jsPath);
      expect(viaBun.type).toBe('object');
      expect(typeof viaBun.hash).toBe('number');
      expect(viaBun.steps).toBeGreaterThan(0);
      // 不是 CommonJS 模块：什么都不导出，只靠显式全局赋值
      expect(viaBun.exported).toBe(0);
    },
    BUILD_TIMEOUT,
  );

  test.skipIf(!NODE)(
    `node（${NODE ?? '未找到，跳过'}）与 bun require 后都有 BadmintonSim，20 拍内核哈希相等`,
    async () => {
      const [a] = await getBuilds();
      const viaNode = probe(NODE!, a.jsPath);
      const viaBun = probe(process.execPath, a.jsPath);
      expect(viaNode.type).toBe('object');
      expect(viaNode.exported).toBe(0);
      expect(viaBun).toEqual(viaNode);
    },
    BUILD_TIMEOUT,
  );

  test(
    '模拟微信：vm 新上下文里预先定义 GameGlobal，API 挂在 GameGlobal 上而不是 globalThis 上',
    async () => {
      const [a] = await getBuilds();
      const code = readFileSync(a.jsPath, 'utf8');

      // 1. 文件直接作为脚本执行
      const gg1: Record<string, unknown> = {};
      const ctx1 = vm.createContext({ GameGlobal: gg1 });
      vm.runInContext(code, ctx1, { filename: 'sim.js' });
      expect(typeof gg1.BadmintonSim).toBe('object');
      expect(vm.runInContext('typeof globalThis.BadmintonSim', ctx1)).toBe('undefined');
      expect(vm.runInContext('GameGlobal.BadmintonSim.dsqrt(4)', ctx1)).toBe(2);

      // 2. 微信里每个文件的顶层变量只在本文件有效：包一层函数作用域执行，仍然只靠显式赋值暴露
      const gg2: Record<string, unknown> = {};
      const ctx2 = vm.createContext({ GameGlobal: gg2 });
      vm.runInContext(`(function () {\n${code}\n})();`, ctx2, { filename: 'sim.js' });
      expect(typeof gg2.BadmintonSim).toBe('object');
      expect(vm.runInContext('typeof globalThis.BadmintonSim', ctx2)).toBe('undefined');

      // 3. 没有 GameGlobal 的上下文：挂在 globalThis 上；两种挂法跑出的内核哈希相同
      const ctx3 = vm.createContext({});
      vm.runInContext(code, ctx3, { filename: 'sim.js' });
      expect(vm.runInContext('typeof globalThis.BadmintonSim', ctx3)).toBe('object');
      const h1 = vm.runInContext('GameGlobal.BadmintonSim.kernel.run({ shots: 5 }).hash', ctx1) as number;
      const h3 = vm.runInContext('globalThis.BadmintonSim.kernel.run({ shots: 5 }).hash', ctx3) as number;
      expect(typeof h1).toBe('number');
      expect(h1).toBe(h3);
    },
    BUILD_TIMEOUT,
  );
});

describe('sim.d.ts', () => {
  /** 用 lib ES2017、types [] 类型检查一个消费者文件，返回诊断文本。 */
  function typecheck(file: string): string[] {
    const program = ts.createProgram([file], {
      target: ts.ScriptTarget.ES2017,
      lib: ['lib.es2017.d.ts'],
      types: [],
      strict: true,
      noEmit: true,
      skipLibCheck: false,
    });
    return ts
      .getPreEmitDiagnostics(program)
      .map((d) => `${d.file ? `${d.file.fileName}:` : ''}${ts.flattenDiagnosticMessageText(d.messageText, ' ')}`);
  }

  test(
    '消费者经 /// <reference path> 类型检查通过；dsqrt 返回 number；不存在的字段报错',
    async () => {
      const [a] = await getBuilds();
      const dir = tmp('dts');
      const consumer = join(dir, 'consumer.ts');
      writeFileSync(
        consumer,
        [
          `/// <reference path="${a.dtsPath!.replace(/\\/g, '/')}" />`,
          'type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;',
          'const root: number = BadmintonSim.dsqrt(4);',
          'const isNumber: Exactly<ReturnType<typeof BadmintonSim.dsqrt>, number> = true;',
          'const hash: number = BadmintonSim.kernel.run({ shots: 1 }).hash;',
          'const viaGlobal: typeof BadmintonSim = globalThis.BadmintonSim;',
          '// @ts-expect-error dsqrt 返回 number，不能当 string',
          'const notString: string = BadmintonSim.dsqrt(4);',
          '// @ts-expect-error 不存在的字段',
          'BadmintonSim.noSuchField;',
          '// @ts-expect-error 不存在的字段（嵌套）',
          'BadmintonSim.kernel.noSuchRunner();',
          'export { root, isNumber, hash, viaGlobal, notString };',
        ].join('\n'),
      );
      expect(typecheck(consumer)).toEqual([]);

      // 对照：不引用 sim.d.ts 时 BadmintonSim 不存在（全局类型确实来自 sim.d.ts）
      const bare = join(dir, 'bare.ts');
      writeFileSync(bare, 'const n: number = BadmintonSim.dsqrt(4);\nexport { n };\n');
      const diags = typecheck(bare);
      expect(diags.length).toBeGreaterThan(0);
      expect(diags.join('\n')).toContain('BadmintonSim');
    },
    BUILD_TIMEOUT,
  );

  test(
    '模块名统一为 badminton-sim/*（含 badminton-sim/contracts/api）；没有指向 badminton-sim/* 以外的导入',
    async () => {
      const [a] = await getBuilds();
      const shape = dtsModuleRefs(readFileSync(a.dtsPath!, 'utf8'));
      expect(shape.declared).toContain(DTS_INDEX_MODULE);
      expect(shape.declared).toContain('badminton-sim/flight');
      expect(shape.declared).toContain('badminton-sim/contracts/api');
      expect(shape.declared.filter((n) => !n.startsWith('badminton-sim/'))).toEqual([]);
      expect(new Set(shape.declared).size).toBe(shape.declared.length);
      // flight 确实从契约取 SIM_HZ / U_PER_TICK（这条通路被真实代码覆盖）
      expect(shape.specifiers).toContain('badminton-sim/contracts/api');
      // 每个说明符都指向本文件声明的模块：消费者工程不需要解析任何外部模块
      const declared = new Set(shape.declared);
      expect(shape.specifiers.filter((s) => !declared.has(s))).toEqual([]);
      expect(shape.tripleSlash).toEqual([]);
    },
    BUILD_TIMEOUT,
  );

  test(
    '独立消费者工程（tsconfig：lib ES2017、types []、skipLibCheck false）经 /// <reference path> 类型检查通过，能用到契约类型',
    async () => {
      const [a] = await getBuilds();
      const dir = tmp('consumer');
      const dts = a.dtsPath!.replace(/\\/g, '/');
      writeFileSync(
        join(dir, 'tsconfig.json'),
        JSON.stringify(
          {
            compilerOptions: {
              target: 'ES2017',
              lib: ['ES2017'],
              types: [],
              strict: true,
              noEmit: true,
              skipLibCheck: false,
            },
            files: ['consumer.ts'],
          },
          null,
          2,
        ),
      );
      writeFileSync(
        join(dir, 'consumer.ts'),
        [
          `/// <reference path="${dts}" />`,
          'type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;',
          'type IsAny<T> = 0 extends 1 & T ? true : false;',
          '// 全局 API 上的时间常量：对象字面量里放宽成 number',
          'const tick: number = BadmintonSim.flight.U_PER_TICK;',
          'const tickIsNumber: Exactly<typeof BadmintonSim.flight.U_PER_TICK, number> = true;',
          '// 契约 api.ts 的常量经 badminton-sim/flight 转出，仍是契约里的字面量类型，不是 any',
          "const tickLiteral: Exactly<typeof import('badminton-sim/flight').U_PER_TICK, 1000> = true;",
          "const hzNotAny: IsAny<typeof import('badminton-sim/flight').SIM_HZ> = false;",
          '// 契约类型可用',
          "type MatchCfg = import('badminton-sim/contracts/match-cfg').MatchCfg;",
          "type CreateSim = import('badminton-sim/contracts/api').CreateSim;",
          'const cfgParam: Exactly<Parameters<CreateSim>[0], MatchCfg> = true;',
          "const kind: import('badminton-sim/contracts/api').InputKind = 2;",
          '// @ts-expect-error 契约规定 InputKind 的 0 永久保留为非法（种类以后可能扩到 15，别用 5..15 当反例）',
          "const badKind: import('badminton-sim/contracts/api').InputKind = 0;",
          '// @ts-expect-error 不存在的字段',
          'BadmintonSim.flight.U_PER_FRAME;',
          'export { tick, tickIsNumber, tickLiteral, hzNotAny, cfgParam, kind, badKind };',
        ].join('\n'),
      );
      const r = spawnSync(TSC_BIN, ['-p', join(dir, 'tsconfig.json'), '--listFiles'], { cwd: dir, encoding: 'utf8' });
      if (r.error) throw r.error;
      expect({ status: r.status, out: r.status === 0 ? '' : `${r.stdout}${r.stderr}` }).toEqual({ status: 0, out: '' });
      // 程序里只有 TypeScript 自带的 lib、sim.d.ts 与消费者自己：没有从仓库或 node_modules 解析到任何东西
      const files = r.stdout.split('\n').filter((l) => l.length > 0);
      expect(files).toContain(dts);
      expect(files).toContain(join(dir, 'consumer.ts').replace(/\\/g, '/'));
      const others = files.filter(
        (f) => f !== dts && f !== join(dir, 'consumer.ts').replace(/\\/g, '/') && !/\/typescript\/lib\/lib\.[\w.]+\.d\.ts$/.test(f),
      );
      expect(others).toEqual([]);
    },
    BUILD_TIMEOUT,
  );
});

describe('sim.d.ts 的整理（finalizeDts）：合成输入', () => {
  /** 拼一段 tsc 输出形状的 AMD 单文件 d.ts。 */
  function amd(mods: Record<string, string[]>, prefix = ''): string {
    return (
      prefix +
      Object.entries(mods)
        .map(([name, body]) => `declare module "${name}" {\n${body.map((l) => `    ${l}\n`).join('')}}\n`)
        .join('')
    );
  }

  test('dtsModuleName：sim/src/<x> → badminton-sim/<x>，contracts/src/<x> → badminton-sim/contracts/<x>，其余报错', () => {
    expect(dtsModuleName('sim/src/index')).toBe('badminton-sim/index');
    expect(dtsModuleName('sim/src/flight')).toBe('badminton-sim/flight');
    expect(dtsModuleName('contracts/src/api')).toBe('badminton-sim/contracts/api');
    expect(dtsModuleName('contracts/src/gen/snapshot-offsets')).toBe('badminton-sim/contracts/gen/snapshot-offsets');
    for (const bad of ['index', 'api', 'content/src/x', 'sim/test/x', 'protocol/src/x', 'sim/src/', 'contracts/src/', 'src/x']) {
      expect(() => dtsModuleName(bad)).toThrow('意外的模块');
    }
  });

  test('dtsModuleRefs：各种导入形式都算，注释与字符串里的文字不算', () => {
    const refs = dtsModuleRefs(
      [
        '/// <reference types="bun" />',
        '/// <reference path="./x.d.ts" />',
        'declare module "m/a" {',
        '    import { A } from "m/b";',
        '    import type { B } from "ext-1";',
        '    import "ext-2";',
        '    import C = require("ext-3");',
        '    export * from "ext-4";',
        '    export { D } from "ext-5";',
        '    export type E = import("ext-6").E;',
        '    /** 注释里写 from "ext-comment" 与 import("ext-comment") 不算 */',
        '    export const s = "from \\"ext-string\\"";',
        '}',
        'declare global { var G: number; }',
      ].join('\n'),
    );
    expect(refs.declared).toEqual(['m/a']);
    expect(refs.specifiers.sort()).toEqual(['ext-1', 'ext-2', 'ext-3', 'ext-4', 'ext-5', 'ext-6', 'm/b']);
    expect(refs.tripleSlash.sort()).toEqual(['./x.d.ts', 'bun']);
  });

  test('改名：模块名与 from / import() / import "x" / require() 里的说明符都改；加文件头', () => {
    const out = finalizeDts(
      amd({
        'contracts/src/api': ['export const U_PER_TICK = 1000;'],
        'sim/src/flight': ['import { U_PER_TICK } from "contracts/src/api";', 'export { U_PER_TICK };'],
        'sim/src/index': [
          'import "sim/src/flight";',
          'import F = require("sim/src/flight");',
          'export type T = typeof import("contracts/src/api").U_PER_TICK;',
          'export * from "sim/src/flight";',
        ],
      }),
    );
    expect(out.startsWith('// 由 bun run sim:build 生成')).toBe(true);
    const refs = dtsModuleRefs(out);
    expect(refs.declared).toEqual(['badminton-sim/contracts/api', 'badminton-sim/flight', 'badminton-sim/index']);
    expect([...new Set(refs.specifiers)].sort()).toEqual(['badminton-sim/contracts/api', 'badminton-sim/flight']);
    expect(out).not.toMatch(/"(sim|contracts)\/src\//);
  });

  test('没有 sim/src/index 时报错', () => {
    expect(() => finalizeDts(amd({ 'sim/src/flight': ['export const A = 1;'] }))).toThrow(`没有 ${DTS_INDEX_MODULE}`);
    // 旧形状（rootDir = src 时的 "index"）也不再接受
    expect(() => finalizeDts(amd({ index: ['export const A = 1;'] }))).toThrow('意外的模块 "index"');
  });

  test('sim/src、contracts/src 以外的模块名报错（例如 sim 误引了别的包）', () => {
    expect(() =>
      finalizeDts(amd({ 'content/src/x': ['export const A = 1;'], 'sim/src/index': ['import { A } from "content/src/x";'] })),
    ).toThrow('意外的模块 "content/src/x"');
  });

  test('两个模块改名后撞名时报错', () => {
    expect(() =>
      finalizeDts(
        amd({
          'contracts/src/api': ['export const A = 1;'],
          'sim/src/contracts/api': ['export const A = 2;'],
          'sim/src/index': ['export const B = 1;'],
        }),
      ),
    ).toThrow('都改名成了 "badminton-sim/contracts/api"');
  });

  test('改名后仍有指向 badminton-sim/* 以外的导入时报错（from、import()、import "x"、require()）', () => {
    const cases = [
      'import { X } from "typescript";',
      'export type T = import("bun").Server;',
      'import "some-polyfill";',
      'import Y = require("node:fs");',
      'export * from "../../contracts/src/api";',
      'import { Z } from "badminton-sim/not-declared";',
    ];
    for (const line of cases) {
      expect(() => finalizeDts(amd({ 'sim/src/index': [line] }))).toThrow('指向 badminton-sim/* 以外');
    }
  });

  test('有三斜线引用时报错', () => {
    expect(() => finalizeDts(amd({ 'sim/src/index': ['export const A = 1;'] }, '/// <reference types="bun" />\n'))).toThrow(
      '三斜线引用',
    );
  });
});

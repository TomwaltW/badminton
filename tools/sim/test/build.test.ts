/**
 * sim:build 的测试（计划 2.2）：全部构建到临时目录，不依赖预先构建好的 packages/sim/dist。
 * - sim.js 末尾是 IIFE 内最后一条显式全局赋值，没有 --global-name 式的顶层 var；
 * - 连续构建两次逐字节相同；sim.version = 文件字节的 FNV-1a（与 hash.ts 的 fnvBytes 一致）；
 * - node 与 bun 子进程 require 后都能拿到 globalThis.BadmintonSim，内核语料哈希相等；
 * - 模拟微信（vm 新上下文里预先定义 GameGlobal）时挂在 GameGlobal 上；
 * - sim.d.ts 能被 lib ES2017、types [] 的消费者通过 /// <reference path> 类型检查。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import ts from 'typescript';
import vm from 'node:vm';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { SIM_BANNER, buildSim, bundleSim, type BuildResult } from '../build';
import { fnv1aBytes } from '../fnv';
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
});

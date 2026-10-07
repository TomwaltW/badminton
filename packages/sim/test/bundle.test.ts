/**
 * 打包产物单测：用 buildSim 在临时目录构建 sim.js（不依赖预先构建的 packages/sim/dist），检查
 * - 末尾显式全局赋值：没有 GameGlobal 时挂到 globalThis，有 GameGlobal（微信）时挂到 GameGlobal；
 * - 以模块方式加载（顶层 var 不会成为全局）也能拿到 BadmintonSim；
 * - 打包产物跑内核语料与源码逐位相同（dsqrt 路径、Math.sqrt 路径），并在本机能找到的引擎上互比。
 *
 * 跨引擎的完整比对由 `bun run det --kernel` 负责；这里只用 100 拍做快速冒烟。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { buildSim } from '../../../tools/sim/build';
import { api, type BadmintonSimApi } from '../src/api';
import { fnvBytes, hex8 } from '../src/hash';
import { runKernel } from '../src/kernel';

const SHOTS = 100;

let dir = '';
let jsPath = '';
let code = '';
let simVer = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sim-bundle-test-'));
  const r = await buildSim({ outDir: dir, dts: false });
  jsPath = r.jsPath;
  simVer = r.simVer;
  code = readFileSync(jsPath, 'utf8');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 在全新的 vm 上下文里执行 sim.js，返回该上下文的全局对象。 */
function loadInContext(sandbox: Record<string, unknown>): Record<string, unknown> {
  createContext(sandbox);
  runInContext(code, sandbox, { filename: 'sim.js' });
  return sandbox;
}

/** 源码在本进程里的参考结果。 */
function sourceRef(): [number, number, number] {
  const d = runKernel({ shots: SHOTS, checkpoints: false });
  const m = runKernel({ shots: SHOTS, checkpoints: false, sqrt: Math.sqrt });
  return [d.hash, m.hash, d.steps];
}

/** 子进程里跑的探针脚本：加载 sim.js，打印 [typeof BadmintonSim, dsqrt 哈希, Math.sqrt 哈希, 步数]。 */
function probe(loader: string, out: string): string {
  return (
    `${loader}; var B = globalThis.BadmintonSim; ` +
    `var a = B.kernel.run({ shots: ${SHOTS}, checkpoints: false }); ` +
    `var b = B.kernel.run({ shots: ${SHOTS}, checkpoints: false, sqrt: Math.sqrt }); ` +
    `${out}(JSON.stringify([typeof B, a.hash, b.hash, a.steps]));`
  );
}

function runEngine(cmd: string[], env?: Record<string, string>): unknown {
  const r = Bun.spawnSync(cmd, { timeout: 60000, stdout: 'pipe', stderr: 'pipe', env: { ...process.env, ...env } });
  if (r.exitCode !== 0) throw new Error(`${cmd[0]} 退出码 ${r.exitCode}：${r.stderr.toString()}`);
  return JSON.parse(r.stdout.toString().trim());
}

const nodeBin = Bun.which('node');
const jscBin = Bun.which('jsc') ?? (existsSync('/usr/bin/jsc') ? '/usr/bin/jsc' : null);

describe('sim.js 产物', () => {
  test('simVer = 文件字节的 FNV-1a（与 sim.version 一致）', () => {
    const bytes = readFileSync(jsPath);
    expect(hex8(fnvBytes(new Uint8Array(bytes)))).toBe(simVer);
    expect(readFileSync(join(dir, 'sim.version'), 'utf8').trim()).toBe(simVer);
  });

  test('没有 GameGlobal 时挂到 globalThis', () => {
    const g = loadInContext({});
    expect(typeof g.BadmintonSim).toBe('object');
    const B = g.BadmintonSim as BadmintonSimApi;
    expect(Object.keys(B)).toEqual(Object.keys(api));
    expect(B.apiVersion).toBe(api.apiVersion);
  });

  test('有 GameGlobal（微信）时挂到 GameGlobal，不挂到 globalThis', () => {
    const gg: Record<string, unknown> = {};
    const g = loadInContext({ GameGlobal: gg });
    expect(typeof gg.BadmintonSim).toBe('object');
    expect(g.BadmintonSim).toBeUndefined();
  });

  test(`打包产物跑内核语料与源码逐位相同（${SHOTS} 拍，两条 sqrt 路径）`, () => {
    const B = loadInContext({}).BadmintonSim as BadmintonSimApi;
    const d = B.kernel.run({ shots: SHOTS });
    expect(d.hash).toBe(runKernel({ shots: SHOTS }).hash);
    expect(d.checkpoints).toEqual(runKernel({ shots: SHOTS }).checkpoints);
    expect(B.kernel.run({ shots: SHOTS, sqrt: Math.sqrt }).hash).toBe(runKernel({ shots: SHOTS, sqrt: Math.sqrt }).hash);
  });
});

describe('子进程按模块方式加载 sim.js，与源码互比', () => {
  test('bun（本测试所用的 bun，JSC JIT）', () => {
    const ref = sourceRef();
    const got = runEngine([process.execPath, '-e', probe(`require(${JSON.stringify(jsPath)})`, 'console.log')]);
    expect(got).toEqual(['object', ...ref]);
  });

  test('BUN_JSC_useJIT=0 bun（JSC 解释器）', () => {
    const ref = sourceRef();
    const got = runEngine([process.execPath, '-e', probe(`require(${JSON.stringify(jsPath)})`, 'console.log')], {
      BUN_JSC_useJIT: '0',
    });
    expect(got).toEqual(['object', ...ref]);
  });

  test.skipIf(!nodeBin)('node（V8；PATH 里找不到 node 时跳过）', () => {
    const ref = sourceRef();
    const got = runEngine([nodeBin!, '-e', probe(`require(${JSON.stringify(jsPath)})`, 'console.log')]);
    expect(got).toEqual(['object', ...ref]);
  });

  test.skipIf(!jscBin)('jsc --useJIT=false（JSC 命令行，仅测代码路径；找不到 jsc 时跳过）', () => {
    const ref = sourceRef();
    const got = runEngine([jscBin!, '--useJIT=false', '-e', probe(`load(${JSON.stringify(jsPath)})`, 'print')]);
    expect(got).toEqual(['object', ...ref]);
  });
});

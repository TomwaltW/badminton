/**
 * driver.js / boot.cjs 的测试：
 * - driver.js 只用 ES2017 语法（esbuild 按 es2017 与 esnext 转换结果相同 = 没有需要降级的语法）；
 * - 在"没有 process / console / performance、只有 print 与 arguments"的全新 vm 上下文里，
 *   把 sim.js 与 driver.js 当经典脚本依次执行：输出 @@DET@@ 行，哈希与源码直跑相同，计时退回 Date.now，JIT 未知；
 * - 未知参数、全局没有 BadmintonSim 时抛错；
 * - boot.cjs 在当前 bun 里能用 vm.runInThisContext 加载并给出 bun 的引擎信息与 JIT 探针。
 *
 * sim.js 用 buildSim 构建到临时目录，不依赖预先构建的 packages/sim/dist。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { transformSync } from 'esbuild';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createContext, runInContext } from 'node:vm';
import { buildSim } from '../../sim/build';
import { runKernel } from '../../../packages/sim/src/kernel';
import { BOOT_CJS, DRIVER_JS, parseDriverOutput } from '../runner';

const SHOTS = 40;
let dir = '';
let simPath = '';
let simCode = '';
const driverCode = readFileSync(DRIVER_JS, 'utf8');

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'det-driver-'));
  const r = await buildSim({ outDir: dir, dts: false });
  simPath = r.jsPath;
  simCode = readFileSync(simPath, 'utf8');
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

/** 只有 print 与 arguments 的全局（模拟 jsc 命令行）里依次执行 sim.js 与 driver.js，返回 print 的内容。 */
function runJscLike(args: string[], loadSim = true): string[] {
  const printed: string[] = [];
  const ctx = createContext({ print: (s: unknown) => printed.push(String(s)), arguments: args });
  if (loadSim) runInContext(simCode, ctx, { filename: 'sim.js' });
  runInContext(driverCode, ctx, { filename: 'driver.js' });
  return printed;
}

describe('driver.js', () => {
  test('只用 ES2017 语法', () => {
    const a = transformSync(driverCode, { target: 'es2017', loader: 'js' }).code;
    const b = transformSync(driverCode, { target: 'esnext', loader: 'js' }).code;
    expect(a).toBe(b);
  });

  test('没有 process / console 的环境：用 print 输出，哈希与源码直跑相同', () => {
    const printed = runJscLike(['--shots', String(SHOTS)]);
    expect(printed).toHaveLength(1);
    expect(printed[0]!.startsWith('@@DET@@ ')).toBe(true);
    const o = parseDriverOutput(printed[0]!);
    const d = runKernel({ shots: SHOTS });
    const m = runKernel({ shots: SHOTS, sqrt: Math.sqrt });
    expect(o.shots).toBe(SHOTS);
    expect(o.paths.dsqrt.hash).toBe(d.hash);
    expect(o.paths.dsqrt.steps).toBe(d.steps);
    expect(o.paths.dsqrt.checkpoints).toEqual(d.checkpoints);
    expect(o.paths.mathSqrt.hash).toBe(m.hash);
    expect(o.paths.mathSqrt.checkpoints).toEqual(m.checkpoints);
    expect(o.engine).toEqual({ hasProcess: false, arch: null, nodeVersion: null, bunVersion: null, webkitVersion: null, cwd: null });
    expect(o.jit).toBeNull();
    expect(o.dfgCompiles).toBeNull();
    expect(o.timer).toBe('Date.now');
    expect(o.cp).toEqual({ stride: 4, tick: 0, shotEnd: 1 });
    expect(o.corpusVersion).toBe(d.corpusVersion);
  });

  test('全局 numberOfDFGCompiles（jsc）：1000000 = JIT 关闭，其他 = 开启；preciseTime 计时', () => {
    for (const [ret, jit] of [
      [1000000, false],
      [0, true],
      [3, true],
    ] as const) {
      const printed: string[] = [];
      const seen: unknown[] = [];
      const ctx = createContext({
        print: (s: unknown) => printed.push(String(s)),
        arguments: ['--shots', '2'],
        preciseTime: () => 1,
        numberOfDFGCompiles: (f: unknown) => {
          seen.push(f);
          return ret;
        },
      });
      runInContext(simCode, ctx, { filename: 'sim.js' });
      runInContext(driverCode, ctx, { filename: 'driver.js' });
      const o = parseDriverOutput(printed[0]!);
      expect(o.jit).toBe(jit);
      expect(o.dfgCompiles).toBe(ret);
      expect(o.timer).toBe('preciseTime');
      // 探针作用于 BadmintonSim.flight.stepRk4
      const B = runInContext('BadmintonSim', ctx) as { flight: { stepRk4: unknown } };
      expect(seen).toEqual([B.flight.stepRk4]);
    }
  });

  test('--seed 生效；未知参数与非整数参数抛错', () => {
    const o = parseDriverOutput(runJscLike(['--shots', '5', '--seed', '7'])[0]!);
    expect(o.seed).toBe(7);
    expect(o.paths.dsqrt.hash).toBe(runKernel({ shots: 5, seed: 7 }).hash);
    expect(() => runJscLike(['--bogus'])).toThrow('未知参数 --bogus');
    expect(() => runJscLike(['--shots', 'x'])).toThrow('--shots 需要非负整数');
  });

  test('全局没有 BadmintonSim → 抛错', () => {
    expect(() => runJscLike([], false)).toThrow('全局没有 BadmintonSim');
  });
});

describe('boot.cjs', () => {
  test('当前 bun 里加载 sim.js + driver.js：bun 引擎信息、JIT 探针、哈希与源码相同', () => {
    const r = Bun.spawnSync({
      cmd: [process.execPath, BOOT_CJS, simPath, DRIVER_JS, '--shots', '30'],
      stdout: 'pipe',
      stderr: 'pipe',
      timeout: 60_000,
    });
    expect(r.exitCode).toBe(0);
    const o = parseDriverOutput(r.stdout.toString());
    expect(o.engine.bunVersion).toBe(Bun.version);
    expect(o.engine.webkitVersion).toBe(process.versions.webkit!);
    expect(o.engine.cwd).toBe(process.cwd());
    expect(o.engine.arch).toBe(process.arch);
    expect(o.engine.hasProcess).toBe(true);
    expect(typeof o.dfgCompiles).toBe('number');
    expect(o.timer).toBe('performance.now');
    expect(o.paths.dsqrt.hash).toBe(runKernel({ shots: 30 }).hash);
  });

  test('参数不足 → 退出码 2', () => {
    const r = Bun.spawnSync({ cmd: [process.execPath, BOOT_CJS], stdout: 'pipe', stderr: 'pipe' });
    expect(r.exitCode).toBe(2);
    expect(r.stderr.toString()).toContain('用法');
  });
});

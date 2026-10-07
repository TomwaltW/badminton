/**
 * det 集成测试（只在 linux 上跑；linux 档引擎不全时跳过并说明）：
 * 1. buildSim 到临时目录，det --kernel --profile linux --sim <临时 sim.js>：退出 0，三个引擎都出现，两条路径一致，
 *    DET 行与本进程直跑源码的 dsqrt 哈希、steps 相同；
 * 2. det --kernel --profile linux --fixture sin：用了 Math.sin 的夹具必须判红（非零退出、打印首个分歧）；
 * 3. 若有 /usr/bin/jsc：临时引擎清单把 jsc --useJIT=false（kind jsc）与 node 放在一起跑，
 *    验证 jsc 的加载与输出路径可用、JIT 判为关闭、哈希与 node 一致。
 *
 * 全部用默认 2000 拍（本机三引擎共约 1.5 秒）。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildSim } from '../../sim/build';
import { runKernel } from '../../../packages/sim/src/kernel';
import { hex8 } from '../compare';
import { loadEnginesConfig, resolveCommand, selectProfile } from '../config';
import { DEFAULT_ENGINES } from '../det';

const DET_TS = resolve(import.meta.dir, '..', 'det.ts');
const REPO = resolve(import.meta.dir, '..', '..', '..');
const TIMEOUT = 120_000;
const JSC = '/usr/bin/jsc';

const linux = process.platform === 'linux';
const linuxSpecs = linux ? selectProfile(loadEnginesConfig(DEFAULT_ENGINES), 'linux') : [];
const missing = linuxSpecs.flatMap((s) => resolveCommand(s, '/nonexistent-home').errors);
const canRun = linux && missing.length === 0;
if (!linux) console.warn('[det 集成测试] 跳过：只在 linux 上跑（当前平台 %s）', process.platform);
else if (!canRun) console.warn(`[det 集成测试] 跳过：linux 档引擎不全：\n  ${missing.join('\n  ')}`);
const nodeSpec = linuxSpecs.find((s) => s.name === 'node');
const canJsc = canRun && existsSync(JSC);
if (canRun && !canJsc) console.warn(`[det 集成测试] 跳过 jsc 用例：没有 ${JSC}`);

let dir = '';
let simPath = '';

beforeAll(async () => {
  if (!canRun) return;
  dir = mkdtempSync(join(tmpdir(), 'det-integration-'));
  simPath = (await buildSim({ outDir: dir, dts: false })).jsPath;
});

afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true });
});

function det(args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync({
    cmd: [process.execPath, DET_TS, ...args],
    cwd: REPO,
    stdout: 'pipe',
    stderr: 'pipe',
    timeout: TIMEOUT,
  });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe.skipIf(!canRun)('det --kernel（linux 档）', () => {
  test(
    '真实 sim：退出 0，三个引擎两条路径各自一致，DET 行与源码直跑相同',
    () => {
      const r = det(['--kernel', '--profile', 'linux', '--sim', simPath]);
      if (r.code !== 0) console.error(r.out, r.err);
      expect(r.code).toBe(0);
      for (const name of ['node', 'bun', 'bun-nojit']) expect(r.out).toMatch(new RegExp(`^${name} +x64 `, 'm'));
      expect(r.out).toMatch(/^bun +x64 +1\.4\.\S+ +开启 /m);
      expect(r.out).toMatch(/^bun-nojit +x64 +1\.4\.\S+ +关闭 /m);
      expect(r.out).toMatch(/^dsqrt 路径：一致——3 个引擎/m);
      expect(r.out).toMatch(/^Math\.sqrt 路径：一致——3 个引擎/m);
      expect(r.out).toContain('结论：通过');
      const ref = runKernel();
      expect(r.out).toContain(`\nDET ${hex8(ref.hash)} ${ref.steps}\n`);
    },
    TIMEOUT,
  );

  test(
    'Math.sin 夹具：判红、非零退出、打印首个分歧',
    () => {
      const r = det(['--kernel', '--profile', 'linux', '--fixture', 'sin']);
      // 1 = 跑完但不一致；2 是用法 / 构建 / 前置条件错误，不算"判红"
      expect(r.code).toBe(1);
      expect(r.out).toContain('首个分歧');
      expect(r.out).toContain('语料号（拍号）');
      expect(r.out).toMatch(/路径：不一致/);
      expect(r.out).toContain('结论：失败');
      // node（V8）与 bun（JSC）至少一条路径哈希不同
      const row = (name: string) => r.out.match(new RegExp(`^${name} +x64 +\\S+ +\\S+ +([0-9a-f]{8}) +([0-9a-f]{8}) `, 'm'));
      const n = row('node');
      const b = row('bun');
      expect(n).not.toBeNull();
      expect(b).not.toBeNull();
      expect(n![1] !== b![1] || n![2] !== b![2]).toBe(true);
    },
    TIMEOUT,
  );

  test(
    '引擎缺失、arch 不符：哈希虽一致也退出 1，并逐个列出失败原因',
    () => {
      const engines = join(dir, 'engines-bad.json');
      writeFileSync(
        engines,
        JSON.stringify({
          profiles: {
            t: [
              { name: 'node', kind: 'node', cmd: nodeSpec!.cmd, expect: { arch: 'x64' } },
              { name: 'node-wrong-arch', kind: 'node', cmd: nodeSpec!.cmd, expect: { arch: 'arm64' } },
              { name: 'ghost', kind: 'node', cmd: [join(dir, 'no-such-node')] },
              { name: 'relative', kind: 'node', cmd: ['node'] },
            ],
          },
        }),
      );
      const r = det(['--kernel', '--profile', 't', '--engines', engines, '--sim', simPath, '--shots', '20']);
      expect(r.code).toBe(1);
      expect(r.out).toContain('node-wrong-arch：arch 不符：期望 arm64，实际 x64');
      expect(r.out).toContain(`ghost：可执行文件不存在：${join(dir, 'no-such-node')}`);
      expect(r.out).toContain('relative：不是绝对路径：node');
      // 两个跑出结果的 node 互比一致，但结论仍是失败
      expect(r.out).toMatch(/^dsqrt 路径：一致——2 个引擎/m);
      expect(r.out).toContain('结论：失败——3 个引擎失败（node-wrong-arch、ghost、relative）');
      expect(r.out).toMatch(/^node +x64 .* 通过$/m);
      expect(r.out).toMatch(/^node-wrong-arch +x64 .* 失败$/m);
    },
    TIMEOUT,
  );

  test(
    '--json：机器可读结果',
    () => {
      const r = det(['--kernel', '--profile', 'linux', '--sim', simPath, '--shots', '200', '--json']);
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out) as {
        ok: boolean;
        shots: number;
        engines: { name: string; ok: boolean; jit: boolean | null; paths: Record<string, { hash: string }> }[];
        paths: Record<string, { consistent: boolean; baseline: string; hash: string }>;
        det: string;
      };
      expect(j.ok).toBe(true);
      expect(j.shots).toBe(200);
      expect(j.engines.map((e) => [e.name, e.ok, e.jit])).toEqual([
        ['node', true, null],
        ['bun', true, true],
        ['bun-nojit', true, false],
      ]);
      expect(j.paths.dsqrt!.consistent).toBe(true);
      expect(j.paths.mathSqrt!.consistent).toBe(true);
      expect(j.paths.dsqrt!.hash).toBe(hex8(runKernel({ shots: 200 }).hash));
      expect(j.det).toBe(`DET ${j.paths.dsqrt!.hash} ${runKernel({ shots: 200 }).steps}`);
      // 进度与表格写 stderr，stdout 只有 JSON
      expect(r.err).toContain('[det]');
    },
    TIMEOUT,
  );
});

describe.skipIf(!canJsc)('jsc 加载路径（/usr/bin/jsc，仅测代码路径，不属于任何 det 档）', () => {
  test(
    'jsc --useJIT=false 与 node 一起跑：退出 0，JIT 关闭，哈希一致',
    () => {
      const engines = join(dir, 'engines-jsc.json');
      writeFileSync(
        engines,
        JSON.stringify({
          profiles: {
            t: [
              { name: 'node', kind: 'node', cmd: nodeSpec!.cmd, expect: { arch: 'x64' } },
              { name: 'jsc-nojit', kind: 'jsc', cmd: [JSC, '--useJIT=false'], expect: { version: '', jit: false } },
            ],
          },
        }),
      );
      const r = det(['--kernel', '--profile', 't', '--engines', engines, '--sim', simPath, '--json']);
      if (r.code !== 0) console.error(r.out, r.err);
      expect(r.code).toBe(0);
      const j = JSON.parse(r.out) as {
        engines: { name: string; ok: boolean; jit: boolean | null; arch: string | null; version: string | null; paths: Record<string, { hash: string; steps: number }> }[];
        paths: Record<string, { consistent: boolean }>;
      };
      const [n, c] = j.engines;
      expect(c!.name).toBe('jsc-nojit');
      expect(c!.ok).toBe(true);
      expect(c!.jit).toBe(false);
      expect(c!.arch).toBeNull();
      for (const k of ['dsqrt', 'mathSqrt']) {
        expect(c!.paths[k]!.hash).toBe(n!.paths[k]!.hash);
        expect(c!.paths[k]!.steps).toBe(n!.paths[k]!.steps);
      }
      expect(c!.paths.dsqrt!.hash).toBe(hex8(runKernel().hash));
      expect(j.paths.dsqrt!.consistent).toBe(true);
      expect(j.paths.mathSqrt!.consistent).toBe(true);
      // jsc 没有 process.arch：表格的 arch 栏打印版本（这里读不到 Info.plist → 未知）
      expect(r.err).toMatch(/^jsc-nojit +未知 +未知 +关闭 /m);
    },
    TIMEOUT,
  );
});

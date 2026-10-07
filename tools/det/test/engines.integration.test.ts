/**
 * 用真实引擎验证 runner / det 的几处行为（bun 用当前进程的 process.execPath；node 取本平台档里的 node，
 * /usr/bin/jsc 存在时测 jsc；缺哪个跳过哪个）：
 * 1. sim.js 加载时抛错：失败原因带上错误行（node 的 Error 行后有 10 行栈，jsc 把异常写在 stdout），det 一并打印；
 * 2. sim 忽略 kernel.run 的 sqrt 选项（两条路径实际跑成同一条）：该引擎判失败，说明"注入的 Math.sqrt 没有生效"；
 *    拍数太少（< 32）时正确的 sim 也可能同哈希，不判失败、只提示；
 * 3. bun 一行的版本栏带 JSC 版本（process.versions.webkit 前 8 位），--json 带 webkit；
 * 4. 子进程跑在新建的空临时目录里：不是仓库根、结束后删除；调用方工作目录下的 bunfig.toml（preload）不生效。
 *
 * sim.js 用 buildSim 构建到临时目录，不依赖预先构建的 packages/sim/dist。
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { buildSim } from '../../sim/build';
import { runKernel } from '../../../packages/sim/src/kernel';
import { hex8 } from '../compare';
import { defaultProfile, loadEnginesConfig, resolveCommand, selectProfile, type EngineSpec } from '../config';
import { DEFAULT_ENGINES } from '../det';
import { runEngine } from '../runner';

const DET_TS = resolve(import.meta.dir, '..', 'det.ts');
const REPO = resolve(import.meta.dir, '..', '..', '..');
const TIMEOUT = 120_000;
const JSC = '/usr/bin/jsc';

const profile = defaultProfile(process.platform);
const nodeSpec: EngineSpec | undefined = profile
  ? selectProfile(loadEnginesConfig(DEFAULT_ENGINES), profile).find(
      (s) => s.kind === 'node' && resolveCommand(s, '/nonexistent-home').errors.length === 0,
    )
  : undefined;
if (!nodeSpec) console.warn('[det 引擎测试] 跳过 node 用例：本平台档里没有可用的 node');
const canJsc = existsSync(JSC);
if (!canJsc) console.warn(`[det 引擎测试] 跳过 jsc 用例：没有 ${JSC}`);

const bunSpec: EngineSpec = { name: 'bun', kind: 'bun', cmd: [process.execPath], env: {}, expect: {} };
const jscSpec: EngineSpec = { name: 'jsc', kind: 'jsc', cmd: [JSC, '--useJIT=false'], env: {}, expect: {} };

let dir = '';
let simPath = '';
let boomSim = '';
let noSqrtSim = '';

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'det-engines-'));
  simPath = (await buildSim({ outDir: dir, dts: false })).jsPath;
  boomSim = join(dir, 'boom-sim.js');
  writeFileSync(boomSim, 'throw new Error("sim 加载失败：boom");\n');
  // 真实 sim + 末尾一段经典脚本：把 BadmintonSim 换成 kernel.run 丢掉 sqrt 选项的版本（API 同形）
  noSqrtSim = join(dir, 'nosqrt-sim.js');
  writeFileSync(
    noSqrtSim,
    readFileSync(simPath, 'utf8') +
      [
        '(function (G) {',
        '  var B = G.BadmintonSim;',
        '  var run = B.kernel.run;',
        '  var kernel = Object.assign({}, B.kernel, {',
        '    run: function (o) {',
        '      var c = {};',
        "      for (var k in o) if (k !== 'sqrt') c[k] = o[k];",
        '      return run(c);',
        '    },',
        '  });',
        '  G.BadmintonSim = Object.assign({}, B, { kernel: kernel });',
        '})(globalThis);',
        '',
      ].join('\n'),
  );
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

/** 写一份临时引擎清单（档 t），返回路径。 */
function engines(fileName: string, specs: EngineSpec[]): string {
  const p = join(dir, fileName);
  writeFileSync(p, JSON.stringify({ profiles: { t: specs.map(({ name, kind, cmd }) => ({ name, kind, cmd })) } }));
  return p;
}

const run = (spec: EngineSpec, sim: string, driverArgs: string[] = []) =>
  runEngine(spec, { simPath: sim, driverArgs, home: '/nonexistent-home' });

describe('sim.js 加载时抛错：失败原因带上错误行', () => {
  test.skipIf(!nodeSpec)(
    'node：Error 行在 10 行栈之前，仍出现在失败原因里；det 打印错误行与 stderr 末尾',
    () => {
      const r = run(nodeSpec!, boomSim);
      expect(r.errors).toEqual(['退出码 1：Error: sim 加载失败：boom']);
      expect(r.stderrTail).toContain('Node.js v');
      const d = det(['--kernel', '--profile', 't', '--engines', engines('e-node.json', [{ ...nodeSpec!, name: 'node' }]), '--sim', boomSim]);
      expect(d.code).toBe(1);
      expect(d.out).toContain('  node：退出码 1：Error: sim 加载失败：boom');
      expect(d.out).toContain('stderr 末尾：');
    },
    TIMEOUT,
  );

  test(
    'bun：错误行（error: …）出现在失败原因里',
    () => {
      const r = run(bunSpec, boomSim);
      expect(r.errors).toEqual(['退出码 1：error: sim 加载失败：boom']);
    },
    TIMEOUT,
  );

  test.skipIf(!canJsc)(
    'jsc：异常写在 stdout、stderr 为空，失败原因与 det 输出仍带上异常行与 stdout 末尾',
    () => {
      const r = run(jscSpec, boomSim);
      expect(r.errors).toEqual(['退出码 3：Exception: Error: sim 加载失败：boom']);
      expect(r.stderrTail).toBe('');
      expect(r.stdoutTail).toContain('Exception: Error: sim 加载失败：boom');
      const d = det(['--kernel', '--profile', 't', '--engines', engines('e-jsc.json', [jscSpec]), '--sim', boomSim]);
      expect(d.code).toBe(1);
      expect(d.out).toContain('  jsc：退出码 3：Exception: Error: sim 加载失败：boom');
      expect(d.out).toContain('stdout 末尾（不含 @@DET@@ 行）：');
      expect(d.out).toContain('global code@');
    },
    TIMEOUT,
  );
});

describe('sim 忽略注入的 sqrt：两条路径同哈希即判失败', () => {
  test(
    'bun（以及可用时的 node）：退出 1，说明注入的 Math.sqrt 没有生效；正确的 sim 照常通过',
    () => {
      const specs = nodeSpec ? [bunSpec, { ...nodeSpec, name: 'node' }] : [bunSpec];
      const file = engines('e-sqrt.json', specs);
      const bad = det(['--kernel', '--profile', 't', '--engines', file, '--sim', noSqrtSim, '--shots', '200']);
      expect(bad.code).toBe(1);
      const h = hex8(runKernel({ shots: 200 }).hash);
      for (const s of specs) {
        expect(bad.out).toContain(`  ${s.name}：dsqrt 路径与 Math.sqrt 路径哈希相同（${h}）：注入的 Math.sqrt 没有生效`);
        // 表格里两列哈希相同
        expect(bad.out).toMatch(new RegExp(`^${s.name} .* ${h} +${h} .* 失败$`, 'm'));
      }
      expect(bad.out).toContain('结论：失败');
      const good = det(['--kernel', '--profile', 't', '--engines', file, '--sim', simPath, '--shots', '200']);
      expect(good.code).toBe(0);
    },
    TIMEOUT,
  );

  test(
    '拍数太少（默认种子下 1 拍两条路径本来就同哈希）：不判失败，打印提示',
    () => {
      expect(runKernel({ shots: 1 }).hash).toBe(runKernel({ shots: 1, sqrt: Math.sqrt }).hash);
      const d = det(['--kernel', '--profile', 't', '--engines', engines('e-one.json', [bunSpec]), '--sim', simPath, '--shots', '1']);
      expect(d.code).toBe(0);
      expect(d.out).toContain('注：拍数 1 < 32，没有检查"注入的 Math.sqrt 是否生效"');
    },
    TIMEOUT,
  );
});

describe('bun 一行带 JSC 版本', () => {
  test(
    '版本栏为"<bun 版本>（WebKit <前 8 位>）"，--json 带完整 webkit',
    () => {
      const webkit = process.versions.webkit!;
      expect(webkit).toMatch(/^[0-9a-f]{8,}/);
      const file = engines('e-bun.json', [bunSpec]);
      const t = det(['--kernel', '--profile', 't', '--engines', file, '--sim', simPath, '--shots', '40']);
      expect(t.code).toBe(0);
      expect(t.out).toContain(`${Bun.version}（WebKit ${webkit.slice(0, 8)}）`);
      const j = det(['--kernel', '--profile', 't', '--engines', file, '--sim', simPath, '--shots', '40', '--json']);
      expect(j.code).toBe(0);
      const o = JSON.parse(j.out) as { engines: { name: string; version: string; webkit: string | null }[] };
      expect(o.engines[0]).toMatchObject({ name: 'bun', version: Bun.version, webkit });
    },
    TIMEOUT,
  );
});

describe('子进程的工作目录', () => {
  test(
    'bun：process.cwd() 是新建的临时目录（不是仓库根，结束后已删除）；调用方目录下的 bunfig.toml preload 不生效',
    () => {
      // 调用方的工作目录里放一个带 preload 的 bunfig.toml：子进程若继承这个工作目录，preload 就会注入代码
      const caller = join(dir, 'caller');
      mkdirSync(caller);
      const preload = join(caller, 'preload.js');
      writeFileSync(preload, 'globalThis.__detPreloaded = true; console.error("PRELOAD 生效");\n');
      writeFileSync(join(caller, 'bunfig.toml'), `preload = [${JSON.stringify(preload)}]\n`);
      const prev = process.cwd();
      process.chdir(caller);
      let r: ReturnType<typeof run>;
      try {
        r = run(bunSpec, simPath, ['--shots', '5']);
      } finally {
        process.chdir(prev);
      }
      expect(r.errors).toEqual([]);
      expect(r.stderrTail).not.toContain('PRELOAD');
      const cwd = r.output!.engine.cwd!;
      expect(cwd).not.toBe(REPO);
      expect(cwd).not.toBe(caller);
      expect(basename(cwd)).toStartWith('det-cwd-');
      expect(existsSync(cwd)).toBe(false);
    },
    TIMEOUT,
  );
});

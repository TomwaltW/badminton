/**
 * gate 的测试：子进程运行器、步骤运行器（依赖跳过、前置检查、实时 / 安静输出）、步骤构造，
 * 以及在一个假仓库根上端到端跑 runGate（假的 tsc / eslint / sim:build / sim:scan / det，真的 bun test），
 * 同时实测 bun test 的路径参数语义：./packages ./tools 只扫这两个目录，.worktrees/ 与别处同名目录都不扫。
 * 不在测试里跑真实仓库的 gate（会递归）。
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import {
  DEFAULT_ROOT,
  buildGateSteps,
  formatSummary,
  main,
  parseGateArgs,
  runGate,
  runSteps,
  type GateStep,
  type StepResult,
} from '../gate';
import { runCommand } from '../run';

const GATE_TS = resolve(import.meta.dir, '..', 'gate.ts');
const BUN = process.execPath;

const tmpDirs: string[] = [];
function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), `gate-test-${prefix}-`));
  tmpDirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

function put(root: string, rel: string, content: string, exec = false): void {
  const p = join(root, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, content);
  if (exec) chmodSync(p, 0o755);
}

describe('runCommand', () => {
  test('合并捕获 stdout 与 stderr、退出码、实时回调、中文不被截断', async () => {
    const chunks: string[] = [];
    const r = await runCommand(['sh', '-c', 'echo 标准输出; echo 标准错误 >&2; exit 3'], {
      cwd: tmpdir(),
      onOutput: (s) => chunks.push(s),
    });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain('标准输出\n');
    expect(r.output).toContain('标准错误\n');
    expect(chunks.join('')).toBe(r.output);
    expect(r.timedOut).toBe(false);
    expect(r.durationMs).toBeGreaterThan(0);
  });

  test('找不到可执行文件 → 退出码 127，不抛错', async () => {
    const r = await runCommand(['/nonexistent/definitely-not-here'], { cwd: tmpdir() });
    expect(r.exitCode).toBe(127);
    expect(r.error).toContain('找不到可执行文件');
    expect(r.output).toContain('ENOENT');
  });

  test('超时 → 终止进程，退出码 128 + SIGTERM', async () => {
    const r = await runCommand(['sh', '-c', 'echo 开始; exec sleep 5'], { cwd: tmpdir(), timeoutMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.signal).toBe('SIGTERM');
    expect(r.exitCode).toBe(128 + 15);
    expect(r.output).toContain('超时');
  });

  test('环境变量传给子进程', async () => {
    const r = await runCommand(['sh', '-c', 'echo "v=$GATE_TEST_VAR"'], { cwd: tmpdir(), env: { ...process.env, GATE_TEST_VAR: '甲' } });
    expect(r.output).toBe('v=甲\n');
  });
});

const sh = (id: string, script: string, extra: Partial<GateStep> = {}): GateStep => ({
  id,
  title: id,
  cmd: ['sh', '-c', script],
  ...extra,
});

describe('runSteps', () => {
  test('某步失败不影响后续；needs 未满足则跳过；前置检查失败不启动进程', async () => {
    let out = '';
    const results = await runSteps(
      [
        sh('a', 'echo 甲; exit 0', { summarize: () => '要点甲' }),
        sh('build', 'echo 构建失败; exit 4'),
        sh('scan', 'echo 不该运行', { needs: ['build'] }),
        sh('c', 'echo 丙'),
        sh('d', 'echo 不该运行', { precheck: () => '找不到工具' }),
      ],
      { cwd: tmpdir(), write: (s) => void (out += s) },
    );
    expect(results.map((r) => [r.id, r.status, r.exitCode])).toEqual([
      ['a', 'pass', 0],
      ['build', 'fail', 4],
      ['scan', 'skip', null],
      ['c', 'pass', 0],
      ['d', 'fail', null],
    ]);
    expect(results[0]!.note).toBe('要点甲');
    expect(results[2]!.note).toContain('build 没有通过');
    expect(out).not.toContain('不该运行');
    // 实时输出与每步的标题、结果行
    expect(out).toContain('━━ [1/5] a ━━');
    expect(out).toContain('$ sh -c');
    expect(out).toContain('甲\n');
    expect(out).toContain('── build：失败（退出码 4，耗时');
    expect(out).toContain('找不到工具');
  });

  test('--quiet：成功的步骤不打印输出，失败的打印完整输出', async () => {
    let out = '';
    await runSteps([sh('ok', 'echo 成功的输出'), sh('bad', 'echo 失败的输出; exit 1')], {
      cwd: tmpdir(),
      quiet: true,
      write: (s) => void (out += s),
    });
    expect(out).not.toContain('\n成功的输出\n'); // 只出现在命令行回显里
    expect(out).toContain('── 完整输出 ──\n失败的输出\n');
  });

  test('formatSummary：汇总表与结论行', () => {
    const r = (id: string, status: StepResult['status'], note = '', output = ''): StepResult => ({
      id,
      title: id === 'test' ? 'bun test' : id,
      cmd: [],
      status,
      exitCode: status === 'skip' ? null : status === 'pass' ? 0 : 1,
      durationMs: 1500,
      note,
      output,
    });
    const ok = formatSummary([r('tsc', 'pass', '无类型错误'), r('test', 'pass', '', ' 7 pass\n 0 fail\nRan 7 tests across 2 files.\n')], 3000);
    expect(ok[0]).toMatch(/^步骤\s+结果\s+耗时\s+退出码\s+要点$/);
    expect(ok.at(-1)).toBe('gate：通过（2/2 步，总耗时 3.0 秒；测试 7 通过 / 0 失败）');
    const bad = formatSummary([r('tsc', 'fail'), r('sim:build', 'fail'), r('det', 'skip')], 3000);
    expect(bad.at(-1)).toBe('gate：失败（失败：tsc、sim:build；跳过：det；总耗时 3.0 秒）');
  });
});

describe('buildGateSteps 与参数', () => {
  test('顺序、命令与 --profile 透传', () => {
    const root = DEFAULT_ROOT;
    const steps = buildGateSteps(root, { bun: '/x/bun', profile: 'mac' });
    expect(steps.map((s) => s.id)).toEqual(['tsc', 'eslint', 'test', 'sim:build', 'sim:scan', 'det']);
    expect(steps[0]!.cmd).toEqual([join(root, 'node_modules/.bin/tsc'), '-b']);
    expect(steps[1]!.cmd).toEqual([join(root, 'node_modules/.bin/eslint'), '.']);
    expect(steps[2]!.cmd).toEqual(['/x/bun', 'test', './packages', './tools']);
    expect(steps[3]!.cmd).toEqual(['/x/bun', 'run', 'sim:build']);
    expect(steps[4]!.cmd).toEqual(['/x/bun', 'run', 'sim:scan']);
    expect(steps[4]!.needs).toEqual(['sim:build']);
    expect(steps[5]!.cmd).toEqual(['/x/bun', 'run', 'det', '--kernel', '--profile', 'mac']);
    expect(steps[5]!.needs).toEqual(['sim:build']);
    expect(buildGateSteps(root, { bun: '/x/bun' })[5]!.cmd).toEqual(['/x/bun', 'run', 'det', '--kernel']);
  });

  test('要点：ESLint 崩溃与"无问题"区分开；det 失败时给出结论', () => {
    const steps = buildGateSteps(DEFAULT_ROOT, { bun: '/x/bun' });
    const eslint = steps[1]!.summarize!;
    expect(eslint('', 0)).toBe('无问题');
    expect(eslint('Oops! Something went wrong!\n', 2)).toBe('ESLint 异常退出（见输出）');
    const det = steps[5]!.summarize!;
    expect(det('结论：失败——1 个引擎失败（bun）\nDET efc2c7f7 98311\n', 1)).toBe('失败——1 个引擎失败（bun）；DET efc2c7f7 98311');
    expect(det('[det] 找不到 sim.js\n', 2)).toBe('');
  });

  test('没装依赖时 tsc / eslint 的前置检查给出提示', () => {
    const empty = tmp('empty');
    const steps = buildGateSteps(empty, { bun: BUN });
    expect(steps[0]!.precheck!()).toContain('bun install');
    expect(steps[1]!.precheck!()).toContain('node_modules/.bin/eslint');
    expect(steps[2]!.precheck!()).toContain('无测试可跑');
  });

  test('parseGateArgs', () => {
    expect(parseGateArgs([])).toEqual({ profile: null, quiet: false, help: false });
    expect(parseGateArgs(['--profile', 'linux', '-q'])).toEqual({ profile: 'linux', quiet: true, help: false });
    expect(parseGateArgs(['--profile=mac'])).toMatchObject({ profile: 'mac' });
    expect(() => parseGateArgs(['--profile'])).toThrow('需要一个值');
    expect(() => parseGateArgs(['--bogus'])).toThrow('未知参数');
  });

  test('main：--help 退出 0，参数错误退出 2（不跑任何步骤）', async () => {
    let text = '';
    const io = { out: (s: string) => void (text += s), err: (s: string) => void (text += s) };
    expect(await main(['--help'], io)).toBe(0);
    expect(await main(['--nope'], io)).toBe(2);
    expect(text).toContain('未知参数 --nope');
    const cli = spawnSync(BUN, [GATE_TS, '--bogus'], { encoding: 'utf8' });
    expect(cli.status).toBe(2);
    expect(cli.stderr).toContain('用法：bun run gate');
  });
});

/** 假的工具链：标志文件 <名字>-red 存在时该步失败。 */
function fakeRoot(): string {
  const root = tmp('root');
  const fake = (name: string, okLine: string, badLines: string, code: number) =>
    `#!/bin/sh\necho "fake ${name} $*"\nif [ -f "${name}-red" ]; then\n${badLines}\nexit ${code}\nfi\n${okLine}\n`;
  put(root, 'node_modules/.bin/tsc', fake('tsc', ':', `echo "src/a.ts(1,7): error TS2322: Type 'string' is not assignable to type 'number'."`, 2), true);
  put(root, 'node_modules/.bin/eslint', fake('eslint', ':', `echo "/x/a.ts\n  1:1  error  坏  no-restricted-syntax\n\n✖ 1 problem (1 error, 0 warnings)"`, 1), true);
  put(root, 'fake/sim-build.sh', fake('sim-build', 'echo "[sim:build] packages/sim/dist/sim.js  1234 字节  simVer=0123abcd"', 'echo "[sim:build] 失败：坏了"', 1));
  put(root, 'fake/sim-scan.sh', fake('sim-scan', 'echo "[sim:scan] 1 个文件，0 处违规"', 'echo "[sim:scan] 1 个文件，2 处违规"', 1));
  put(
    root,
    'fake/det.sh',
    fake('det', 'echo "结论：通过——linux 档 3 个引擎一致"\necho "DET efc2c7f7 98311"', 'echo "结论：失败——bun-nojit 与 node 不一致"\necho "DET efc2c7f7 98311"', 1),
  );
  put(
    root,
    'package.json',
    JSON.stringify({
      name: 'gate-sandbox',
      private: true,
      scripts: { 'sim:build': 'sh ./fake/sim-build.sh', 'sim:scan': 'sh ./fake/sim-scan.sh', det: 'sh ./fake/det.sh' },
    }),
  );
  const okTest = (n: number) =>
    `import { expect, test } from 'bun:test';\n${Array.from({ length: n }, (_, i) => `test('t${i}', () => expect(1).toBe(1));`).join('\n')}\n`;
  const badTest = `import { expect, test } from 'bun:test';\ntest('不该被扫到', () => expect(1).toBe(2));\n`;
  put(root, 'packages/a/test/a.test.ts', okTest(2));
  put(root, 'tools/b/test/b.test.ts', okTest(1));
  // 这些都不该被 gate 的 bun test 扫到：别的工作树、别处同名的 packages 目录、名字含 packages 的目录
  put(root, '.worktrees/task-t9/packages/w/test/w.test.ts', badTest);
  put(root, 'other/packages/o/test/o.test.ts', badTest);
  put(root, 'xpackages/x.test.ts', badTest);
  return root;
}

describe('runGate（假仓库根，端到端）', () => {
  test('全绿：6 步全部通过、退出码 0；bun test 只扫 ./packages ./tools（3 条）', async () => {
    const root = fakeRoot();
    let out = '';
    const rep = await runGate({ root, bun: BUN, write: (s) => void (out += s) });
    expect(rep.results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'tsc:pass',
      'eslint:pass',
      'test:pass',
      'sim:build:pass',
      'sim:scan:pass',
      'det:pass',
    ]);
    expect(rep.exitCode).toBe(0);
    const notes = Object.fromEntries(rep.results.map((r) => [r.id, r.note]));
    expect(notes.test).toBe('3 通过 / 0 失败（3 条，2 个文件）');
    expect(notes['sim:build']).toBe('simVer=0123abcd，1234 字节');
    expect(notes['sim:scan']).toBe('1 个文件，0 处违规');
    expect(notes.det).toBe('DET efc2c7f7 98311');
    expect(out).toContain('fake tsc -b');
    expect(out).toContain('fake eslint .');
    expect(out).toContain('fake det --kernel\n'); // 不给 --profile 时不传
    expect(out).toContain('━━ gate 汇总 ━━');
    expect(out).toContain('gate：通过（6/6 步');
    expect(out).toContain('测试 3 通过 / 0 失败');
    expect(out).not.toContain('不该被扫到');
  });

  test('对照实验：不带 ./ 的参数是子串过滤，会扫进 other/packages 与 xpackages（所以 gate 必须带 ./）', () => {
    const root = fakeRoot();
    const withDot = spawnSync(BUN, ['test', './packages', './tools'], { cwd: root, encoding: 'utf8' });
    expect(`${withDot.stdout}${withDot.stderr}`).toContain('Ran 3 tests across 2 files.');
    const noDot = spawnSync(BUN, ['test', 'packages', 'tools'], { cwd: root, encoding: 'utf8' });
    expect(noDot.status).not.toBe(0);
    expect(`${noDot.stdout}${noDot.stderr}`).toContain('不该被扫到');
  });

  test('--profile 透传给 det；tsc 红时后续步骤照跑', async () => {
    const root = fakeRoot();
    writeFileSync(join(root, 'tsc-red'), '');
    let out = '';
    const rep = await runGate({ root, bun: BUN, profile: 'mac', write: (s) => void (out += s) });
    expect(out).toContain('fake det --kernel --profile mac');
    expect(rep.results.map((r) => r.status)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(rep.results[0]!.exitCode).toBe(2);
    expect(rep.results[0]!.note).toBe('1 个类型错误');
    expect(rep.exitCode).toBe(1);
    expect(out).toContain('gate：失败（失败：tsc -b；');
    unlinkSync(join(root, 'tsc-red'));
  });

  test('sim:build 失败 → 跳过 sim:scan 与 det，退出码 1；--quiet 只打印失败步骤的输出', async () => {
    const root = fakeRoot();
    writeFileSync(join(root, 'sim-build-red'), '');
    writeFileSync(join(root, 'eslint-red'), '');
    let out = '';
    const rep = await runGate({ root, bun: BUN, quiet: true, write: (s) => void (out += s) });
    expect(rep.results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'tsc:pass',
      'eslint:fail',
      'test:pass',
      'sim:build:fail',
      'sim:scan:skip',
      'det:skip',
    ]);
    expect(rep.exitCode).toBe(1);
    expect(rep.results[1]!.note).toBe('1 个错误、0 个警告');
    expect(out).not.toContain('fake tsc -b'); // 成功步骤的输出不打印
    expect(out).toContain('[sim:build] 失败：坏了');
    expect(out).not.toContain('fake sim-scan');
    expect(out).not.toContain('fake det');
    expect(out).toContain('gate：失败（失败：ESLint 禁令、sim:build；跳过：sim:scan、det --kernel；');
  });

  test('bun test 有失败：解析出失败条数，gate 判红', async () => {
    const root = fakeRoot();
    put(root, 'tools/b/test/c.test.ts', `import { expect, test } from 'bun:test';\ntest('红', () => expect(1).toBe(2));\n`);
    const rep = await runGate({ root, bun: BUN, quiet: true, write: () => {} });
    const t = rep.results.find((r) => r.id === 'test')!;
    expect(t.status).toBe('fail');
    expect(t.note).toBe('3 通过 / 1 失败（4 条，3 个文件）');
    expect(rep.exitCode).toBe(1);
  });
});

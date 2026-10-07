/**
 * gate 的测试：子进程运行器、步骤运行器（依赖跳过、前置检查、实时 / 安静输出）、步骤构造，
 * 以及在一个假仓库根上端到端跑 runGate（假的 tsc / eslint / contracts:gen / sim:build / sim:scan / det，真的 bun test），
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
  type Runner,
  type StepResult,
} from '../gate';
import { runCommand, type RunResult } from '../run';

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

  test('步骤的 env 合并进运行环境（同名时步骤的优先），其他步骤不受影响', async () => {
    const results = await runSteps(
      [
        sh('with', 'echo "$GATE_A-$GATE_B"', { env: { GATE_B: '乙', GATE_A: '步骤的甲' } }),
        sh('without', 'echo "$GATE_A-$GATE_B"'),
      ],
      { cwd: tmpdir(), quiet: true, write: () => {}, env: { ...process.env, GATE_A: '甲' } },
    );
    expect(results.map((r) => r.output)).toEqual(['步骤的甲-乙\n', '甲-\n']);
  });

  test('check：退出码 0 也可判失败，要点换成说明，--quiet 时打印完整输出', async () => {
    let out = '';
    const results = await runSteps(
      [
        sh('ok', 'echo 好', { check: () => null, summarize: () => '要点' }),
        sh('trunc', 'echo 半截输出', { check: (o) => (o.includes('摘要') ? null : '没有摘要'), summarize: () => '要点' }),
        sh('red', 'exit 3', { check: () => '不该被调用' }),
      ],
      { cwd: tmpdir(), quiet: true, write: (s) => void (out += s) },
    );
    expect(results.map((r) => [r.id, r.status, r.exitCode, r.note])).toEqual([
      ['ok', 'pass', 0, '要点'],
      ['trunc', 'fail', 0, '没有摘要'],
      ['red', 'fail', 3, ''],
    ]);
    expect(out).toContain('── trunc：失败（退出码 0，耗时');
    expect(out).toContain('── 完整输出 ──\n半截输出\n');
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
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    expect(steps.map((s) => s.id)).toEqual(['tsc', 'eslint', 'contracts', 'test', 'sim:build', 'sim:scan', 'det']);
    // tsc 全量重查（--force）：增量构建在依赖类型变化时可能不重查，假绿
    expect(byId.tsc!.cmd).toEqual([join(root, 'node_modules/.bin/tsc'), '-b', '--force']);
    expect(byId.eslint!.cmd).toEqual([join(root, 'node_modules/.bin/eslint'), '.']);
    expect(byId.contracts!.title).toBe('契约偏移');
    expect(byId.contracts!.cmd).toEqual(['/x/bun', 'run', 'contracts:gen', '--check']);
    expect(byId.test!.cmd).toEqual(['/x/bun', 'test', './packages', './tools']);
    // bun 在 CI 下遇到 .only 直接失败
    expect(byId.test!.env).toEqual({ CI: 'true' });
    expect(byId.test!.check).toBeDefined();
    expect(byId['sim:build']!.cmd).toEqual(['/x/bun', 'run', 'sim:build']);
    expect(byId['sim:scan']!.cmd).toEqual(['/x/bun', 'run', 'sim:scan']);
    expect(byId['sim:scan']!.needs).toEqual(['sim:build']);
    expect(byId.det!.cmd).toEqual(['/x/bun', 'run', 'det', '--kernel', '--profile', 'mac']);
    expect(byId.det!.needs).toEqual(['sim:build']);
    expect(buildGateSteps(root, { bun: '/x/bun' }).at(-1)!.cmd).toEqual(['/x/bun', 'run', 'det', '--kernel']);
  });

  test('要点：ESLint 崩溃与"无问题"区分开；契约偏移一致 / 不一致；det 失败时给出结论', () => {
    const steps = buildGateSteps(DEFAULT_ROOT, { bun: '/x/bun' });
    const byId = Object.fromEntries(steps.map((s) => [s.id, s]));
    const eslint = byId.eslint!.summarize!;
    expect(eslint('', 0)).toBe('无问题');
    expect(eslint('Oops! Something went wrong!\n', 2)).toBe('ESLint 异常退出（见输出）');
    const contracts = byId.contracts!.summarize!;
    expect(contracts('contracts:gen --check：packages/contracts/src/gen/snapshot-offsets.ts 与 schema 一致（I32 38 槽，F64 96 槽）\n', 0)).toBe(
      '与 schema 一致（I32 38 槽，F64 96 槽）',
    );
    expect(
      contracts('contracts:gen --check：packages/contracts/src/gen/snapshot-offsets.ts 与 snapshot.schema.ts 不一致或缺失；请运行 bun run contracts:gen 并提交生成文件\n', 1),
    ).toBe('生成文件与 schema 不一致或缺失（运行 bun run contracts:gen 并提交）');
    expect(contracts('error: Script not found "contracts:gen"\n', 1)).toBe('');
    const det = byId.det!.summarize!;
    expect(det('结论：失败——1 个引擎失败（bun）\nDET efc2c7f7 98311\n', 1)).toBe('失败——1 个引擎失败（bun）；DET efc2c7f7 98311');
    expect(det('[det] 找不到 sim.js\n', 2)).toBe('');
  });

  test('没装依赖时 tsc / eslint 的前置检查给出提示', () => {
    const empty = tmp('empty');
    const byId = Object.fromEntries(buildGateSteps(empty, { bun: BUN }).map((s) => [s.id, s]));
    expect(byId.tsc!.precheck!()).toContain('bun install');
    expect(byId.eslint!.precheck!()).toContain('node_modules/.bin/eslint');
    expect(byId.test!.precheck!()).toContain('无测试可跑');
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
  put(
    root,
    'fake/contracts.sh',
    fake(
      'contracts',
      'echo "contracts:gen --check：packages/contracts/src/gen/snapshot-offsets.ts 与 schema 一致（I32 38 槽，F64 96 槽）"',
      'echo "contracts:gen --check：packages/contracts/src/gen/snapshot-offsets.ts 与 snapshot.schema.ts 不一致或缺失；请运行 bun run contracts:gen 并提交生成文件" >&2',
      1,
    ),
  );
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
      scripts: {
        'contracts:gen': 'sh ./fake/contracts.sh',
        'sim:build': 'sh ./fake/sim-build.sh',
        'sim:scan': 'sh ./fake/sim-scan.sh',
        det: 'sh ./fake/det.sh',
      },
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
  test('全绿：7 步全部通过、退出码 0；bun test 只扫 ./packages ./tools（3 条）', async () => {
    const root = fakeRoot();
    let out = '';
    const rep = await runGate({ root, bun: BUN, write: (s) => void (out += s) });
    expect(rep.results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'tsc:pass',
      'eslint:pass',
      'contracts:pass',
      'test:pass',
      'sim:build:pass',
      'sim:scan:pass',
      'det:pass',
    ]);
    expect(rep.exitCode).toBe(0);
    const notes = Object.fromEntries(rep.results.map((r) => [r.id, r.note]));
    expect(notes.contracts).toBe('与 schema 一致（I32 38 槽，F64 96 槽）');
    expect(notes.test).toBe('3 通过 / 0 失败（3 条，2 个文件）');
    expect(notes['sim:build']).toBe('simVer=0123abcd，1234 字节');
    expect(notes['sim:scan']).toBe('1 个文件，0 处违规');
    expect(notes.det).toBe('DET efc2c7f7 98311');
    expect(out).toContain('fake tsc -b --force\n');
    expect(out).toContain('fake eslint .');
    expect(out).toContain('fake contracts --check\n'); // bun run 把 --check 透传给脚本
    expect(out).toContain('fake det --kernel\n'); // 不给 --profile 时不传
    expect(out).toContain('━━ gate 汇总 ━━');
    expect(out).toContain('gate：通过（7/7 步');
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
    expect(rep.results.map((r) => r.status)).toEqual(['fail', 'pass', 'pass', 'pass', 'pass', 'pass', 'pass']);
    expect(rep.results[0]!.exitCode).toBe(2);
    expect(rep.results[0]!.note).toBe('1 个类型错误');
    expect(rep.exitCode).toBe(1);
    expect(out).toContain('gate：失败（失败：tsc -b --force；');
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
      'contracts:pass',
      'test:pass',
      'sim:build:fail',
      'sim:scan:skip',
      'det:skip',
    ]);
    expect(rep.exitCode).toBe(1);
    expect(rep.results[1]!.note).toBe('1 个错误、0 个警告');
    expect(out).not.toContain('fake tsc -b --force'); // 成功步骤的输出不打印
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

  test('契约偏移不一致：该步失败、要点给出处理办法，bun test 等后续步骤照跑', async () => {
    const root = fakeRoot();
    writeFileSync(join(root, 'contracts-red'), '');
    let out = '';
    const rep = await runGate({ root, bun: BUN, quiet: true, write: (s) => void (out += s) });
    expect(rep.results.map((r) => `${r.id}:${r.status}`)).toEqual([
      'tsc:pass',
      'eslint:pass',
      'contracts:fail',
      'test:pass',
      'sim:build:pass',
      'sim:scan:pass',
      'det:pass',
    ]);
    expect(rep.results[2]!.note).toBe('生成文件与 schema 不一致或缺失（运行 bun run contracts:gen 并提交）');
    expect(rep.exitCode).toBe(1);
    expect(out).toContain('gate：失败（失败：契约偏移；');
  });

  test('测试里的 process.exit(0) 截断整套测试：bun 退出 0 且没有摘要 → gate 判红（真 bun）', async () => {
    const root = fakeRoot();
    put(
      root,
      'tools/b/test/exit.test.ts',
      `import { expect, test } from 'bun:test';\ntest('x', () => { process.exit(0); });\ntest('本该失败', () => expect(1).toBe(2));\n`,
    );
    // 先实测 bun 的行为：退出 0、没有摘要
    const raw = spawnSync(BUN, ['test', './tools/b/test/exit.test.ts'], { cwd: root, encoding: 'utf8' });
    expect(raw.status).toBe(0);
    expect(`${raw.stdout}${raw.stderr}`).not.toContain('Ran ');
    let out = '';
    const rep = await runGate({ root, bun: BUN, quiet: true, write: (s) => void (out += s) });
    const t = rep.results.find((r) => r.id === 'test')!;
    expect(t.exitCode).toBe(0);
    expect(t.status).toBe('fail');
    expect(t.note).toBe('没有测试摘要（可能被 process.exit 截断）');
    expect(rep.exitCode).toBe(1);
    expect(out).toContain('── bun test：失败（退出码 0，');
    expect(out).toContain('gate：失败（失败：bun test；');
  });

  test('漏删的 test.only：gate 以 CI=true 跑 bun test，.only 直接失败（即使外层环境没有 CI）', async () => {
    const root = fakeRoot();
    put(
      root,
      'tools/b/test/only.test.ts',
      `import { expect, test } from 'bun:test';\ntest.only('只跑我', () => expect(1).toBe(1));\ntest('被静默跳过', () => expect(1).toBe(2));\n`,
    );
    const env = { ...process.env };
    delete env.CI;
    // 对照：不设 CI 时 bun 只跑 .only 那条，同文件其他测试静默不跑，退出 0
    const raw = spawnSync(BUN, ['test', './tools/b/test/only.test.ts'], { cwd: root, env, encoding: 'utf8' });
    expect(raw.status).toBe(0);
    const rep = await runGate({ root, bun: BUN, quiet: true, write: () => {}, env });
    const t = rep.results.find((r) => r.id === 'test')!;
    expect(t.status).toBe('fail');
    expect(t.exitCode).not.toBe(0);
    expect(t.output).toContain('.only is disabled in CI');
    expect(rep.exitCode).toBe(1);
  });
});

describe('bun test 步骤的判定（注入的假命令）', () => {
  /** 注入的运行器：bun test 步骤返回给定的退出码与输出，其余步骤一律退出 0。 */
  const fakeRunner =
    (testCode: number, testOut: string, seen: { env?: NodeJS.ProcessEnv }[] = []): Runner =>
    (cmd, opts) => {
      const isTest = cmd[1] === 'test';
      if (isTest) seen.push({ env: opts.env });
      const r: RunResult = {
        exitCode: isTest ? testCode : 0,
        signal: null,
        output: isTest ? testOut : '',
        durationMs: 1,
        timedOut: false,
        error: null,
      };
      return Promise.resolve(r);
    };
  const gateWith = (code: number, out: string, seen?: { env?: NodeJS.ProcessEnv }[]) =>
    runGate({ root: fakeRoot(), bun: '/x/bun', quiet: true, write: () => {}, runner: fakeRunner(code, out, seen), env: { PATH: '/bin' } });

  const cases: [string, number, string, 'pass' | 'fail', string][] = [
    ['正常：有摘要、0 失败、至少 1 条', 0, ' 3 pass\n 0 fail\nRan 3 tests across 2 files. [5.00ms]\n', 'pass', '3 通过 / 0 失败（3 条，2 个文件）'],
    ['退出 0 但没有摘要（process.exit 截断）', 0, 'bun test v1.4.2 (744846f84)\n', 'fail', '没有测试摘要（可能被 process.exit 截断）'],
    ['退出 0 但没有任何输出', 0, '', 'fail', '没有测试摘要（可能被 process.exit 截断）'],
    ['退出 0 但摘要里有失败', 0, ' 2 pass\n 1 fail\nRan 3 tests across 1 file.\n', 'fail', '2 通过 / 1 失败（3 条，1 个文件）；退出码 0 却有失败'],
    ['退出 0 但一条测试都没跑', 0, ' 0 pass\n 0 fail\nRan 0 tests across 0 files.\n', 'fail', '0 通过 / 0 失败（0 条，0 个文件）；一条测试都没跑'],
    ['退出 0 但摘要缺 Ran 行', 0, ' 3 pass\n 0 fail\n', 'fail', '3 通过 / 0 失败；摘要缺少 "Ran N tests" 行（输出可能被截断）'],
    ['退出非 0（照旧判红）', 1, ' 2 pass\n 1 fail\nRan 3 tests across 1 file.\n', 'fail', '2 通过 / 1 失败（3 条，1 个文件）'],
  ];
  for (const [name, code, out, status, note] of cases) {
    test(name, async () => {
      const rep = await gateWith(code, out);
      const t = rep.results.find((r) => r.id === 'test')!;
      expect([t.status, t.exitCode, t.note]).toEqual([status, code, note]);
      expect(rep.exitCode).toBe(status === 'pass' ? 0 : 1);
    });
  }

  test('bun test 以 CI=true 启动，其余环境照常继承', async () => {
    const seen: { env?: NodeJS.ProcessEnv }[] = [];
    await gateWith(0, ' 1 pass\n 0 fail\nRan 1 test across 1 file.\n', seen);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.env).toEqual({ PATH: '/bin', CI: 'true' });
  });
});

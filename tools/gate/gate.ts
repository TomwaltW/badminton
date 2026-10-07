/**
 * bun run gate [--profile linux|mac] [--quiet]：门禁总入口（计划 4.2、6 章；派单 A 第 7 项）。
 *
 * 按顺序跑：
 *   1. tsc -b                      node_modules/.bin/tsc（全仓库工程引用）
 *   2. ESLint 禁令                  node_modules/.bin/eslint .
 *   3. bun test                    只跑 ./packages 与 ./tools 下的测试。路径参数以 ./ 开头时 bun 按路径前缀
 *                                  匹配；不带 ./ 的参数是"文件路径子串过滤"，会把 .worktrees/task-xx/packages/…
 *                                  也算进来（bun 1.4.2 实测，见 tools/gate/test/gate.test.ts）。
 *   4. bun run sim:build
 *   5. bun run sim:scan            sim:build 没通过则跳过
 *   6. bun run det --kernel        sim:build 没通过则跳过；--profile 原样透传，不给则由 det 按平台选档
 * 每步打印标题、实时输出（--quiet 时只在失败时打印完整输出）、耗时与退出码；某步失败不影响后续步骤
 * （除上面的依赖），最后打印汇总表。全部通过退出 0，否则 1；参数错误退出 2。
 *
 * 根目录取本文件所在的工作树（tools/gate/../..），与当前目录无关：在主干或任一 .worktrees/task-xx 里
 * 运行 bun run gate，查的都是那个工作树自己。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import {
  clip,
  formatBunTest,
  parseBunTest,
  parseDet,
  parseEslint,
  parseSimBuild,
  parseSimScan,
  parseTsc,
  type BunTestSummary,
} from './parse';
import { bunBin, formatCmd, formatDuration, renderTable, runCommand, type RunOptions, type RunResult } from './run';

/** 本文件所在工作树的根。 */
export const DEFAULT_ROOT = resolve(import.meta.dir, '..', '..');

/** bun test 只扫这些目录（相对根，传参时加 ./ 前缀）。 */
export const TEST_DIRS = ['packages', 'tools'] as const;

export type StepStatus = 'pass' | 'fail' | 'skip';

export interface GateStep {
  id: string;
  title: string;
  cmd: string[];
  /** 这些步骤（按 id）没有通过时跳过本步。 */
  needs?: string[];
  /** 启动前的检查：返回说明文字则本步直接判失败、不启动进程。 */
  precheck?: () => string | null;
  /** 从输出与退出码提取要点（汇总表的"要点"列）。 */
  summarize?: (output: string, exitCode: number) => string;
}

export interface StepResult {
  id: string;
  title: string;
  cmd: string[];
  status: StepStatus;
  /** 跳过或前置检查失败时为 null。 */
  exitCode: number | null;
  durationMs: number;
  note: string;
  output: string;
}

export type Runner = (cmd: readonly string[], opts: RunOptions) => Promise<RunResult>;

export interface RunStepsOptions {
  cwd: string;
  /** true：不实时转发输出，只在失败时打印完整输出。 */
  quiet?: boolean;
  write?: (s: string) => void;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
}

const RULE = '━━';

/** 把命令里位于根目录下的绝对路径显示成相对路径。 */
function displayCmd(cmd: readonly string[], root: string): string {
  return formatCmd(
    cmd.map((a, i) => {
      if (!isAbsolute(a) || (i === 0 && a === process.execPath)) return a;
      const rel = relative(root, a);
      return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) ? rel : a;
    }),
  );
}

/** 依次跑步骤：打印标题、（实时或失败时）输出、结果行。 */
export async function runSteps(steps: readonly GateStep[], opts: RunStepsOptions): Promise<StepResult[]> {
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const runner = opts.runner ?? runCommand;
  const results: StepResult[] = [];
  const passed = new Set<string>();

  for (let i = 0; i < steps.length; i++) {
    const step = steps[i]!;
    write(`\n${RULE} [${i + 1}/${steps.length}] ${step.title} ${RULE}\n`);

    const unmet = (step.needs ?? []).filter((id) => !passed.has(id));
    if (unmet.length > 0) {
      const note = `跳过：${unmet.join('、')} 没有通过`;
      write(`${note}\n`);
      results.push({ id: step.id, title: step.title, cmd: step.cmd, status: 'skip', exitCode: null, durationMs: 0, note, output: '' });
      continue;
    }

    const pre = step.precheck?.() ?? null;
    if (pre !== null) {
      write(`${pre}\n── ${step.title}：失败（未启动）\n`);
      results.push({ id: step.id, title: step.title, cmd: step.cmd, status: 'fail', exitCode: null, durationMs: 0, note: pre, output: pre });
      continue;
    }

    write(`$ ${displayCmd(step.cmd, opts.cwd)}\n`);
    let endsWithNewline = true;
    const r = await runner(step.cmd, {
      cwd: opts.cwd,
      env: opts.env,
      onOutput: opts.quiet
        ? undefined
        : (chunk) => {
            write(chunk);
            endsWithNewline = chunk.endsWith('\n');
          },
    });
    const ok = r.exitCode === 0;
    if (opts.quiet && !ok) {
      write(`── 完整输出 ──\n${r.output}`);
      endsWithNewline = r.output.length === 0 || r.output.endsWith('\n');
    }
    if (!endsWithNewline) write('\n');

    let note = '';
    try {
      note = step.summarize?.(r.output, r.exitCode) ?? '';
    } catch (e) {
      note = `（解析输出失败：${(e as Error).message}）`;
    }
    if (r.timedOut) note = note ? `超时；${note}` : '超时';
    if (r.error && !note) note = r.error;

    write(`── ${step.title}：${ok ? '通过' : '失败'}（退出码 ${r.exitCode}，耗时 ${formatDuration(r.durationMs)}）${note ? `  ${note}` : ''}\n`);
    if (ok) passed.add(step.id);
    results.push({
      id: step.id,
      title: step.title,
      cmd: step.cmd,
      status: ok ? 'pass' : 'fail',
      exitCode: r.exitCode,
      durationMs: r.durationMs,
      note,
      output: r.output,
    });
  }
  return results;
}

export interface GateStepsOptions {
  bun?: string;
  /** det 的 --profile；null / 省略 = 不传，由 det 按平台选档。 */
  profile?: string | null;
}

function needBin(root: string, bin: string): () => string | null {
  return () =>
    existsSync(bin) ? null : `找不到 ${relative(root, bin)}：请先在 ${root} 运行 bun install（--frozen-lockfile）`;
}

/** 构造门禁步骤（顺序即执行顺序）。 */
export function buildGateSteps(root: string, opts: GateStepsOptions = {}): GateStep[] {
  const bun = opts.bun ?? bunBin();
  const tsc = resolve(root, 'node_modules/.bin/tsc');
  const eslint = resolve(root, 'node_modules/.bin/eslint');
  const testDirs = TEST_DIRS.filter((d) => existsSync(resolve(root, d))).map((d) => `./${d}`);
  const profileArgs = opts.profile ? ['--profile', opts.profile] : [];

  return [
    {
      id: 'tsc',
      title: 'tsc -b',
      cmd: [tsc, '-b'],
      precheck: needBin(root, tsc),
      summarize: (out, code) => {
        const n = parseTsc(out);
        return n > 0 ? `${n} 个类型错误` : code === 0 ? '无类型错误' : '';
      },
    },
    {
      id: 'eslint',
      title: 'ESLint 禁令',
      cmd: [eslint, '.'],
      precheck: needBin(root, eslint),
      summarize: (out, code) => {
        const s = parseEslint(out);
        if (s.problems > 0) return `${s.errors} 个错误、${s.warnings} 个警告`;
        return code === 0 ? '无问题' : 'ESLint 异常退出（见输出）';
      },
    },
    {
      id: 'test',
      title: 'bun test',
      cmd: [bun, 'test', ...testDirs],
      precheck: () => (testDirs.length > 0 ? null : `没有 ${TEST_DIRS.join('/、')}/ 目录，无测试可跑`),
      summarize: (out) => {
        const s = parseBunTest(out);
        return s ? formatBunTest(s) : '没有解析到测试摘要';
      },
    },
    {
      id: 'sim:build',
      title: 'sim:build',
      cmd: [bun, 'run', 'sim:build'],
      summarize: (out) => {
        const s = parseSimBuild(out);
        return s ? `simVer=${s.simVer}，${s.bytes} 字节` : '';
      },
    },
    {
      id: 'sim:scan',
      title: 'sim:scan',
      cmd: [bun, 'run', 'sim:scan'],
      needs: ['sim:build'],
      summarize: (out) => {
        const s = parseSimScan(out);
        return s ? `${s.files} 个文件，${s.violations} 处违规` : '';
      },
    },
    {
      id: 'det',
      title: `det --kernel${opts.profile ? ` --profile ${opts.profile}` : ''}`,
      cmd: [bun, 'run', 'det', '--kernel', ...profileArgs],
      needs: ['sim:build'],
      summarize: (out, code) => {
        const s = parseDet(out);
        if (!s) return '';
        const det = s.hash ? `DET ${s.hash} ${s.steps}` : '';
        if (code === 0) return det;
        return clip([s.conclusion ?? '', det].filter((x) => x.length > 0).join('；'), 80);
      },
    },
  ];
}

/** 汇总里 bun test 的摘要（没有该步或解析不到时为 null）。 */
export function testSummaryOf(results: readonly StepResult[]): BunTestSummary | null {
  const t = results.find((r) => r.id === 'test');
  return t && t.status !== 'skip' ? parseBunTest(t.output) : null;
}

const STATUS_TEXT: Record<StepStatus, string> = { pass: '通过', fail: '失败', skip: '跳过' };

/** 汇总表 + 结论行。 */
export function formatSummary(results: readonly StepResult[], totalMs: number): string[] {
  const rows = [
    ['步骤', '结果', '耗时', '退出码', '要点'],
    ...results.map((r) => [
      r.title,
      STATUS_TEXT[r.status],
      r.status === 'skip' ? '-' : formatDuration(r.durationMs),
      r.exitCode === null ? '-' : String(r.exitCode),
      r.note,
    ]),
  ];
  const lines = renderTable(rows, new Set([2, 3]));
  const failed = results.filter((r) => r.status === 'fail').map((r) => r.title);
  const skipped = results.filter((r) => r.status === 'skip').map((r) => r.title);
  const passed = results.filter((r) => r.status === 'pass').length;
  const t = testSummaryOf(results);
  const tests = t ? `；测试 ${t.pass} 通过 / ${t.fail} 失败` : '';
  lines.push('');
  if (failed.length === 0 && skipped.length === 0) {
    lines.push(`gate：通过（${passed}/${results.length} 步，总耗时 ${formatDuration(totalMs)}${tests}）`);
  } else {
    const why = [`失败：${failed.join('、') || '无'}`];
    if (skipped.length > 0) why.push(`跳过：${skipped.join('、')}`);
    lines.push(`gate：失败（${why.join('；')}；总耗时 ${formatDuration(totalMs)}${tests}）`);
  }
  return lines;
}

export interface GateOptions {
  root?: string;
  profile?: string | null;
  quiet?: boolean;
  write?: (s: string) => void;
  bun?: string;
  runner?: Runner;
  env?: NodeJS.ProcessEnv;
}

export interface GateReport {
  ok: boolean;
  exitCode: number;
  results: StepResult[];
  totalMs: number;
}

/** 工作树的分支与短 sha（拿不到就返回空串，不影响门禁）。 */
function describeHead(root: string): string {
  const git = (args: string[]) => spawnSync('git', args, { cwd: root, encoding: 'utf8' });
  const sha = git(['rev-parse', '--short', 'HEAD']);
  if (sha.status !== 0) return '';
  const br = git(['symbolic-ref', '--quiet', '--short', 'HEAD']);
  return `${br.status === 0 ? br.stdout.trim() : '分离 HEAD'} @ ${sha.stdout.trim()}`;
}

export async function runGate(opts: GateOptions = {}): Promise<GateReport> {
  const root = resolve(opts.root ?? DEFAULT_ROOT);
  const write = opts.write ?? ((s: string) => void process.stdout.write(s));
  const bun = opts.bun ?? bunBin();
  const head = describeHead(root);
  write(
    `gate：${root}${head ? `（${head}）` : ''}，bun ${process.versions.bun ?? '?'}` +
      `${opts.profile ? `，det 档 ${opts.profile}` : '，det 档按平台'}\n`,
  );
  const t0 = performance.now();
  const steps = buildGateSteps(root, { bun, profile: opts.profile ?? null });
  const results = await runSteps(steps, { cwd: root, quiet: opts.quiet, write, runner: opts.runner, env: opts.env });
  const totalMs = performance.now() - t0;
  write(`\n${RULE} gate 汇总 ${RULE}\n${formatSummary(results, totalMs).join('\n')}\n`);
  const ok = results.every((r) => r.status === 'pass');
  return { ok, exitCode: ok ? 0 : 1, results, totalMs };
}

export interface GateArgs {
  profile: string | null;
  quiet: boolean;
  help: boolean;
}

export const USAGE = [
  '用法：bun run gate [--profile linux|mac] [--quiet]',
  '',
  '  --profile <档>   透传给 det --kernel（默认不传，由 det 按平台选档）',
  '  --quiet, -q      不实时转发各步输出，只在失败时打印完整输出',
  '',
  '依次跑 tsc -b、ESLint、bun test（./packages ./tools）、sim:build、sim:scan、det --kernel。',
  '退出码：0 全部通过；1 有步骤失败或被跳过；2 参数错误。',
].join('\n');

export function parseGateArgs(argv: readonly string[]): GateArgs {
  const a: GateArgs = { profile: null, quiet: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') a.help = true;
    else if (arg === '-q' || arg === '--quiet') a.quiet = true;
    else if (arg === '--profile') {
      const v = argv[++i];
      if (v === undefined || v.startsWith('-')) throw new Error('--profile 需要一个值（linux | mac）');
      a.profile = v;
    } else if (arg.startsWith('--profile=')) {
      const v = arg.slice('--profile='.length);
      if (v.length === 0) throw new Error('--profile 需要一个值（linux | mac）');
      a.profile = v;
    } else throw new Error(`未知参数 ${arg}`);
  }
  return a;
}

export async function main(
  argv: readonly string[],
  io: { out: (s: string) => void; err: (s: string) => void } = {
    out: (s) => void process.stdout.write(s),
    err: (s) => void process.stderr.write(s),
  },
): Promise<number> {
  let args: GateArgs;
  try {
    args = parseGateArgs(argv);
  } catch (e) {
    io.err(`[gate] ${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  if (args.help) {
    io.out(`${USAGE}\n`);
    return 0;
  }
  const report = await runGate({ profile: args.profile, quiet: args.quiet, write: io.out });
  return report.exitCode;
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[gate] 意外错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(1);
    },
  );
}

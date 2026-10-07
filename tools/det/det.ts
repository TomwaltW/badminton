/**
 * bun run det --kernel [--profile linux|mac]：确定性门禁（计划 6 章、派单 A 第 3–4 项）。
 *
 * 用 packages/sim/dist/sim.js（不是源码）在一档引擎上依次跑内核语料的 dsqrt 路径与 Math.sqrt 路径，
 * 跨引擎互比、不存期望值：每条路径以第一个成功的引擎为基准，比较哈希、steps 与整个检查点序列，
 * 不一致时打印首个分歧的语料号（拍号）、全局 tick、检查点种类与双方哈希。
 *
 * 任一引擎的两条路径哈希相同（拍数 ≥ 32 时）即判该引擎失败：说明注入的 Math.sqrt 没有生效。
 *
 * 退出码：0 = 全部引擎通过且两条路径各自一致；1 = 有引擎失败或不一致；
 *         2 = 用法 / 配置 / 前置条件错误（参数不对、engines.json 坏、sim.js 不存在或过期、尚未实现的模式）。
 *
 * 参数见 usage()；说明见 tools/det/README.md。
 */
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { REPO_ROOT, SIM_DIR, SIM_JS, SIM_VERSION_FILE } from '../sim/paths';
import { fnv1aBytes } from '../sim/fnv';
import {
  ConfigError,
  defaultProfile,
  jitLabel,
  loadEnginesConfig,
  selectProfile,
  type EngineInfo,
  type EngineSpec,
} from './config';
import { firstDivergence, formatDivergence, hex8, type CheckpointRecord, type Divergence } from './compare';
import {
  DET_DIR,
  ENGINE_TIMEOUT_MS,
  PATH_KEYS,
  PATH_LABEL,
  SQRT_CHECK_MIN_SHOTS,
  runEngine,
  type DriverPath,
  type EngineResult,
  type PathKey,
} from './runner';

export const DEFAULT_ENGINES = resolve(DET_DIR, 'engines.json');

/** 默认 sim 路径的前置检查用到的位置（可注入，单测用临时目录验证"不存在 / 比源码旧 / 版本文件不符"）。 */
export interface SimPaths {
  /** 默认要跑的 sim.js（packages/sim/dist/sim.js）。 */
  simJs: string;
  /** 决定 sim.js 内容的输入：目录（递归取其中的 .ts）或单个文件；任何一个比 simJs 新即判过期。不存在的项跳过。 */
  sources: string[];
  /** sim:build 写的 sim.version。 */
  versionFile: string;
}

/**
 * 默认的陈旧检查输入：模拟核心源码、sim 经相对路径打包进来的 contracts 运行时代码，
 * 以及决定产物形状的构建脚本（build.ts、paths.ts）。
 */
export const DEFAULT_SIM_SOURCES: readonly string[] = [
  join(SIM_DIR, 'src'),
  join(REPO_ROOT, 'packages/contracts/src'),
  resolve(DET_DIR, '../sim/build.ts'),
  resolve(DET_DIR, '../sim/paths.ts'),
];

export const DEFAULT_SIM_PATHS: SimPaths = { simJs: SIM_JS, sources: [...DEFAULT_SIM_SOURCES], versionFile: SIM_VERSION_FILE };
export const FIXTURES: Record<string, string> = { sin: resolve(DET_DIR, 'fixtures/sin-entry.ts') };

export interface DetArgs {
  kernel: boolean;
  matches: boolean;
  rollback: boolean;
  profile: string | null;
  sim: string | null;
  engines: string | null;
  shots: number | null;
  fixture: string | null;
  json: boolean;
  help: boolean;
}

export class UsageError extends Error {
  override name = 'UsageError';
}

export function usage(): string {
  return [
    '用法：bun run det --kernel [选项]',
    '',
    '  --kernel             跑内核语料（飞行 + 随机数 + 哈希），必需',
    '  --profile <档>       引擎档：linux | mac（默认按平台：darwin → mac，linux → linux）',
    '  --sim <路径>         要跑的 sim.js（默认 packages/sim/dist/sim.js，并检查它不比源码旧）',
    '  --engines <文件>     引擎清单（默认 tools/det/engines.json）',
    '  --shots <N>          拍数（默认用 sim 的 DEFAULT_SHOTS，即 2000）',
    '  --fixture sin        自测：构建"用了 Math.sin 的模拟"夹具并对它跑门禁（应当判红）',
    '  --json               只向 stdout 输出机器可读的 JSON（进度写 stderr）',
    '  --matches <N>        尚未实现（计划 11-10：1,000 局）',
    '  --rollback           尚未实现（计划 10-27）',
    '',
    '退出码：0 通过；1 有引擎失败或跨引擎不一致；2 用法 / 配置 / 前置条件错误。',
  ].join('\n');
}

/** 解析命令行。支持 --flag value 与 --flag=value。 */
export function parseArgs(argv: string[]): DetArgs {
  const a: DetArgs = {
    kernel: false,
    matches: false,
    rollback: false,
    profile: null,
    sim: null,
    engines: null,
    shots: null,
    fixture: null,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i]!;
    let inline: string | null = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq > 0) {
      inline = arg.slice(eq + 1);
      arg = arg.slice(0, eq);
    }
    const value = (): string => {
      if (inline !== null) return inline;
      const v = argv[++i];
      if (v === undefined || v.startsWith('--')) throw new UsageError(`${arg} 需要一个值`);
      return v;
    };
    /** 开关参数不带值：--json=false 之类的写法直接报错，免得被当成"打开"。 */
    const flag = (): true => {
      if (inline !== null) throw new UsageError(`${arg} 不带值（收到 ${argv[i]}）`);
      return true;
    };
    switch (arg) {
      case '--kernel':
        a.kernel = flag();
        break;
      case '--matches':
        a.matches = true;
        if (inline === null && argv[i + 1] !== undefined && !argv[i + 1]!.startsWith('--')) i++;
        break;
      case '--rollback':
        a.rollback = flag();
        break;
      case '--profile':
        a.profile = value();
        break;
      case '--sim':
        a.sim = value();
        break;
      case '--engines':
        a.engines = value();
        break;
      case '--shots': {
        const v = value();
        if (!/^\d+$/.test(v) || Number(v) < 1 || Number(v) > 1_000_000) {
          throw new UsageError(`--shots 需要 1..1000000 的整数，收到 ${v}`);
        }
        a.shots = Number(v);
        break;
      }
      case '--fixture':
        a.fixture = value();
        break;
      case '--json':
        a.json = flag();
        break;
      case '-h':
      case '--help':
        a.help = flag();
        break;
      default:
        throw new UsageError(`未知参数 ${argv[i]}`);
    }
  }
  return a;
}

/**
 * sources 里比 sim.js 新的文件（相对仓库根，排序去重）：目录递归取其中的 .ts，文件直接比较（不限扩展名），
 * 不存在的项跳过。
 */
export function staleSources(simJs: string, sources: readonly string[]): string[] {
  const t = statSync(simJs).mtimeMs;
  const out = new Set<string>();
  for (const src of sources) {
    if (!existsSync(src)) continue;
    if (!statSync(src).isDirectory()) {
      if (statSync(src).mtimeMs > t) out.add(relative(REPO_ROOT, src));
      continue;
    }
    for (const rel of readdirSync(src, { recursive: true }) as string[]) {
      if (!rel.endsWith('.ts')) continue;
      const p = join(src, rel);
      if (statSync(p).mtimeMs > t) out.add(relative(REPO_ROOT, p));
    }
  }
  return [...out].sort();
}

/** 显示宽度：CJK 与全角字符算 2。 */
function width(s: string): number {
  let w = 0;
  for (const ch of s) w += ch.codePointAt(0)! >= 0x2e80 ? 2 : 1;
  return w;
}

/** 对齐成表；right 里的列右对齐。 */
function table(rows: string[][], right: ReadonlySet<number> = new Set()): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, width(c))));
  return rows.map((r) =>
    r
      .map((c, i) => {
        const fill = ' '.repeat(Math.max(0, widths[i]! - width(c)));
        if (right.has(i)) return fill + c;
        return i === r.length - 1 ? c : c + fill;
      })
      .join('  ')
      .trimEnd(),
  );
}

function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

function stepsPerSec(p: DriverPath): number {
  return p.ms > 0 ? p.steps / (p.ms / 1000) : 0;
}

/** 仓库内的路径显示为相对路径，仓库外的显示绝对路径。 */
function shown(p: string): string {
  const rel = relative(REPO_ROOT, p);
  return rel === '' || rel.startsWith('..') ? p : rel;
}

function indent(text: string, n: number): string {
  const sp = ' '.repeat(n);
  return text
    .split('\n')
    .map((l) => sp + l)
    .join('\n');
}

export interface PathSummary {
  key: PathKey;
  baseline: EngineResult | null;
  divergences: { engine: EngineResult; d: Divergence }[];
  consistent: boolean;
}

/**
 * 一条路径的互比：以第一个成功（能跑且符合期望）的引擎为基准；都不成功时退回第一个有输出的引擎。
 * 期望不符但有输出的引擎照样参与互比（它已经记为失败，互比结果只是多一份信息）。
 */
export function comparePath(key: PathKey, results: EngineResult[]): PathSummary {
  const ran = results.filter((r) => r.output !== null);
  const baseline = ran.find((r) => r.errors.length === 0) ?? ran[0] ?? null;
  const divergences: PathSummary['divergences'] = [];
  if (baseline) {
    const layout = baseline.output!.cp;
    const base = baseline.output!.paths[key];
    for (const r of ran) {
      if (r === baseline) continue;
      const d = firstDivergence(base, r.output!.paths[key], layout);
      if (d) divergences.push({ engine: r, d });
    }
  }
  return { key, baseline, divergences, consistent: baseline !== null && divergences.length === 0 };
}

function recordJson(r: CheckpointRecord | null): unknown {
  return r ? { index: r.index, kind: r.kind, shot: r.shot, tick: r.tick, hash: hex8(r.hash) } : null;
}

interface Ctx {
  args: DetArgs;
  profile: string;
  enginesFile: string;
  simPath: string;
  simVer: string;
  simBytes: number;
}

function buildJson(ctx: Ctx, results: EngineResult[], paths: PathSummary[], ok: boolean, detLine: string): unknown {
  const first = results.find((r) => r.output)?.output ?? null;
  return {
    ok,
    exitCode: ok ? 0 : 1,
    profile: ctx.profile,
    enginesFile: ctx.enginesFile,
    sim: { path: ctx.simPath, simVer: ctx.simVer, bytes: ctx.simBytes, fixture: ctx.args.fixture },
    shots: first ? first.shots : ctx.args.shots,
    corpusVersion: first ? first.corpusVersion : null,
    apiVersion: first ? first.apiVersion : null,
    engines: results.map((r) => ({
      name: r.spec.name,
      kind: r.spec.kind,
      cmd: r.cmd,
      env: r.spec.env,
      ok: r.errors.length === 0,
      errors: r.errors,
      arch: r.info ? r.info.arch : null,
      version: r.info ? r.info.version : null,
      webkit: r.info ? r.info.webkit : null,
      jit: r.info ? r.info.jit : null,
      dfgCompiles: r.output ? r.output.dfgCompiles : null,
      timer: r.output ? r.output.timer : null,
      wallMs: Math.round(r.wallMs),
      stderrTail: r.output ? '' : r.stderrTail,
      stdoutTail: r.stdoutTail,
      paths: r.output
        ? Object.fromEntries(
            PATH_KEYS.map((k) => {
              const p = r.output!.paths[k];
              return [
                k,
                {
                  hash: hex8(p.hash),
                  steps: p.steps,
                  substeps: p.substeps,
                  ms: Math.round(p.ms * 10) / 10,
                  stepsPerSec: Math.round(stepsPerSec(p)),
                  checkpoints: p.checkpoints.length / r.output!.cp.stride,
                },
              ];
            }),
          )
        : null,
    })),
    paths: Object.fromEntries(
      paths.map((s) => {
        const b = s.baseline?.output?.paths[s.key] ?? null;
        return [
          s.key,
          {
            consistent: s.consistent,
            baseline: s.baseline ? s.baseline.spec.name : null,
            hash: b ? hex8(b.hash) : null,
            steps: b ? b.steps : null,
            checkpoints: b ? b.checkpoints.length / s.baseline!.output!.cp.stride : null,
            divergences: s.divergences.map(({ engine, d }) => ({
              engine: engine.spec.name,
              reason: d.reason,
              index: d.index,
              base: recordJson(d.base),
              other: recordJson(d.other),
              prev: recordJson(d.prev),
              baseHash: hex8(d.baseHash),
              otherHash: hex8(d.otherHash),
              baseSteps: d.baseSteps,
              otherSteps: d.otherSteps,
            })),
          },
        ];
      }),
    ),
    det: detLine,
  };
}

/**
 * 版本一栏：按 kind 取的版本；bun 再附内置 JSC 的版本（process.versions.webkit 的前 8 位），
 * 计划 6 章要求每行打印 JSC 版本（jsc 一行的版本本身就是 Info.plist 的 JSC 版本）。
 */
export function versionLabel(kind: EngineSpec['kind'], info: EngineInfo | null): string {
  if (!info) return '-';
  const ver = info.version ?? '未知';
  if (kind !== 'bun') return ver;
  return `${ver}（WebKit ${info.webkit ? info.webkit.slice(0, 8) : '未知'}）`;
}

/** 引擎表的一行。jsc 没有 process.arch，arch 一栏打印版本。 */
function engineRow(r: EngineResult): string[] {
  const o = r.output;
  const info = r.info;
  const ver = info ? (info.version ?? '未知') : '-';
  const arch = !info ? '-' : r.spec.kind === 'jsc' ? ver : (info.arch ?? '未知');
  return [
    r.spec.name,
    arch,
    versionLabel(r.spec.kind, info),
    info ? jitLabel(info.jit) : '-',
    o ? hex8(o.paths.dsqrt.hash) : '-',
    o ? hex8(o.paths.mathSqrt.hash) : '-',
    o ? String(o.paths.dsqrt.steps) : '-',
    o ? fmtInt(stepsPerSec(o.paths.dsqrt)) : '-',
    r.errors.length === 0 ? '通过' : '失败',
  ];
}

/** 跑门禁；返回退出码。simPaths 只在单测里替换。 */
export async function main(argv: string[], simPaths: SimPaths = DEFAULT_SIM_PATHS): Promise<number> {
  let args: DetArgs;
  try {
    args = parseArgs(argv);
  } catch (e) {
    console.error(`[det] ${(e as Error).message}\n\n${usage()}`);
    return 2;
  }
  if (args.help) {
    console.log(usage());
    return 0;
  }
  if (args.matches || args.rollback) {
    const which = [args.matches ? '--matches' : '', args.rollback ? '--rollback' : ''].filter(Boolean).join('、');
    console.error(`[det] ${which} 尚未实现（计划 10-27 / 11-10）：--rollback 10-27，--matches 1,000 局 11-10`);
    return 2;
  }
  if (!args.kernel) {
    console.error(`[det] 需要 --kernel（目前只实现了内核语料）\n\n${usage()}`);
    return 2;
  }

  const out = args.json ? (s: string) => process.stderr.write(`${s}\n`) : (s: string) => console.log(s);
  const err = (s: string) => console.error(s);

  const profile = args.profile ?? defaultProfile(process.platform);
  if (!profile) {
    err(`[det] 平台 ${process.platform} 没有默认档，请用 --profile 指定`);
    return 2;
  }
  const enginesFile = resolve(args.engines ?? DEFAULT_ENGINES);
  let specs: EngineSpec[];
  try {
    specs = selectProfile(loadEnginesConfig(enginesFile), profile);
  } catch (e) {
    if (e instanceof ConfigError) {
      err(`[det] 引擎清单错误：\n${indent(e.message, 2)}`);
      return 2;
    }
    throw e;
  }

  let simPath: string;
  let cleanup: string | null = null;
  try {
    if (args.fixture !== null) {
      const entry = FIXTURES[args.fixture];
      if (!entry) {
        err(`[det] 未知夹具 ${args.fixture}（现有：${Object.keys(FIXTURES).join('、')}）`);
        return 2;
      }
      if (args.sim !== null) {
        err('[det] --fixture 与 --sim 不能同时使用');
        return 2;
      }
      cleanup = mkdtempSync(join(tmpdir(), 'det-fixture-'));
      const { buildSim } = await import('../sim/build');
      const built = await buildSim({ entry, outDir: cleanup, dts: false });
      simPath = built.jsPath;
      out(`[det] 自测夹具 ${args.fixture}：${shown(entry)} → ${simPath}（临时构建，结束后删除）`);
    } else if (args.sim !== null) {
      simPath = resolve(args.sim);
      if (!existsSync(simPath)) {
        err(`[det] 找不到 ${simPath}`);
        return 2;
      }
    } else {
      simPath = simPaths.simJs;
      if (!existsSync(simPath)) {
        err(`[det] 找不到 ${shown(simPath)}：请先运行 bun run sim:build`);
        return 2;
      }
      const stale = staleSources(simPath, simPaths.sources);
      if (stale.length > 0) {
        err(
          `[det] ${shown(simPath)} 比源码旧（det 跑的是 dist/sim.js，不是源码；检查 ${simPaths.sources.map(shown).join('、')}），` +
            `请重新运行 bun run sim:build。较新的文件：\n` +
            indent(stale.join('\n'), 2),
        );
        return 2;
      }
    }

    const bytes = readFileSync(simPath);
    const simVer = hex8(fnv1aBytes(new Uint8Array(bytes)));
    if (args.sim === null && args.fixture === null && existsSync(simPaths.versionFile)) {
      const recorded = readFileSync(simPaths.versionFile, 'utf8').trim();
      if (recorded !== simVer) {
        err(`[det] dist/sim.version（${recorded}）与 sim.js 的字节哈希（${simVer}）不符：sim.js 被改过？请重新运行 bun run sim:build`);
        return 2;
      }
    }

    const ctx: Ctx = { args, profile, enginesFile, simPath, simVer, simBytes: bytes.length };
    out(
      `[det] 确定性门禁 --kernel：档 ${profile}（${shown(enginesFile)}），` +
        `拍数 ${args.shots ?? '默认'}`,
    );
    out(`[det] sim：${shown(simPath)}  simVer=${simVer}  ${fmtInt(bytes.length)} 字节`);
    out(`[det] 依次运行 ${specs.length} 个引擎（不并行，免得 steps/s 失真；每个超时 ${ENGINE_TIMEOUT_MS / 1000} 秒）`);

    const driverArgs = args.shots !== null ? ['--shots', String(args.shots)] : [];
    const results: EngineResult[] = [];
    const home = homedir();
    for (const spec of specs) {
      const r = runEngine(spec, { simPath, driverArgs, home });
      results.push(r);
      const secs = r.wallMs > 0 ? `${(r.wallMs / 1000).toFixed(1)} 秒` : '未启动';
      out(`[det]   ${spec.name}：${r.errors.length === 0 ? '完成' : '失败'}（${secs}）`);
    }

    const paths = PATH_KEYS.map((k) => comparePath(k, results));
    const failed = results.filter((r) => r.errors.length > 0);
    const ok = failed.length === 0 && paths.every((p) => p.consistent);

    const lines: string[] = [];
    const first = results.find((r) => r.output)?.output ?? null;
    lines.push('');
    if (first) {
      lines.push(`语料版本 ${first.corpusVersion}，API 版本 ${first.apiVersion}，拍数 ${first.shots}；1 step = 1 tick = 2 个 1/60 s 子步；steps/s 取 dsqrt 路径`);
    }
    lines.push(
      ...table([
        ['引擎', 'arch', '版本', 'JIT', 'dsqrt 哈希', 'Math.sqrt 哈希', 'steps', 'steps/s', '结果'],
        ...results.map(engineRow),
      ], new Set([6, 7])),
    );
    if (failed.length > 0) {
      lines.push('');
      lines.push('引擎失败：');
      for (const r of failed) {
        for (const e of r.errors) lines.push(`  ${r.spec.name}：${e}`);
        if (r.stderrTail && !r.output) lines.push(indent(`stderr 末尾：\n${indent(r.stderrTail, 2)}`, 4));
        if (r.stdoutTail && !r.output) lines.push(indent(`stdout 末尾（不含 @@DET@@ 行）：\n${indent(r.stdoutTail, 2)}`, 4));
      }
    }
    if (first && first.shots < SQRT_CHECK_MIN_SHOTS) {
      lines.push('');
      lines.push(
        `注：拍数 ${first.shots} < ${SQRT_CHECK_MIN_SHOTS}，没有检查"注入的 Math.sqrt 是否生效"（拍数太少时正确的 sim 两条路径也可能同哈希）`,
      );
    }
    lines.push('');
    for (const s of paths) {
      const label = PATH_LABEL[s.key];
      if (!s.baseline) {
        lines.push(`${label} 路径：没有可比的结果（没有引擎成功跑完）`);
        continue;
      }
      const b = s.baseline.output!.paths[s.key];
      const nCp = b.checkpoints.length / s.baseline.output!.cp.stride;
      const n = results.filter((r) => r.output).length;
      if (s.consistent) {
        lines.push(
          `${label} 路径：一致——${n} 个引擎的哈希 ${hex8(b.hash)}、steps ${b.steps} 与全部 ${nCp} 条检查点相同（基准 ${s.baseline.spec.name}）`,
        );
      } else {
        lines.push(`${label} 路径：不一致（基准 ${s.baseline.spec.name}：${hex8(b.hash)}，${b.steps} steps，${nCp} 条检查点）`);
        for (const { engine, d } of s.divergences) {
          lines.push(`  ${engine.spec.name} 与 ${s.baseline.spec.name} 不一致：`);
          lines.push(indent(formatDivergence(d, s.baseline.spec.name, engine.spec.name, s.baseline.output!.cp), 4));
        }
      }
    }
    lines.push('');
    const names = results.map((r) => r.spec.name).join('、');
    if (ok) {
      lines.push(`结论：通过——${profile} 档 ${results.length} 个引擎（${names}）在 dsqrt 路径与 Math.sqrt 路径上各自逐位一致`);
    } else {
      const why: string[] = [];
      if (failed.length > 0) why.push(`${failed.length} 个引擎失败（${failed.map((r) => r.spec.name).join('、')}）`);
      for (const s of paths) {
        if (!s.baseline) why.push(`${PATH_LABEL[s.key]} 路径没有结果`);
        else if (!s.consistent) {
          why.push(`${PATH_LABEL[s.key]} 路径不一致（${s.divergences.map((x) => x.engine.spec.name).join('、')} 与基准 ${s.baseline.spec.name} 不同）`);
        }
      }
      lines.push(`结论：失败——${why.join('；')}`);
    }
    const dBase = paths[0]!.baseline?.output?.paths.dsqrt ?? null;
    const detLine = dBase ? `DET ${hex8(dBase.hash)} ${dBase.steps}` : 'DET - -';
    lines.push(detLine);

    if (args.json) {
      for (const l of lines) out(l);
      console.log(JSON.stringify(buildJson(ctx, results, paths, ok, detLine), null, 2));
    } else {
      for (const l of lines) console.log(l);
    }
    return ok ? 0 : 1;
  } finally {
    if (cleanup) rmSync(cleanup, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(`[det] 意外错误：${e instanceof Error ? (e.stack ?? e.message) : String(e)}`);
      process.exit(2);
    },
  );
}

/**
 * 在一个引擎上跑 driver.js：拼命令、起子进程（超时 300 秒）、解析 @@DET@@ 行、合成引擎信息并对照期望。
 *
 * 加载方式统一为"sim.js 与 driver.js 当经典脚本、在同一个全局作用域里依次执行"：
 *   node / bun：<cmd…> boot.cjs <sim.js> <driver.js> <参数…>
 *   jsc：       <cmd…> <sim.js> <driver.js> -- <参数…>
 * boot.cjs、sim.js、driver.js 一律以绝对路径传入；子进程的工作目录是每次新建的空临时目录（结束后删除），
 * 免得 bun 读到工作目录下的 bunfig.toml（例如 preload）而被注入代码。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { checkExpectations, isPathArg, resolveCommand, type EngineInfo, type EngineSpec } from './config';
import { DEFAULT_LAYOUT, hex8, type CheckpointLayout } from './compare';

export const DET_DIR = import.meta.dir;
export const BOOT_CJS = resolve(DET_DIR, 'boot.cjs');
export const DRIVER_JS = resolve(DET_DIR, 'driver.js');
export const DET_MARK = '@@DET@@ ';
/** 单个引擎的子进程超时。 */
export const ENGINE_TIMEOUT_MS = 300_000;
/** 读 jsc 版本用的 plutil（macOS 自带）。 */
export const PLUTIL = '/usr/bin/plutil';
/** 失败诊断保留 stderr / stdout 末尾多少行（node 的错误行后面还有 10 行栈、空行与 "Node.js vNN"）。 */
export const DIAG_TAIL_LINES = 30;
/** 错误行的最大长度（超出截断）。 */
const ERROR_LINE_MAX = 500;
/**
 * 错误行：行首（可缩进）是 XxxError / Exception / error，后跟可选的 [代码] 与英文冒号。
 * 例如 node 的 "Error: x"、"TypeError [ERR_X]: x"，bun 的 "error: x"，jsc 写到 stdout 的 "Exception: Error: x"；
 * 不匹配 node 回显的源码行 "throw new Error("a: b")"。
 */
export const ERROR_LINE_RE = /^\s*(?:Uncaught\s+)?(?:\w*Error|Exception|error)\b(?:\s*\[[^\]\n]*\])?:/;
/**
 * "两条路径哈希相同即判失败"的最小拍数。正确的 sim 单拍里 dsqrt 与 Math.sqrt 恰好处处同值的概率约 0.3
 * （默认种子下 --shots 1 两条路径就同哈希），N 拍约 0.3^N；32 拍以上同哈希只可能是注入的 Math.sqrt 没有生效。
 */
export const SQRT_CHECK_MIN_SHOTS = 32;

/** 继承环境时去掉的变量：它们会改变引擎行为，引擎只带 engines.json 里写明的 env。 */
const SCRUB_ENV_RE = /^(BUN_JSC_|JSC_|NODE_OPTIONS$|BUN_OPTIONS$|NODE_V8_COVERAGE$)/;

export interface DriverPath {
  hash: number;
  steps: number;
  substeps: number;
  shots: number;
  corpusVersion: number;
  ms: number;
  checkpoints: number[];
}

export interface DriverOutput {
  v: number;
  apiVersion: number;
  corpusVersion: number;
  shots: number;
  seed: number | null;
  engine: {
    hasProcess: boolean;
    arch: string | null;
    nodeVersion: string | null;
    bunVersion: string | null;
    /** process.versions.webkit：bun 内置 JSC 的 WebKit 提交；node / jsc 为 null。 */
    webkitVersion: string | null;
    /** 引擎里的 process.cwd()（jsc 为 null）；用于确认子进程跑在空临时目录里。 */
    cwd: string | null;
  };
  jit: boolean | null;
  dfgCompiles: number | null;
  timer: string;
  cp: CheckpointLayout;
  paths: { dsqrt: DriverPath; mathSqrt: DriverPath };
}

export const PATH_KEYS = ['dsqrt', 'mathSqrt'] as const;
export type PathKey = (typeof PATH_KEYS)[number];
export const PATH_LABEL: Record<PathKey, string> = { dsqrt: 'dsqrt', mathSqrt: 'Math.sqrt' };

export interface EngineResult {
  spec: EngineSpec;
  /** 展开 ~/ 之后实际执行的命令（不含 boot/sim/driver 与参数）。 */
  cmd: string[];
  /** 失败原因；空 = 该引擎通过（能跑、输出完整、arch/版本/JIT 符合期望）。 */
  errors: string[];
  /** 有输出时的信息（即使期望不符也保留，用于互比与打印）。 */
  info: EngineInfo | null;
  output: DriverOutput | null;
  /** 子进程墙钟耗时（毫秒）。 */
  wallMs: number;
  /** stderr 末尾 DIAG_TAIL_LINES 行。 */
  stderrTail: string;
  /** 没拿到有效输出时 stdout 的末尾 DIAG_TAIL_LINES 行（去掉 @@DET@@ 行；jsc 把未捕获异常写在 stdout）；否则为空串。 */
  stdoutTail: string;
}

/** 拼出完整命令行。 */
export function buildEngineArgv(spec: EngineSpec, cmd: string[], simPath: string, driverArgs: string[]): string[] {
  if (spec.kind === 'jsc') return [...cmd, simPath, DRIVER_JS, '--', ...driverArgs];
  return [...cmd, BOOT_CJS, simPath, DRIVER_JS, ...driverArgs];
}

/** 子进程环境：继承当前环境（去掉会改变引擎行为的变量），再叠上 engines.json 的 env。 */
export function engineEnv(spec: EngineSpec, base: Record<string, string | undefined> = process.env): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) if (v !== undefined && !SCRUB_ENV_RE.test(k)) env[k] = v;
  return { ...env, ...spec.env };
}

function isNum(x: unknown): x is number {
  return typeof x === 'number' && Number.isFinite(x);
}

function checkPath(p: unknown, name: string): DriverPath {
  const o = p as Partial<DriverPath> | null;
  if (!o || typeof o !== 'object') throw new Error(`@@DET@@ 输出缺少 paths.${name}`);
  if (!isNum(o.hash) || !isNum(o.steps) || !isNum(o.ms) || !Array.isArray(o.checkpoints)) {
    throw new Error(`@@DET@@ 输出的 paths.${name} 缺少 hash / steps / ms / checkpoints`);
  }
  if (!o.checkpoints.every((x) => typeof x === 'number')) throw new Error(`paths.${name}.checkpoints 含非数字`);
  return o as DriverPath;
}

/** 从 stdout 里找最后一行 @@DET@@，解析并校验形状；找不到或形状不对抛错。 */
export function parseDriverOutput(stdout: string): DriverOutput {
  const lines = stdout.split(/\r?\n/);
  let found: string | null = null;
  for (const line of lines) if (line.startsWith(DET_MARK)) found = line.slice(DET_MARK.length);
  if (found === null) throw new Error('输出里没有 @@DET@@ 行');
  let o: DriverOutput;
  try {
    o = JSON.parse(found) as DriverOutput;
  } catch (e) {
    throw new Error(`@@DET@@ 行不是合法 JSON：${(e as Error).message}`);
  }
  if (!o || typeof o !== 'object' || o.v !== 1) throw new Error('@@DET@@ 输出版本不是 1');
  if (!o.engine || typeof o.engine !== 'object') throw new Error('@@DET@@ 输出缺少 engine');
  if (!o.paths || typeof o.paths !== 'object') throw new Error('@@DET@@ 输出缺少 paths');
  checkPath(o.paths.dsqrt, 'dsqrt');
  checkPath(o.paths.mathSqrt, 'mathSqrt');
  const cp = o.cp;
  if (!cp || !isNum(cp.stride) || !isNum(cp.tick) || !isNum(cp.shotEnd) || cp.stride < 4) o.cp = { ...DEFAULT_LAYOUT };
  // 检查点数组必须是整条记录：否则互比时才抛错，会让整个 det 以"意外错误"退出，而不是记为该引擎失败
  for (const k of PATH_KEYS) {
    const n = o.paths[k].checkpoints.length;
    if (n % o.cp.stride !== 0) throw new Error(`@@DET@@ 输出的 paths.${k}.checkpoints 长度 ${n} 不是步长 ${o.cp.stride} 的整数倍`);
  }
  // 引擎信息字段规范成 string | null / boolean：缺字段的输出不应在期望检查时崩溃
  const e = o.engine as Record<string, unknown>;
  const str = (x: unknown): string | null => (typeof x === 'string' && x !== '' ? x : null);
  o.engine = {
    hasProcess: e.hasProcess === true,
    arch: str(e.arch),
    nodeVersion: str(e.nodeVersion),
    bunVersion: str(e.bunVersion),
    webkitVersion: str(e.webkitVersion),
    cwd: str(e.cwd),
  };
  if (o.jit !== true && o.jit !== false) o.jit = null;
  return o;
}

/** cmd 里真正的引擎二进制：最后一个路径元素（跳过 /usr/bin/arch 之类的包装）。 */
export function engineBinary(cmd: string[]): string {
  let bin = cmd[0]!;
  cmd.forEach((c, i) => {
    if (isPathArg(c, i)) bin = c;
  });
  return bin;
}

/**
 * jsc 版本：jsc 二进制所在目录的 ../Resources/Info.plist 里的 CFBundleVersion，
 * 用 /usr/bin/plutil -extract CFBundleVersion raw -o - 读。读不到返回 null（打印"未知"）。
 */
export function readJscVersion(jscPath: string, plutil: string = PLUTIL): string | null {
  const plist = resolve(dirname(jscPath), '..', 'Resources', 'Info.plist');
  if (!existsSync(plist) || !existsSync(plutil)) return null;
  const r = spawnSync(plutil, ['-extract', 'CFBundleVersion', 'raw', '-o', '-', plist], {
    encoding: 'utf8',
    timeout: 10_000,
  });
  if (r.status !== 0) return null;
  const v = (r.stdout ?? '').trim();
  return v === '' ? null : v;
}

/** 由 driver 输出（与 jsc 版本）合成引擎信息。 */
export function engineInfoFrom(spec: EngineSpec, out: DriverOutput, jscVersion: string | null): EngineInfo {
  const e = out.engine;
  let version: string | null;
  if (spec.kind === 'node') version = e.nodeVersion;
  else if (spec.kind === 'bun') version = e.bunVersion;
  else version = jscVersion;
  return {
    arch: e.arch,
    version,
    webkit: e.webkitVersion,
    jit: out.jit,
    hasProcess: e.hasProcess === true,
    isBun: e.bunVersion !== null,
  };
}

/**
 * 两条路径是否真的不同：拍数够多（≥ SQRT_CHECK_MIN_SHOTS）而 dsqrt 与 Math.sqrt 路径哈希相同，
 * 说明 sim 忽略了注入的 sqrt，Math.sqrt 对照路径跑成了 dsqrt 路径，失去意义。返回问题列表（空 = 通过）。
 */
export function checkPathsDiffer(out: DriverOutput): string[] {
  const d = out.paths.dsqrt.hash >>> 0;
  if (out.shots < SQRT_CHECK_MIN_SHOTS || d !== out.paths.mathSqrt.hash >>> 0) return [];
  return [
    `dsqrt 路径与 Math.sqrt 路径哈希相同（${hex8(d)}）：注入的 Math.sqrt 没有生效（sim 忽略了 kernel.run 的 sqrt 选项？），Math.sqrt 对照路径失去意义`,
  ];
}

function tail(text: string, n: number): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

/** 去掉 @@DET@@ 行（诊断里不需要那一大行 JSON）。 */
function withoutDetLines(text: string): string {
  return text
    .split(/\r?\n/)
    .filter((l) => !l.startsWith(DET_MARK))
    .join('\n');
}

/** 依次在各段文本里找第一条错误行（见 ERROR_LINE_RE）；找不到返回 null。 */
export function firstErrorLine(...texts: string[]): string | null {
  for (const text of texts) {
    for (const line of text.split(/\r?\n/)) {
      if (line.startsWith(DET_MARK) || !ERROR_LINE_RE.test(line)) continue;
      const t = line.trim();
      return t.length > ERROR_LINE_MAX ? `${t.slice(0, ERROR_LINE_MAX)}…` : t;
    }
  }
  return null;
}

export interface RunOptions {
  /** sim.js；相对路径按 det 进程的工作目录解析成绝对路径（子进程的工作目录是空临时目录）。 */
  simPath: string;
  driverArgs: string[];
  home: string;
  timeoutMs?: number;
}

/** 在一个引擎上跑 driver（同步、串行调用，保证 steps/s 不受并发干扰）。 */
export function runEngine(spec: EngineSpec, opts: RunOptions): EngineResult {
  const resolved = resolveCommand(spec, opts.home);
  const res: EngineResult = {
    spec,
    cmd: resolved.cmd,
    errors: [...resolved.errors],
    info: null,
    output: null,
    wallMs: 0,
    stderrTail: '',
    stdoutTail: '',
  };
  if (res.errors.length > 0) return res;

  const argv = buildEngineArgv(spec, resolved.cmd, resolve(opts.simPath), opts.driverArgs);
  const timeout = opts.timeoutMs ?? ENGINE_TIMEOUT_MS;
  // 空的临时工作目录：bun 会读工作目录下的 bunfig.toml（preload 等），不能在仓库根或调用方目录里跑
  const cwd = mkdtempSync(join(tmpdir(), 'det-cwd-'));
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    const t0 = performance.now();
    try {
      r = Bun.spawnSync({
        cmd: argv,
        cwd,
        env: engineEnv(spec),
        stdin: 'ignore',
        stdout: 'pipe',
        stderr: 'pipe',
        timeout,
        // 超时直接 SIGKILL：引擎卡在长循环里时不一定及时响应 SIGTERM
        killSignal: 'SIGKILL',
      });
    } catch (e) {
      res.errors.push(`无法启动：${(e as Error).message}`);
      return res;
    }
    res.wallMs = performance.now() - t0;
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
  const stdout = r.stdout ? r.stdout.toString() : '';
  const stderr = r.stderr ? r.stderr.toString() : '';
  res.stderrTail = tail(stderr, DIAG_TAIL_LINES);
  /** 没拿到有效输出时的诊断：首条错误行（先 stderr 后 stdout）接在原因后面，并保留 stdout 末尾。 */
  const fail = (why: string): EngineResult => {
    const line = firstErrorLine(stderr, stdout);
    res.errors.push(line ? `${why}：${line}` : why);
    res.stdoutTail = tail(withoutDetLines(stdout), DIAG_TAIL_LINES);
    return res;
  };

  if (r.exitedDueToTimeout) return fail(`超时：${Math.round(timeout / 1000)} 秒内没有结束`);
  if (r.exitCode !== 0) return fail(`退出码 ${r.exitCode ?? `（信号 ${r.signalCode ?? '未知'}）`}`);
  try {
    res.output = parseDriverOutput(stdout);
  } catch (e) {
    return fail((e as Error).message);
  }
  const jscVersion = spec.kind === 'jsc' ? readJscVersion(engineBinary(resolved.cmd)) : null;
  res.info = engineInfoFrom(spec, res.output, jscVersion);
  res.errors.push(...checkExpectations(spec, res.info));
  res.errors.push(...checkPathsDiffer(res.output));
  return res;
}

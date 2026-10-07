/**
 * 在一个引擎上跑 driver.js：拼命令、起子进程（超时 300 秒）、解析 @@DET@@ 行、合成引擎信息并对照期望。
 *
 * 加载方式统一为"sim.js 与 driver.js 当经典脚本、在同一个全局作用域里依次执行"：
 *   node / bun：<cmd…> boot.cjs <sim.js> <driver.js> <参数…>
 *   jsc：       <cmd…> <sim.js> <driver.js> -- <参数…>
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { checkExpectations, isPathArg, resolveCommand, type EngineInfo, type EngineSpec } from './config';
import { DEFAULT_LAYOUT, type CheckpointLayout } from './compare';

export const DET_DIR = import.meta.dir;
export const BOOT_CJS = resolve(DET_DIR, 'boot.cjs');
export const DRIVER_JS = resolve(DET_DIR, 'driver.js');
export const DET_MARK = '@@DET@@ ';
/** 单个引擎的子进程超时。 */
export const ENGINE_TIMEOUT_MS = 300_000;
/** 读 jsc 版本用的 plutil（macOS 自带）。 */
export const PLUTIL = '/usr/bin/plutil';

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
  engine: { hasProcess: boolean; arch: string | null; nodeVersion: string | null; bunVersion: string | null };
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
  stderrTail: string;
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
    jit: out.jit,
    hasProcess: e.hasProcess === true,
    isBun: e.bunVersion !== null,
  };
}

function tail(text: string, n: number): string {
  const lines = text.trimEnd().split(/\r?\n/);
  return lines.slice(-n).join('\n');
}

export interface RunOptions {
  simPath: string;
  driverArgs: string[];
  home: string;
  cwd: string;
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
  };
  if (res.errors.length > 0) return res;

  const argv = buildEngineArgv(spec, resolved.cmd, opts.simPath, opts.driverArgs);
  const timeout = opts.timeoutMs ?? ENGINE_TIMEOUT_MS;
  const t0 = performance.now();
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync({
      cmd: argv,
      cwd: opts.cwd,
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
  const stdout = r.stdout ? r.stdout.toString() : '';
  const stderr = r.stderr ? r.stderr.toString() : '';
  res.stderrTail = tail(stderr, 12);

  if (r.exitedDueToTimeout) {
    res.errors.push(`超时：${Math.round(timeout / 1000)} 秒内没有结束`);
    return res;
  }
  if (r.exitCode !== 0) {
    res.errors.push(`退出码 ${r.exitCode ?? `（信号 ${r.signalCode ?? '未知'}）`}`);
    return res;
  }
  try {
    res.output = parseDriverOutput(stdout);
  } catch (e) {
    res.errors.push((e as Error).message);
    return res;
  }
  const jscVersion = spec.kind === 'jsc' ? readJscVersion(engineBinary(resolved.cmd)) : null;
  res.info = engineInfoFrom(spec, res.output, jscVersion);
  res.errors.push(...checkExpectations(spec, res.info));
  return res;
}

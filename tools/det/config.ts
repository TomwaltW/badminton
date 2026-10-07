/**
 * 引擎清单 tools/det/engines.json 的读取与校验（计划 6 章：引擎用配置里的绝对路径，
 * 任何一个缺失或架构/版本不符即失败）。
 *
 * 文件形状：
 *   { "$comment": …, "profiles": { "<档名>": [ 引擎, … ] } }
 * 引擎：
 *   name    唯一名（字母、数字、. _ -）
 *   kind    node | bun | jsc —— 决定加载方式与"版本"取哪个字段
 *   cmd     命令数组。cmd[0] 必须是绝对路径；其余元素里不以 "-" 开头的一律视为路径，也必须是绝对路径
 *           （例如 /usr/bin/arch -x86_64 /usr/local/bin/node 里的 node）。开头的 "~/" 展开为 os.homedir()，
 *           展开后仍须是绝对路径；除此之外不接受相对路径。带值的引擎参数请写成 --flag=value 一个元素。
 *   env     可选，附加的环境变量（字符串 → 字符串）
 *   expect  可选：arch（process.arch，jsc 不可设）、version（版本前缀；空串 = 只打印不判定）、
 *           jit（true = 必须开启，false = 必须关闭）
 *
 * 结构错误（JSON 坏、缺字段、未知字段、重名）抛 ConfigError，det 以退出码 2 结束；
 * 路径问题（相对路径、不存在、不可执行）不抛错，由 preflight 返回给 det 记为该引擎失败。
 */
import { accessSync, constants, existsSync, readFileSync, statSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';

export type EngineKind = 'node' | 'bun' | 'jsc';
export const ENGINE_KINDS: readonly EngineKind[] = ['node', 'bun', 'jsc'];

export interface EngineExpect {
  /** process.arch，例如 x64、arm64。 */
  arch?: string;
  /** 版本前缀：node 比 process.version（"v22."），bun 比 process.versions.bun（"1.4."），jsc 比 Info.plist 的 CFBundleVersion。空串 = 不判定。 */
  version?: string;
  /** JIT 必须开启（true）或必须关闭（false）。 */
  jit?: boolean;
}

export interface EngineSpec {
  name: string;
  kind: EngineKind;
  cmd: string[];
  env: Record<string, string>;
  expect: EngineExpect;
}

export interface EnginesConfig {
  source: string;
  profiles: Record<string, EngineSpec[]>;
}

export class ConfigError extends Error {
  override name = 'ConfigError';
}

const NAME_RE = /^[A-Za-z0-9._-]+$/;
const ENGINE_KEYS = new Set(['name', 'kind', 'cmd', 'env', 'expect', '$comment']);
const EXPECT_KEYS = new Set(['arch', 'version', 'jit', '$comment']);

function isRecord(x: unknown): x is Record<string, unknown> {
  return typeof x === 'object' && x !== null && !Array.isArray(x);
}

/** 校验并规范化一个引擎条目；问题追加到 errs。 */
function parseEngine(raw: unknown, where: string, errs: string[]): EngineSpec | null {
  if (!isRecord(raw)) {
    errs.push(`${where}：必须是对象`);
    return null;
  }
  const before = errs.length;
  for (const k of Object.keys(raw)) if (!ENGINE_KEYS.has(k)) errs.push(`${where}：未知字段 "${k}"`);
  const name = raw.name;
  if (typeof name !== 'string' || !NAME_RE.test(name)) errs.push(`${where}：name 必须是由字母、数字、. _ - 组成的非空字符串`);
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(ENGINE_KINDS as readonly string[]).includes(kind)) {
    errs.push(`${where}：kind 必须是 ${ENGINE_KINDS.join(' | ')}`);
  }
  const cmd = raw.cmd;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((c) => typeof c === 'string' && c.length > 0)) {
    errs.push(`${where}：cmd 必须是非空字符串组成的非空数组`);
  }
  const env: Record<string, string> = {};
  if (raw.env !== undefined) {
    if (!isRecord(raw.env)) errs.push(`${where}：env 必须是对象`);
    else {
      for (const [k, v] of Object.entries(raw.env)) {
        if (typeof v !== 'string') errs.push(`${where}：env.${k} 必须是字符串`);
        else env[k] = v;
      }
    }
  }
  const expect: EngineExpect = {};
  if (raw.expect !== undefined) {
    if (!isRecord(raw.expect)) errs.push(`${where}：expect 必须是对象`);
    else {
      const e = raw.expect;
      for (const k of Object.keys(e)) if (!EXPECT_KEYS.has(k)) errs.push(`${where}：expect 里有未知字段 "${k}"`);
      if (e.arch !== undefined) {
        if (typeof e.arch !== 'string' || e.arch === '') errs.push(`${where}：expect.arch 必须是非空字符串`);
        else if (kind === 'jsc') errs.push(`${where}：jsc 没有 process.arch，不能设 expect.arch`);
        else expect.arch = e.arch;
      }
      if (e.version !== undefined) {
        if (typeof e.version !== 'string') errs.push(`${where}：expect.version 必须是字符串（空串 = 只打印不判定）`);
        else expect.version = e.version;
      }
      if (e.jit !== undefined) {
        if (typeof e.jit !== 'boolean') errs.push(`${where}：expect.jit 必须是 true 或 false`);
        else expect.jit = e.jit;
      }
    }
  }
  if (errs.length > before) return null;
  return { name: name as string, kind: kind as EngineKind, cmd: [...(cmd as string[])], env, expect };
}

/** 校验已解析的 JSON；有任何问题抛 ConfigError（列出全部问题）。 */
export function parseEnginesConfig(raw: unknown, source: string): EnginesConfig {
  const errs: string[] = [];
  const profiles: Record<string, EngineSpec[]> = {};
  if (!isRecord(raw)) throw new ConfigError(`${source}：顶层必须是对象`);
  for (const k of Object.keys(raw)) if (k !== 'profiles' && k !== '$comment') errs.push(`${source}：顶层未知字段 "${k}"`);
  if (!isRecord(raw.profiles)) {
    errs.push(`${source}：缺少 profiles 对象`);
  } else {
    for (const [pname, list] of Object.entries(raw.profiles)) {
      if (pname.startsWith('$')) continue;
      if (!Array.isArray(list) || list.length === 0) {
        errs.push(`${source}：档 ${pname} 必须是非空数组`);
        continue;
      }
      const specs: EngineSpec[] = [];
      const seen = new Set<string>();
      list.forEach((item, i) => {
        const spec = parseEngine(item, `${source}：档 ${pname} 第 ${i + 1} 个引擎`, errs);
        if (!spec) return;
        if (seen.has(spec.name)) errs.push(`${source}：档 ${pname} 里引擎名 ${spec.name} 重复`);
        seen.add(spec.name);
        specs.push(spec);
      });
      profiles[pname] = specs;
    }
  }
  if (errs.length > 0) throw new ConfigError(errs.join('\n'));
  return { source, profiles };
}

/** 读文件并校验。 */
export function loadEnginesConfig(file: string): EnginesConfig {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (e) {
    throw new ConfigError(`读不到引擎清单 ${file}：${(e as Error).message}`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new ConfigError(`${file} 不是合法 JSON：${(e as Error).message}`);
  }
  return parseEnginesConfig(raw, file);
}

/** 取一档引擎；档不存在抛 ConfigError。 */
export function selectProfile(cfg: EnginesConfig, profile: string): EngineSpec[] {
  const list = cfg.profiles[profile];
  if (!list) {
    throw new ConfigError(`${cfg.source} 里没有档 "${profile}"（现有：${Object.keys(cfg.profiles).join('、') || '无'}）`);
  }
  return list;
}

/** process.platform → 默认档：darwin → mac，linux → linux，其他返回 null。 */
export function defaultProfile(platform: string): string | null {
  if (platform === 'darwin') return 'mac';
  if (platform === 'linux') return 'linux';
  return null;
}

/** 只展开开头的 "~/"（展开为 home）；其他写法（含单独的 "~"、"~user/"）原样返回。 */
export function expandHome(p: string, home: string): string {
  return p.startsWith('~/') ? join(home, p.slice(2)) : p;
}

/** cmd 里被视为路径的元素：cmd[0]，以及其后不以 "-" 开头的元素。 */
export function isPathArg(arg: string, index: number): boolean {
  return index === 0 || !arg.startsWith('-');
}

export interface ResolvedCommand {
  /** 展开 ~/ 之后的命令。 */
  cmd: string[];
  /** 路径问题；非空即该引擎失败。 */
  errors: string[];
}

/**
 * 展开 ~/，并检查每个路径元素：必须是绝对路径、存在、是普通文件且可执行。
 * home 可注入（单测用）；默认 os.homedir() 由调用方传入。
 */
export function resolveCommand(spec: EngineSpec, home: string): ResolvedCommand {
  const errors: string[] = [];
  const cmd = spec.cmd.map((c) => expandHome(c, home));
  cmd.forEach((p, i) => {
    if (!isPathArg(p, i)) return;
    const orig = spec.cmd[i]!;
    const shown = orig === p ? p : `${orig}（展开为 ${p}）`;
    if (!isAbsolute(p)) {
      errors.push(`不是绝对路径：${shown}（引擎清单只接受绝对路径，开头的 ~/ 会展开为主目录）`);
      return;
    }
    if (!existsSync(p)) {
      errors.push(`可执行文件不存在：${shown}`);
      return;
    }
    try {
      if (!statSync(p).isFile()) {
        errors.push(`不是文件：${shown}`);
        return;
      }
      accessSync(p, constants.X_OK);
    } catch {
      errors.push(`没有执行权限：${shown}`);
    }
  });
  return { cmd, errors };
}

/** 引擎实际报告的信息（由 driver 输出与 det 侧探测合成）。 */
export interface EngineInfo {
  /** process.arch；jsc 为 null。 */
  arch: string | null;
  /** 按 kind 取的版本：node → process.version，bun → process.versions.bun，jsc → CFBundleVersion；取不到为 null。 */
  version: string | null;
  /** bun 内置 JSC 的版本（process.versions.webkit，WebKit 提交哈希）；node / jsc 为 null（jsc 的 JSC 版本就是 version）。 */
  webkit: string | null;
  /** true 开启 / false 关闭 / null 未知（没有探针）。 */
  jit: boolean | null;
  /** driver 看到的环境：有没有 process、是不是 bun。用于发现 kind 写错。 */
  hasProcess: boolean;
  isBun: boolean;
}

/** 对照 expect 与 kind 检查引擎信息；返回问题列表（空 = 通过）。 */
export function checkExpectations(spec: EngineSpec, info: EngineInfo): string[] {
  const errs: string[] = [];
  if (spec.kind === 'bun' && !info.isBun) errs.push('kind 为 bun，但引擎里没有 process.versions.bun');
  if (spec.kind === 'node' && info.isBun) errs.push('kind 为 node，但引擎其实是 bun');
  if (spec.kind === 'node' && !info.hasProcess) errs.push('kind 为 node，但引擎里没有 process');
  if (spec.kind === 'jsc' && info.hasProcess) errs.push('kind 为 jsc，但引擎里有 process（不是 jsc 命令行？）');
  const e = spec.expect;
  if (e.arch !== undefined && info.arch !== e.arch) errs.push(`arch 不符：期望 ${e.arch}，实际 ${info.arch ?? '未知'}`);
  if (e.version !== undefined && e.version !== '') {
    if (info.version === null) errs.push(`版本不符：期望前缀 ${e.version}，实际 未知`);
    else if (!info.version.startsWith(e.version)) errs.push(`版本不符：期望前缀 ${e.version}，实际 ${info.version}`);
  }
  if (e.jit !== undefined) {
    const want = e.jit ? '开启' : '关闭';
    if (info.jit === null) errs.push(`JIT 状态不符：期望${want}，但没有 JIT 探针（未知）`);
    else if (info.jit !== e.jit) errs.push(`JIT 状态不符：期望${want}，实际${info.jit ? '开启' : '关闭'}`);
  }
  return errs;
}

/** JIT 状态的中文。 */
export function jitLabel(jit: boolean | null): string {
  return jit === null ? '未知' : jit ? '开启' : '关闭';
}

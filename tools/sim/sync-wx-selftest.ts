/**
 * bun run wx-selftest:sync：把模拟核心的发布产物复制进空白微信小游戏工程（计划 2.2"分发"、6 章"真机内核自测"）。
 *
 *   packages/sim/dist/sim.js  →  tools/wx-selftest/sim.js（原样复制，逐字节）
 *
 * - dist/sim.js 不存在：提示先 bun run sim:build，退出 1；
 * - 复制后读回目标字节算 FNV-1a，必须等于 dist/sim.version（= simVer），否则退出 1 且不覆盖原有的目标文件
 *   （先写临时文件、校验通过再改名）；
 * - 成功时打印 simVer：与 bun run det --kernel 打印的 simVer 相同，就说明真机跑的是门禁验过的同一份 sim.js；
 * - packages/sim/src 里有比 dist/sim.js 新的 .ts 时只告警（多半忘了重新 sim:build），不阻止复制。
 *
 * 命令行：bun tools/sim/sync-wx-selftest.ts [--src <sim.js>] [--dest <工程目录>]（参数只为测试与排查；平时不带）。
 * 也可作为模块调用：syncWxSelftest({ srcJs, destDir })。
 */
import { existsSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fnv1aBytes, hex8 } from './fnv';
import { REPO_ROOT, SIM_DIR, SIM_JS } from './paths';

/** 微信小游戏自测工程目录。 */
export const WX_SELFTEST_DIR = resolve(REPO_ROOT, 'tools/wx-selftest');
/** 工程里 sim.js 的文件名（game.js 用 require('./sim.js') 加载）。 */
export const WX_SIM_NAME = 'sim.js';

export interface SyncOptions {
  /** 源 sim.js，默认 packages/sim/dist/sim.js；期望的 simVer 读同目录的 sim.version。 */
  srcJs?: string;
  /** 目标工程目录，默认 tools/wx-selftest；写入 <destDir>/sim.js。目录必须已存在。 */
  destDir?: string;
}

export interface SyncResult {
  srcJs: string;
  destJs: string;
  bytes: number;
  simVer: string;
  /** 比 dist/sim.js 新的模拟核心源码（只在用默认源时检查；非空说明 dist 可能过期）。 */
  staleSources: string[];
}

/** 同步失败（用户可处理的前置条件或校验错误）；命令行据此退出 1。 */
export class SyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyncError';
  }
}

function rel(p: string): string {
  const r = relative(REPO_ROOT, p);
  return r.startsWith('..') ? p : r;
}

/** 读 sim.version：一行 8 位小写十六进制。 */
function readSimVersion(file: string): string {
  if (!existsSync(file)) {
    throw new SyncError(`找不到 ${rel(file)}：先在仓库根运行 bun run sim:build（它同时写 sim.js 与 sim.version）`);
  }
  const text = readFileSync(file, 'utf8').trim();
  if (!/^[0-9a-f]{8}$/.test(text)) {
    throw new SyncError(`${rel(file)} 的内容不是 8 位十六进制的 simVer（实际为 ${JSON.stringify(text)}）：重新 bun run sim:build`);
  }
  return text;
}

/** 列出 dir 下（递归）修改时间晚于 refMs 的 .ts 文件（按路径排序）。 */
export function newerSources(dir: string, refMs: number): string[] {
  const out: string[] = [];
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) out.push(...newerSources(p, refMs));
    else if (name.endsWith('.ts') && st.mtimeMs > refMs) out.push(p);
  }
  return out;
}

export function syncWxSelftest(opts: SyncOptions = {}): SyncResult {
  const srcJs = resolve(opts.srcJs ?? SIM_JS);
  const destDir = resolve(opts.destDir ?? WX_SELFTEST_DIR);
  const versionFile = join(dirname(srcJs), 'sim.version');

  if (!existsSync(srcJs)) {
    throw new SyncError(`找不到 ${rel(srcJs)}：先在仓库根运行 bun run sim:build，再运行 bun run wx-selftest:sync`);
  }
  if (!existsSync(destDir) || !statSync(destDir).isDirectory()) {
    throw new SyncError(`目标目录 ${rel(destDir)} 不存在或不是目录`);
  }
  const expected = readSimVersion(versionFile);
  const src = readFileSync(srcJs);

  const destJs = join(destDir, WX_SIM_NAME);
  const tmp = join(destDir, `.${WX_SIM_NAME}.sync-${process.pid}.tmp`);
  try {
    writeFileSync(tmp, src);
    const copied = readFileSync(tmp);
    const actual = hex8(fnv1aBytes(copied));
    if (actual !== expected) {
      const srcVer = hex8(fnv1aBytes(src));
      throw new SyncError(
        srcVer !== expected
          ? `${rel(srcJs)} 的字节哈希 ${srcVer} 与 ${rel(versionFile)} 的 ${expected} 不符（sim.js 被手改过或构建中断）：重新 bun run sim:build`
          : `复制后的字节哈希 ${actual} 与 simVer ${expected} 不符（写入 ${rel(destDir)} 时出错）：检查磁盘后重试`,
      );
    }
    renameSync(tmp, destJs);
  } finally {
    rmSync(tmp, { force: true });
  }

  const staleSources = resolve(srcJs) === resolve(SIM_JS) ? newerSources(join(SIM_DIR, 'src'), statSync(srcJs).mtimeMs) : [];
  return { srcJs, destJs, bytes: src.length, simVer: expected, staleSources };
}

/** 解析命令行参数；不认识的参数抛 SyncError。 */
export function parseSyncArgs(argv: string[]): SyncOptions {
  const opts: SyncOptions = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const v = argv[i + 1];
    if ((a === '--src' || a === '--dest') && (v === undefined || v.startsWith('--'))) {
      throw new SyncError(`${a} 需要一个路径参数`);
    }
    if (a === '--src') opts.srcJs = argv[++i];
    else if (a === '--dest') opts.destDir = argv[++i];
    else throw new SyncError(`未知参数 ${a}（用法：bun run wx-selftest:sync [--src <sim.js>] [--dest <工程目录>]）`);
  }
  return opts;
}

if (import.meta.main) {
  try {
    const r = syncWxSelftest(parseSyncArgs(process.argv.slice(2)));
    if (r.staleSources.length > 0) {
      console.warn(
        `[wx-selftest:sync] 警告：以下源码比 ${rel(r.srcJs)} 新，dist 可能过期，建议先 bun run sim:build：\n` +
          r.staleSources.map((p) => `  ${rel(p)}`).join('\n'),
      );
    }
    console.log(`[wx-selftest:sync] ${rel(r.srcJs)} → ${rel(r.destJs)}  ${r.bytes.toLocaleString('en-US')} 字节`);
    console.log(`[wx-selftest:sync] simVer=${r.simVer}（字节 FNV-1a 已校验，与 dist/sim.version 一致）`);
  } catch (e) {
    console.error(`[wx-selftest:sync] 失败：${(e as Error).message}`);
    process.exit(1);
  }
}

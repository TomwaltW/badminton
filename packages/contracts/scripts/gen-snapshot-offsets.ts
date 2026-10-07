/**
 * bun run contracts:gen [--check] [--out <路径>]
 *
 * 由 packages/contracts/src/snapshot.schema.ts 的有序字段表生成命名偏移常量文件
 * packages/contracts/src/gen/snapshot-offsets.ts（该文件要提交）。
 *
 * - 默认：写出生成文件（内容不变时不改动磁盘）。
 * - --check：只比较，生成内容与磁盘不同（或文件缺失）则退出 1；门禁与测试用。
 * - --out <路径>：改写到别的路径（测试用临时文件）。
 *
 * 命名：SNAP_I32_<NAME>、SNAP_F64_<NAME> 为起点，<...>_LEN 为槽数；SNAP_I32_LEN、SNAP_F64_LEN 为总长；
 * 按球员展开的字段生成 P0_<NAME>、P1_<NAME> 两组。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import {
  SNAPSHOT_F64_LAYOUT,
  SNAPSHOT_I32_LAYOUT,
  SNAPSHOT_SCHEMA_VER,
  type SnapshotLayout,
} from '../src/snapshot.schema';

export const CONTRACTS_DIR = resolve(import.meta.dir, '..');
export const GEN_OFFSETS_PATH = resolve(CONTRACTS_DIR, 'src/gen/snapshot-offsets.ts');

function docLine(doc: string): string {
  // 注释里不能出现注释结束符。
  return doc.replace(/\*\//g, '* /');
}

function renderTable(prefix: string, title: string, layout: SnapshotLayout, names: Set<string>): string[] {
  const lines: string[] = [];
  const emit = (name: string, value: number): void => {
    if (names.has(name)) throw new Error(`生成的常量名重复：${name}`);
    names.add(name);
    lines.push(`export const ${name} = ${value};`);
  };
  lines.push(`// ---- ${title}（共 ${layout.length} 槽） ----`, '');
  lines.push(`/** ${title}总长。 */`);
  emit(`${prefix}_LEN`, layout.length);
  for (const s of layout.slots) {
    lines.push('');
    const who = s.player < 0 ? '' : `球员 ${s.player}：`;
    lines.push(`/** ${who}${docLine(s.doc)}；${s.count} 槽 */`);
    emit(`${prefix}_${s.name}`, s.offset);
    emit(`${prefix}_${s.name}_LEN`, s.count);
  }
  return lines;
}

/** 生成文件的全文（确定性：只依赖 schema）。 */
export function renderSnapshotOffsets(): string {
  const names = new Set<string>();
  const out: string[] = [
    '/**',
    ' * 快照命名偏移：自动生成，勿手改。',
    ' *',
    ' * 契约草案 v0，待 10-11 人工审定冻结。',
    ' *',
    ` * 来源：packages/contracts/src/snapshot.schema.ts（SNAPSHOT_SCHEMA_VER = ${SNAPSHOT_SCHEMA_VER}）。`,
    ' * 重新生成：bun run contracts:gen；检查是否最新：bun run contracts:gen --check（不同则退出 1）。',
    ' *',
    ' * SNAP_I32_<NAME> / SNAP_F64_<NAME> 是字段在 i32 / f64 数组里的起点，<...>_LEN 是该字段的槽数；',
    ' * SNAP_I32_LEN / SNAP_F64_LEN 是总长。按球员展开的字段两段相邻：P1_<NAME> = P0_<NAME> + P0_<NAME>_LEN，',
    ' * 所以球员 p 的起点 = SNAP_F64_P0_<NAME> + p × SNAP_F64_P0_<NAME>_LEN。',
    ' */',
    '',
    ...renderTable('SNAP_I32', 'I32 头', SNAPSHOT_I32_LAYOUT, names),
    '',
    ...renderTable('SNAP_F64', 'F64 体', SNAPSHOT_F64_LAYOUT, names),
    '',
  ];
  return out.join('\n');
}

export interface GenResult {
  path: string;
  upToDate: boolean;
  wrote: boolean;
}

/** check = true 时只比较；否则内容不同才写。 */
export function genSnapshotOffsets(path: string = GEN_OFFSETS_PATH, check = false): GenResult {
  const text = renderSnapshotOffsets();
  const cur = existsSync(path) ? readFileSync(path, 'utf8') : null;
  const upToDate = cur === text;
  if (check || upToDate) return { path, upToDate, wrote: false };
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return { path, upToDate, wrote: true };
}

function main(argv: string[]): number {
  let check = false;
  let out = GEN_OFFSETS_PATH;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--check') check = true;
    else if (a === '--out' && i + 1 < argv.length) out = resolve(argv[++i]!);
    else {
      console.error(`contracts:gen：未知参数 ${a}（用法：bun run contracts:gen [--check] [--out <路径>]）`);
      return 2;
    }
  }
  const r = genSnapshotOffsets(out, check);
  const shown = relative(process.cwd(), r.path) || r.path;
  if (check) {
    if (r.upToDate) {
      console.log(`contracts:gen --check：${shown} 与 schema 一致（I32 ${SNAPSHOT_I32_LAYOUT.length} 槽，F64 ${SNAPSHOT_F64_LAYOUT.length} 槽）`);
      return 0;
    }
    console.error(`contracts:gen --check：${shown} 与 snapshot.schema.ts 不一致或缺失；请运行 bun run contracts:gen 并提交生成文件`);
    return 1;
  }
  console.log(
    r.wrote
      ? `contracts:gen：已写出 ${shown}（I32 ${SNAPSHOT_I32_LAYOUT.length} 槽，F64 ${SNAPSHOT_F64_LAYOUT.length} 槽）`
      : `contracts:gen：${shown} 已是最新，未改动`,
  );
  return 0;
}

if (import.meta.main) process.exit(main(process.argv.slice(2)));

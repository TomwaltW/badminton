/**
 * 回放格式 BMRP（计划 2.5"回放 BMRP"、9.2 #8：回放只存人的输入）。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。
 *
 * 全部小端。字节布局（fmt = 0，草案 v0）：
 *
 *   偏移   长度          字段
 *   0      4             magic 'BMRP'（0x42 0x4D 0x52 0x50）
 *   4      2             fmt u16 = 0
 *   6      2             保留 u16 = 0
 *   8      4             simVer u32（dist/sim.js 字节的 FNV-1a）
 *   12     4             contentHash u32
 *   16     4             tablesHash u32
 *   20     88            MatchCfg：22 × i32（match-cfg.ts 的 encodeMatchCfg 布局；seed 为 u32 位模式）
 *   108    4             inputCount u32
 *   112    16 × N        inputs：InputEvent 16 字节布局（input-event.ts）；只含人的输入，tick 单调不减
 *   …      4             totalTicks u32：本局步进的 tick 总数；每条输入的 tick < totalTicks
 *   …      4             hashCount u32 = ⌊totalTicks / 30⌋
 *   …      4 × hashCount 哈希 u32：hashes[i] = 步进完第 (i+1)·30 个 tick 后的 sim.hash()
 *   …      1             gameCount u8：终局比分的局数
 *   …      4 × gameCount 每局 2 × u16：[球员 0 得分, 球员 1 得分]
 *   末尾   4             前面所有字节的 FNV-1a（u32）
 *
 * 体积估算：头 112 B + 尾部定长 13 B；7 分快速赛约 2–3 分钟 ≈ 4,500 tick → 150 个哈希 ≈ 0.6 KB；
 * 人的输入每拍约 2–3 条（PREMOVE / DOWN / RELEASE），约 200 条 ≈ 3.2 KB；合计约 4 KB。
 * 11 分排位约 3–4 分钟 → 哈希 ≈ 1 KB、输入 ≈ 3.5 KB，合计约 4.5–5 KB。与计划"一局约 4–5 KB"一致。
 *
 * 解码先检查魔数、版本与结构长度，再核对尾部校验，最后做字段校验；任何一步失败抛 ReplayError（中文信息）。
 * 本文件自带逐字节 FNV-1a，不依赖 packages/sim。
 */

import type { InputEvent } from './api';
import { INPUT_EVENT_BYTES, InputEventError, decodeInputEvent, encodeInputEvent, validateInputEvent } from './input-event';
import { MATCH_CFG_I32_LEN, PLAYER_KIND, decodeMatchCfg, encodeMatchCfg, validateMatchCfg, type MatchCfg } from './match-cfg';

/** 'BMRP' 四个字节。 */
export const REPLAY_MAGIC_0 = 0x42;
export const REPLAY_MAGIC_1 = 0x4d;
export const REPLAY_MAGIC_2 = 0x52;
export const REPLAY_MAGIC_3 = 0x50;
/** 格式版本：0 = 草案 v0。 */
export const REPLAY_FMT = 0;
/** 每 30 tick（1 秒）记一个状态哈希。 */
export const REPLAY_HASH_EVERY_TICKS = 30;

/** 定长头里的字节偏移。 */
export const RP_MAGIC = 0;
export const RP_FMT = 4;
export const RP_RESERVED = 6;
export const RP_SIM_VER = 8;
export const RP_CONTENT_HASH = 12;
export const RP_TABLES_HASH = 16;
export const RP_MATCH_CFG = 20;
export const RP_INPUT_COUNT = RP_MATCH_CFG + MATCH_CFG_I32_LEN * 4;
export const RP_INPUTS = RP_INPUT_COUNT + 4;
/** 定长头字节数（112）。 */
export const REPLAY_HEADER_BYTES = RP_INPUTS;
/** 尾部校验字节数。 */
export const REPLAY_CHECKSUM_BYTES = 4;
/** 最短的合法回放（无输入、无哈希、0 局）：112 + 4 + 4 + 1 + 4 = 125 字节。 */
export const REPLAY_MIN_BYTES = REPLAY_HEADER_BYTES + 4 + 4 + 1 + REPLAY_CHECKSUM_BYTES;
/** 终局比分最多 255 局（u8）。 */
export const REPLAY_MAX_GAMES = 255;

const U32_MAX = 4294967295;
const U16_MAX = 65535;

export interface Replay {
  simVer: number; // u32
  contentHash: number; // u32
  tablesHash: number; // u32
  cfg: MatchCfg;
  inputs: InputEvent[]; // 只含人的输入，tick 单调不减
  totalTicks: number; // u32
  hashes: number[]; // u32，长度 = ⌊totalTicks / 30⌋
  games: [number, number][]; // 每局 [球员 0, 球员 1] 得分（u16）
}

export type ReplayErrorCode = 'magic' | 'fmt' | 'length' | 'checksum' | 'field';

/** 回放编解码错误；code 区分类别，message 为中文说明。 */
export class ReplayError extends Error {
  readonly code: ReplayErrorCode;
  constructor(code: ReplayErrorCode, message: string) {
    super(`BMRP ${message}`);
    this.name = 'ReplayError';
    this.code = code;
  }
}

/** 逐字节 FNV-1a（u32），覆盖 bytes[from .. to)。与 sim/hash.ts 的 fnvBytes 定义相同。 */
export function replayFnv1a(bytes: Uint8Array, from: number, to: number): number {
  let h = 0x811c9dc5 | 0;
  for (let i = from; i < to; i++) h = Math.imul(h ^ bytes[i], 0x01000193);
  return h >>> 0;
}

/** 给定各段条数时回放的总字节数。 */
export function replayByteLength(inputCount: number, hashCount: number, gameCount: number): number {
  return REPLAY_HEADER_BYTES + INPUT_EVENT_BYTES * inputCount + 8 + 4 * hashCount + 1 + 4 * gameCount + REPLAY_CHECKSUM_BYTES;
}

/** totalTicks 对应的哈希个数：⌊totalTicks / 30⌋。 */
export function replayHashCount(totalTicks: number): number {
  return Math.floor(totalTicks / REPLAY_HASH_EVERY_TICKS);
}

function isInt(v: number, lo: number, hi: number): boolean {
  return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi;
}

/**
 * 回放内容的字段校验（编码前与解码后共用）；合法返回 null，否则返回第一条中文错误。
 * 规则：三个哈希为 u32；MatchCfg 合法；输入合法、只属于人、tick 单调不减且 < totalTicks；
 * hashes 长度 = ⌊totalTicks / 30⌋ 且每个为 u32；局数 ≤ 255、每局比分为 u16。
 */
export function validateReplay(r: Replay): string | null {
  if (r === null || typeof r !== 'object') return `回放必须是对象：${String(r)}`;
  if (!isInt(r.simVer, 0, U32_MAX)) return `simVer 必须是 u32：${String(r.simVer)}`;
  if (!isInt(r.contentHash, 0, U32_MAX)) return `contentHash 必须是 u32：${String(r.contentHash)}`;
  if (!isInt(r.tablesHash, 0, U32_MAX)) return `tablesHash 必须是 u32：${String(r.tablesHash)}`;
  const cfgErrs = validateMatchCfg(r.cfg);
  if (cfgErrs.length > 0) return `MatchCfg 不合法：${cfgErrs.join('；')}`;
  if (!isInt(r.totalTicks, 0, U32_MAX)) return `totalTicks 必须是 u32：${String(r.totalTicks)}`;
  if (!Array.isArray(r.inputs)) return 'inputs 必须是数组';
  let lastTick = 0;
  for (let i = 0; i < r.inputs.length; i++) {
    const ev = r.inputs[i];
    const err = validateInputEvent(ev);
    if (err !== null) return `第 ${i} 条输入不合法：${err}`;
    if (r.cfg.players[ev.player].kind !== PLAYER_KIND.HUMAN) {
      return `第 ${i} 条输入属于球员 ${ev.player}，而它在 MatchCfg 里是 AI：回放只存人的输入`;
    }
    if (ev.tick < lastTick) return `第 ${i} 条输入的 tick ${ev.tick} 小于前一条的 ${lastTick}：tick 必须单调不减`;
    if (ev.tick >= r.totalTicks) return `第 ${i} 条输入的 tick ${ev.tick} 不小于 totalTicks ${r.totalTicks}`;
    lastTick = ev.tick;
  }
  if (!Array.isArray(r.hashes)) return 'hashes 必须是数组';
  const want = replayHashCount(r.totalTicks);
  if (r.hashes.length !== want) {
    return `哈希个数应为 ⌊totalTicks / ${REPLAY_HASH_EVERY_TICKS}⌋ = ${want}，实际为 ${r.hashes.length}`;
  }
  for (let i = 0; i < r.hashes.length; i++) {
    if (!isInt(r.hashes[i], 0, U32_MAX)) return `第 ${i} 个哈希必须是 u32：${String(r.hashes[i])}`;
  }
  if (!Array.isArray(r.games)) return 'games 必须是数组';
  if (r.games.length > REPLAY_MAX_GAMES) return `局数超过 ${REPLAY_MAX_GAMES}：${r.games.length}`;
  for (let i = 0; i < r.games.length; i++) {
    const g = r.games[i];
    if (!Array.isArray(g) || g.length !== 2 || !isInt(g[0], 0, U16_MAX) || !isInt(g[1], 0, U16_MAX)) {
      return `第 ${i} 局比分必须是两个 0..65535 的整数：${String(g)}`;
    }
  }
  return null;
}

/** 编码。字段不合法（含 AI 的输入）抛 ReplayError('field')。 */
export function encodeReplay(r: Replay): Uint8Array {
  const err = validateReplay(r);
  if (err !== null) throw new ReplayError('field', `编码失败：${err}`);
  const n = replayByteLength(r.inputs.length, r.hashes.length, r.games.length);
  const bytes = new Uint8Array(n);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  bytes[RP_MAGIC] = REPLAY_MAGIC_0;
  bytes[RP_MAGIC + 1] = REPLAY_MAGIC_1;
  bytes[RP_MAGIC + 2] = REPLAY_MAGIC_2;
  bytes[RP_MAGIC + 3] = REPLAY_MAGIC_3;
  view.setUint16(RP_FMT, REPLAY_FMT, true);
  view.setUint16(RP_RESERVED, 0, true);
  view.setUint32(RP_SIM_VER, r.simVer, true);
  view.setUint32(RP_CONTENT_HASH, r.contentHash, true);
  view.setUint32(RP_TABLES_HASH, r.tablesHash, true);
  const cfg = new Int32Array(MATCH_CFG_I32_LEN);
  encodeMatchCfg(r.cfg, cfg, 0);
  for (let i = 0; i < MATCH_CFG_I32_LEN; i++) view.setInt32(RP_MATCH_CFG + 4 * i, cfg[i], true);
  view.setUint32(RP_INPUT_COUNT, r.inputs.length, true);
  let p = RP_INPUTS;
  for (let i = 0; i < r.inputs.length; i++) {
    encodeInputEvent(r.inputs[i], view, p);
    p += INPUT_EVENT_BYTES;
  }
  view.setUint32(p, r.totalTicks, true);
  view.setUint32(p + 4, r.hashes.length, true);
  p += 8;
  for (let i = 0; i < r.hashes.length; i++) {
    view.setUint32(p, r.hashes[i], true);
    p += 4;
  }
  view.setUint8(p, r.games.length);
  p += 1;
  for (let i = 0; i < r.games.length; i++) {
    view.setUint16(p, r.games[i][0], true);
    view.setUint16(p + 2, r.games[i][1], true);
    p += 4;
  }
  view.setUint32(p, replayFnv1a(bytes, 0, p), true);
  return bytes;
}

/**
 * 解码。依次检查：魔数 → 版本 → 结构长度（截断或多余字节）→ 尾部校验 → 保留字段与各字段合法性；
 * 任何一步失败抛 ReplayError。
 */
export function decodeReplay(bytes: Uint8Array): Replay {
  const n = bytes.length;
  if (n < 4) throw new ReplayError('length', `数据只有 ${n} 字节，连魔数都放不下`);
  if (
    bytes[RP_MAGIC] !== REPLAY_MAGIC_0 ||
    bytes[RP_MAGIC + 1] !== REPLAY_MAGIC_1 ||
    bytes[RP_MAGIC + 2] !== REPLAY_MAGIC_2 ||
    bytes[RP_MAGIC + 3] !== REPLAY_MAGIC_3
  ) {
    throw new ReplayError('magic', "魔数不是 'BMRP'：这不是回放文件");
  }
  if (n < RP_FMT + 2) throw new ReplayError('length', `数据只有 ${n} 字节，读不到格式版本`);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const fmt = view.getUint16(RP_FMT, true);
  if (fmt !== REPLAY_FMT) throw new ReplayError('fmt', `不支持的格式版本 fmt = ${fmt}（本解码器只认 ${REPLAY_FMT}，草案 v0）`);
  if (n < REPLAY_MIN_BYTES) throw new ReplayError('length', `数据只有 ${n} 字节，少于最短回放 ${REPLAY_MIN_BYTES} 字节（截断）`);

  // 结构：先只读计数，确认每段都在范围内，再分配。
  const inputCount = view.getUint32(RP_INPUT_COUNT, true);
  const tailAt = RP_INPUTS + INPUT_EVENT_BYTES * inputCount;
  if (tailAt + 8 + 1 + REPLAY_CHECKSUM_BYTES > n) {
    throw new ReplayError('length', `inputCount = ${inputCount} 需要的字节超出数据长度 ${n}（截断或计数损坏）`);
  }
  const totalTicks = view.getUint32(tailAt, true);
  const hashCount = view.getUint32(tailAt + 4, true);
  const hashesAt = tailAt + 8;
  const gamesCountAt = hashesAt + 4 * hashCount;
  if (gamesCountAt + 1 + REPLAY_CHECKSUM_BYTES > n) {
    throw new ReplayError('length', `hashCount = ${hashCount} 需要的字节超出数据长度 ${n}（截断或计数损坏）`);
  }
  const gameCount = view.getUint8(gamesCountAt);
  const gamesAt = gamesCountAt + 1;
  const sumAt = gamesAt + 4 * gameCount;
  if (sumAt + REPLAY_CHECKSUM_BYTES !== n) {
    const why = sumAt + REPLAY_CHECKSUM_BYTES > n ? '截断' : '末尾有多余字节';
    throw new ReplayError('length', `按各段计数应为 ${sumAt + REPLAY_CHECKSUM_BYTES} 字节，实际 ${n} 字节（${why}）`);
  }

  const want = view.getUint32(sumAt, true);
  const got = replayFnv1a(bytes, 0, sumAt);
  if (want !== got) {
    throw new ReplayError('checksum', `校验不符：文件记录 ${hex8(want)}，实际计算 ${hex8(got)}（数据损坏）`);
  }

  const reserved = view.getUint16(RP_RESERVED, true);
  if (reserved !== 0) throw new ReplayError('field', `保留字段必须为 0：${reserved}`);
  const cfgI32 = new Int32Array(MATCH_CFG_I32_LEN);
  for (let i = 0; i < MATCH_CFG_I32_LEN; i++) cfgI32[i] = view.getInt32(RP_MATCH_CFG + 4 * i, true);
  const inputs: InputEvent[] = [];
  for (let i = 0; i < inputCount; i++) {
    try {
      inputs.push(decodeInputEvent(view, RP_INPUTS + INPUT_EVENT_BYTES * i));
    } catch (e) {
      if (e instanceof InputEventError) throw new ReplayError('field', `第 ${i} 条输入：${e.message}`);
      throw e;
    }
  }
  const hashes: number[] = [];
  for (let i = 0; i < hashCount; i++) hashes.push(view.getUint32(hashesAt + 4 * i, true));
  const games: [number, number][] = [];
  for (let i = 0; i < gameCount; i++) {
    games.push([view.getUint16(gamesAt + 4 * i, true), view.getUint16(gamesAt + 4 * i + 2, true)]);
  }
  const r: Replay = {
    simVer: view.getUint32(RP_SIM_VER, true),
    contentHash: view.getUint32(RP_CONTENT_HASH, true),
    tablesHash: view.getUint32(RP_TABLES_HASH, true),
    cfg: decodeMatchCfg(cfgI32, 0),
    inputs,
    totalTicks,
    hashes,
    games,
  };
  const err = validateReplay(r);
  if (err !== null) throw new ReplayError('field', `字段不合法：${err}`);
  return r;
}

function hex8(u: number): string {
  const s = (u >>> 0).toString(16);
  return '00000000'.slice(s.length) + s;
}

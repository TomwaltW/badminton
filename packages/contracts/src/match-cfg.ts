/**
 * 对局配置 MatchCfg / PlayerCfg（计划 2.3、2.5、9.2 #9）。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。
 *
 * MatchCfg "原样写进回放头与快照 I32 头"：两处都用本文件的 encodeMatchCfg / decodeMatchCfg，
 * 布局是 MATCH_CFG_I32_LEN = 22 个 int32：
 *
 *   [0] rulesId  [1] seed（u32 按位存成 i32）  [2] venueId  [3] ddaEnabled  [4] staminaEnabled  [5] abGroup
 *   [6 .. 13]  球员 0：kind, aiLevel, windowScalePermille, alphaScalePermille,
 *              scatterScalePermille, runSpeedPermille, staminaMaxPermille, inputOffsetMs
 *   [14 .. 21] 球员 1：同上
 *
 * 字段顺序即 2.3 节接口的书写顺序；只许在末尾追加（追加即 bump 契约版本）。
 * 装备与属性只作用于 α、散布、跑速、体力上限四项（不碰 v0 与 v_t，查表不受影响）。
 * 所有字段都不许 −0（经 Int32Array 读回成 +0，见 api.ts 的 NEG_ZERO_HINT）：validateMatchCfg 报错，encodeMatchCfg 抛错。
 */

import { NEG_ZERO_HINT } from './api';

/** 分制（计划 2.3；方案 §2.1）。0 保留为非法。 */
export const RULES_ID = {
  /** 快速赛：先到 7 分，6 平后下一分决胜。 */
  QUICK7: 1,
  /** 标准 / 排位：先到 11 分，10 平后领先 2 分，13 分封顶。 */
  RANKED11: 2,
  /** 国际 15 分制（可选运营活动）：14 平领先 2 分，21 分封顶。 */
  INTL15: 3,
  /** 新手引导教学赛：先到 5 分。 */
  TUTORIAL5: 4,
} as const;
export type RulesId = (typeof RULES_ID)[keyof typeof RULES_ID];

/** 球员类型：0 人，1 AI。 */
export const PLAYER_KIND = {
  HUMAN: 0,
  AI: 1,
} as const;
export type PlayerKind = (typeof PLAYER_KIND)[keyof typeof PLAYER_KIND];

export interface PlayerCfg {
  kind: 0 | 1; // 0 人，1 AI
  aiLevel: number; // 1..10，人为 0
  windowScalePermille: number; // 默认 1000；新手 1200–1300（方案 §2.3）
  alphaScalePermille: number; // 装备与属性只作用于这四项（不碰 v0 与 v_t，查表不受影响）
  scatterScalePermille: number;
  runSpeedPermille: number;
  staminaMaxPermille: number;
  inputOffsetMs: number; // 延迟校准滑杆值，仅作审计：客户端已在量化前扣除
}

export interface MatchCfg {
  rulesId: number; // QUICK7 | RANKED11 | INTL15 | TUTORIAL5
  seed: number; // 挑战与周挑战由服务端下发；单机本地生成（u32）
  venueId: number; // 纯外观，不进物理
  ddaEnabled: 0 | 1; // 排位与好友约战强制 0
  staminaEnabled: 0 | 1; // 体力 A/B
  abGroup: number;
  players: [PlayerCfg, PlayerCfg];
}

// ---- I32 布局（偏移相对 encodeMatchCfg 的 off） ----

export const MATCH_CFG_RULES_ID = 0;
export const MATCH_CFG_SEED = 1;
export const MATCH_CFG_VENUE_ID = 2;
export const MATCH_CFG_DDA_ENABLED = 3;
export const MATCH_CFG_STAMINA_ENABLED = 4;
export const MATCH_CFG_AB_GROUP = 5;
/** 球员 0 的起点；球员 p 的起点 = MATCH_CFG_PLAYERS + p × PLAYER_CFG_I32_LEN。 */
export const MATCH_CFG_PLAYERS = 6;

/** PlayerCfg 内的偏移。 */
export const PLAYER_CFG_KIND = 0;
export const PLAYER_CFG_AI_LEVEL = 1;
export const PLAYER_CFG_WINDOW_SCALE_PERMILLE = 2;
export const PLAYER_CFG_ALPHA_SCALE_PERMILLE = 3;
export const PLAYER_CFG_SCATTER_SCALE_PERMILLE = 4;
export const PLAYER_CFG_RUN_SPEED_PERMILLE = 5;
export const PLAYER_CFG_STAMINA_MAX_PERMILLE = 6;
export const PLAYER_CFG_INPUT_OFFSET_MS = 7;
export const PLAYER_CFG_I32_LEN = 8;

/** MatchCfg 编码后的 int32 个数：6 + 2 × 8 = 22。 */
export const MATCH_CFG_I32_LEN = MATCH_CFG_PLAYERS + 2 * PLAYER_CFG_I32_LEN;

// ---- 取值范围（validateMatchCfg 与文档共用） ----

export const AI_LEVEL_MIN = 1;
export const AI_LEVEL_MAX = 10;
/** 各 permille 缩放的合法范围（含两端）：正整数，最大 5 倍。 */
export const PERMILLE_MIN = 1;
export const PERMILLE_MAX = 5000;
/** PlayerCfg.inputOffsetMs（延迟校准滑杆）的范围（方案 §2.3：−150…+150 ms）；别与 api.ts 的 INPUT_OFFSET_MIN_MS（offMs 下限 −128）混淆。 */
export const PLAYER_INPUT_OFFSET_MS_MIN = -150;
export const PLAYER_INPUT_OFFSET_MS_MAX = 150;
/** 未指定档位时 AI 的默认档位（草案默认值，待审定）。 */
export const AI_LEVEL_DEFAULT = 5;

const I32_MIN = -2147483648;
const I32_MAX = 2147483647;
const U32_MAX = 4294967295;

/** 球员 p 在 MatchCfg 编码里的起点（相对 off）。 */
export function matchCfgPlayerOffset(p: 0 | 1): number {
  return MATCH_CFG_PLAYERS + p * PLAYER_CFG_I32_LEN;
}

/** 默认球员配置：人 aiLevel = 0；AI 默认 AI_LEVEL_DEFAULT 档；各缩放 1000‰，延迟校准 0。 */
export function defaultPlayerCfg(kind: 0 | 1, aiLevel?: number): PlayerCfg {
  return {
    kind,
    aiLevel: kind === PLAYER_KIND.HUMAN ? 0 : aiLevel === undefined ? AI_LEVEL_DEFAULT : aiLevel,
    windowScalePermille: 1000,
    alphaScalePermille: 1000,
    scatterScalePermille: 1000,
    runSpeedPermille: 1000,
    staminaMaxPermille: 1000,
    inputOffsetMs: 0,
  };
}

/** 默认对局：快速赛 7 分、默认场馆、DDA 关、体力开、A/B 组 0；球员 0 为人，球员 1 为默认档 AI。 */
export function defaultMatchCfg(seed: number): MatchCfg {
  return {
    rulesId: RULES_ID.QUICK7,
    seed: seed >>> 0,
    venueId: 0,
    ddaEnabled: 0,
    staminaEnabled: 1,
    abGroup: 0,
    players: [defaultPlayerCfg(PLAYER_KIND.HUMAN), defaultPlayerCfg(PLAYER_KIND.AI)],
  };
}

/** [lo, hi] 内的整数，且不是 −0（−0 经 Int32Array 读回成 +0，见 NEG_ZERO_HINT）。 */
function isInt(v: number, lo: number, hi: number): boolean {
  return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi && !Object.is(v, -0);
}

/** 只取 0 / 1 的开关字段；−0 不算 0。 */
function isBit(v: number): boolean {
  return (v === 0 || v === 1) && !Object.is(v, -0);
}

/** 错误信息里显示字段值：String(−0) 是 "0"，所以 −0 显式写出并附 NEG_ZERO_HINT。只在失败路径调用。 */
function show(v: unknown): string {
  return Object.is(v, -0) ? `−0（${NEG_ZERO_HINT}）` : String(v);
}

function checkI32(v: number, name: string): void {
  if (!isInt(v, I32_MIN, I32_MAX)) throw new RangeError(`MatchCfg.${name} 必须是 int32 范围内的整数，实际为 ${show(v)}`);
}

/** 检查球员 p 的 8 个字段都能无损存进 int32；成功路径不分配（名字都是常量串）。 */
function checkPlayerI32(pc: PlayerCfg): void {
  if (pc === null || typeof pc !== 'object') throw new RangeError('MatchCfg.players[] 缺失或不是对象');
  checkI32(pc.kind, 'players[].kind');
  checkI32(pc.aiLevel, 'players[].aiLevel');
  checkI32(pc.windowScalePermille, 'players[].windowScalePermille');
  checkI32(pc.alphaScalePermille, 'players[].alphaScalePermille');
  checkI32(pc.scatterScalePermille, 'players[].scatterScalePermille');
  checkI32(pc.runSpeedPermille, 'players[].runSpeedPermille');
  checkI32(pc.staminaMaxPermille, 'players[].staminaMaxPermille');
  checkI32(pc.inputOffsetMs, 'players[].inputOffsetMs');
}

function checkRange(arr: Int32Array, off: number, what: string): void {
  if (!isInt(off, 0, I32_MAX) || off + MATCH_CFG_I32_LEN > arr.length) {
    throw new RangeError(`${what}：偏移 ${show(off)} 起放不下 ${MATCH_CFG_I32_LEN} 个 int32（数组长度 ${arr.length}）`);
  }
}

/**
 * 把 cfg 写进 dst[off .. off + 22)。seed 按 u32 的位模式存成 i32（seed | 0）。
 * 越界或字段不是整数（会被 Int32Array 静默截断的值）时抛 RangeError；先整体检查再写，
 * 抛错时 dst 一个槽都不改（快照头不会被写成半份）。
 * 不检查业务范围（档位、permille 等），那是 validateMatchCfg 的事。
 */
export function encodeMatchCfg(cfg: MatchCfg, dst: Int32Array, off: number): void {
  checkRange(dst, off, 'encodeMatchCfg');
  if (!isInt(cfg.seed, I32_MIN, U32_MAX)) {
    throw new RangeError(`MatchCfg.seed 必须是 u32（或 i32 位模式）整数，实际为 ${show(cfg.seed)}`);
  }
  if (cfg.players === undefined || cfg.players === null || cfg.players.length !== 2) {
    throw new RangeError('MatchCfg.players 必须恰好 2 名球员');
  }
  checkI32(cfg.rulesId, 'rulesId');
  checkI32(cfg.venueId, 'venueId');
  checkI32(cfg.ddaEnabled, 'ddaEnabled');
  checkI32(cfg.staminaEnabled, 'staminaEnabled');
  checkI32(cfg.abGroup, 'abGroup');
  checkPlayerI32(cfg.players[0]);
  checkPlayerI32(cfg.players[1]);
  dst[off + MATCH_CFG_RULES_ID] = cfg.rulesId;
  dst[off + MATCH_CFG_SEED] = cfg.seed | 0;
  dst[off + MATCH_CFG_VENUE_ID] = cfg.venueId;
  dst[off + MATCH_CFG_DDA_ENABLED] = cfg.ddaEnabled;
  dst[off + MATCH_CFG_STAMINA_ENABLED] = cfg.staminaEnabled;
  dst[off + MATCH_CFG_AB_GROUP] = cfg.abGroup;
  for (let p = 0; p < 2; p++) {
    const pc = cfg.players[p];
    const o = off + MATCH_CFG_PLAYERS + p * PLAYER_CFG_I32_LEN;
    dst[o + PLAYER_CFG_KIND] = pc.kind;
    dst[o + PLAYER_CFG_AI_LEVEL] = pc.aiLevel;
    dst[o + PLAYER_CFG_WINDOW_SCALE_PERMILLE] = pc.windowScalePermille;
    dst[o + PLAYER_CFG_ALPHA_SCALE_PERMILLE] = pc.alphaScalePermille;
    dst[o + PLAYER_CFG_SCATTER_SCALE_PERMILLE] = pc.scatterScalePermille;
    dst[o + PLAYER_CFG_RUN_SPEED_PERMILLE] = pc.runSpeedPermille;
    dst[o + PLAYER_CFG_STAMINA_MAX_PERMILLE] = pc.staminaMaxPermille;
    dst[o + PLAYER_CFG_INPUT_OFFSET_MS] = pc.inputOffsetMs;
  }
}

function decodePlayer(src: Int32Array, o: number): PlayerCfg {
  return {
    kind: src[o + PLAYER_CFG_KIND] as 0 | 1,
    aiLevel: src[o + PLAYER_CFG_AI_LEVEL],
    windowScalePermille: src[o + PLAYER_CFG_WINDOW_SCALE_PERMILLE],
    alphaScalePermille: src[o + PLAYER_CFG_ALPHA_SCALE_PERMILLE],
    scatterScalePermille: src[o + PLAYER_CFG_SCATTER_SCALE_PERMILLE],
    runSpeedPermille: src[o + PLAYER_CFG_RUN_SPEED_PERMILLE],
    staminaMaxPermille: src[o + PLAYER_CFG_STAMINA_MAX_PERMILLE],
    inputOffsetMs: src[o + PLAYER_CFG_INPUT_OFFSET_MS],
  };
}

/**
 * 从 src[off .. off + 22) 读回 MatchCfg；seed 读回 u32（>>> 0）。
 * 只做越界检查，不做业务校验：读不可信数据（回放、快照）后请再调 validateMatchCfg。
 */
export function decodeMatchCfg(src: Int32Array, off: number): MatchCfg {
  checkRange(src, off, 'decodeMatchCfg');
  return {
    rulesId: src[off + MATCH_CFG_RULES_ID],
    seed: src[off + MATCH_CFG_SEED] >>> 0,
    venueId: src[off + MATCH_CFG_VENUE_ID],
    ddaEnabled: src[off + MATCH_CFG_DDA_ENABLED] as 0 | 1,
    staminaEnabled: src[off + MATCH_CFG_STAMINA_ENABLED] as 0 | 1,
    abGroup: src[off + MATCH_CFG_AB_GROUP],
    players: [decodePlayer(src, off + MATCH_CFG_PLAYERS), decodePlayer(src, off + MATCH_CFG_PLAYERS + PLAYER_CFG_I32_LEN)],
  };
}

const PERMILLE_FIELDS = [
  'windowScalePermille',
  'alphaScalePermille',
  'scatterScalePermille',
  'runSpeedPermille',
  'staminaMaxPermille',
] as const;

function isKnownRulesId(v: number): boolean {
  return v === RULES_ID.QUICK7 || v === RULES_ID.RANKED11 || v === RULES_ID.INTL15 || v === RULES_ID.TUTORIAL5;
}

/**
 * 业务校验；返回中文错误列表，合法时为空数组。
 * 规则：rulesId 已知；seed 为 u32；venueId、abGroup 为非负 int32；开关只取 0/1；
 * 排位赛（RANKED11）强制 ddaEnabled = 0；kind 只取 0/1；人 aiLevel = 0、AI 为 1..10；
 * 五项 permille 为 1..5000 的整数；inputOffsetMs 为 −150..150 的整数；任何字段取 −0 都不合法（NEG_ZERO_HINT）。
 */
export function validateMatchCfg(cfg: MatchCfg): string[] {
  const errs: string[] = [];
  if (cfg === null || typeof cfg !== 'object') {
    errs.push(`MatchCfg 必须是对象：${String(cfg)}`);
    return errs;
  }
  if (!isInt(cfg.rulesId, I32_MIN, I32_MAX) || !isKnownRulesId(cfg.rulesId)) {
    errs.push(`rulesId 未知：${show(cfg.rulesId)}（只许 1 QUICK7、2 RANKED11、3 INTL15、4 TUTORIAL5）`);
  }
  if (!isInt(cfg.seed, 0, U32_MAX)) errs.push(`seed 必须是 0..4294967295 的整数：${show(cfg.seed)}`);
  if (!isInt(cfg.venueId, 0, I32_MAX)) errs.push(`venueId 必须是非负 int32 整数：${show(cfg.venueId)}`);
  if (!isBit(cfg.ddaEnabled)) errs.push(`ddaEnabled 只能是 0 或 1：${show(cfg.ddaEnabled)}`);
  if (!isBit(cfg.staminaEnabled)) errs.push(`staminaEnabled 只能是 0 或 1：${show(cfg.staminaEnabled)}`);
  if (cfg.rulesId === RULES_ID.RANKED11 && cfg.ddaEnabled !== 0) errs.push('排位赛（RANKED11）必须关闭动态难度：ddaEnabled 应为 0');
  if (!isInt(cfg.abGroup, 0, I32_MAX)) errs.push(`abGroup 必须是非负 int32 整数：${show(cfg.abGroup)}`);
  if (!Array.isArray(cfg.players) || cfg.players.length !== 2) {
    errs.push('players 必须恰好 2 名球员');
    return errs;
  }
  for (let p = 0; p < 2; p++) {
    const pc = cfg.players[p];
    const who = `players[${p}]`;
    if (pc === null || typeof pc !== 'object') {
      errs.push(`${who} 缺失`);
      continue;
    }
    if (!isBit(pc.kind)) {
      errs.push(`${who}.kind 只能是 0（人）或 1（AI）：${show(pc.kind)}`);
    } else if (pc.kind === PLAYER_KIND.HUMAN && !isInt(pc.aiLevel, 0, 0)) {
      errs.push(`${who} 是人，aiLevel 必须为 0：${show(pc.aiLevel)}`);
    } else if (pc.kind === PLAYER_KIND.AI && !isInt(pc.aiLevel, AI_LEVEL_MIN, AI_LEVEL_MAX)) {
      errs.push(`${who} 是 AI，aiLevel 必须是 ${AI_LEVEL_MIN}..${AI_LEVEL_MAX} 的整数：${show(pc.aiLevel)}`);
    }
    for (const f of PERMILLE_FIELDS) {
      if (!isInt(pc[f], PERMILLE_MIN, PERMILLE_MAX)) {
        errs.push(`${who}.${f} 必须是 ${PERMILLE_MIN}..${PERMILLE_MAX} 的整数（‰）：${show(pc[f])}`);
      }
    }
    if (!isInt(pc.inputOffsetMs, PLAYER_INPUT_OFFSET_MS_MIN, PLAYER_INPUT_OFFSET_MS_MAX)) {
      errs.push(`${who}.inputOffsetMs 必须是 ${PLAYER_INPUT_OFFSET_MS_MIN}..${PLAYER_INPUT_OFFSET_MS_MAX} 的整数（ms）：${show(pc.inputOffsetMs)}`);
    }
  }
  return errs;
}

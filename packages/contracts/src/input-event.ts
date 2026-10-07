/**
 * InputEvent 的 16 字节二进制编码（计划 2.3：回放与 P2 线上同一 16 字节布局）。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。
 *
 * 小端布局（偏移为字节）：
 *
 *   [0..3]   tick   u32  被模拟"消费"的 tick
 *   [4]      offMs  i8   −128..127，相对该 tick 起点的毫秒
 *   [5]      bit0–3 kind（INPUT_KIND，0 非法）；bit4–6 保留，必须为 0；bit7 player（0/1）
 *   [6..7]   tx     i16  厘米
 *   [8..9]   tz     i16  厘米
 *   [10..11] dx     i16  ‰屏宽
 *   [12..13] dy     i16  ‰屏宽
 *   [14..15] durMs  u16  按下到松手
 *
 * 编码前逐字段检查范围，越界一律抛 RangeError（中文信息），绝不静默回绕或截断；
 * 整数字段（含 player）取 −0 也算不合法（读回会成 +0，见 api.ts 的 NEG_ZERO_HINT）。
 * 解码时 kind 非法或保留位非 0 抛 InputEventError。编码与解码在成功路径上零分配
 * （解码可写入调用方提供的对象）。
 */

import { INPUT_KIND, NEG_ZERO_HINT, type InputEvent, type InputKind } from './api';

/** 一条 InputEvent 的字节数。 */
export const INPUT_EVENT_BYTES = 16;

/** 字节偏移。 */
export const IE_TICK = 0;
export const IE_OFF_MS = 4;
export const IE_KIND_PLAYER = 5;
export const IE_TX = 6;
export const IE_TZ = 8;
export const IE_DX = 10;
export const IE_DY = 12;
export const IE_DUR_MS = 14;

/** 第 5 字节的位域。 */
export const IE_KIND_MASK = 0x0f;
export const IE_RESERVED_MASK = 0x70;
export const IE_PLAYER_BIT = 0x80;

const U32_MAX = 4294967295;
const I16_MIN = -32768;
const I16_MAX = 32767;
const U16_MAX = 65535;
const I8_MIN = -128;
const I8_MAX = 127;

/** 解码到非法内容（kind 非法、保留位非 0）时抛出。 */
export class InputEventError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InputEventError';
  }
}

/** [lo, hi] 内的整数，且不是 −0（−0 编码读回成 +0，见 NEG_ZERO_HINT）。 */
function isInt(v: number, lo: number, hi: number): boolean {
  return typeof v === 'number' && Math.floor(v) === v && v >= lo && v <= hi && !Object.is(v, -0);
}

/** 错误信息里显示字段值：String(−0) 是 "0"，所以 −0 显式写出并附 NEG_ZERO_HINT。只在失败路径调用。 */
function show(v: unknown): string {
  return Object.is(v, -0) ? `−0（${NEG_ZERO_HINT}）` : String(v);
}

/** kind 是否为已定义的 INPUT_KIND（1..4）。 */
export function isInputKind(k: number): k is InputKind {
  return k === INPUT_KIND.DOWN || k === INPUT_KIND.RELEASE || k === INPUT_KIND.PREMOVE || k === INPUT_KIND.CANCEL;
}

/** 逐字段检查；合法返回 null，否则返回第一条中文错误。成功路径不分配。 */
export function validateInputEvent(ev: InputEvent): string | null {
  if (ev === null || typeof ev !== 'object') return `InputEvent 必须是对象：${String(ev)}`;
  if (!isInt(ev.tick, 0, U32_MAX)) return `InputEvent.tick 必须是 0..4294967295 的整数：${show(ev.tick)}`;
  if (!isInt(ev.offMs, I8_MIN, I8_MAX)) return `InputEvent.offMs 必须是 −128..127 的整数：${show(ev.offMs)}`;
  if ((ev.player !== 0 && ev.player !== 1) || Object.is(ev.player, -0)) return `InputEvent.player 只能是 0 或 1：${show(ev.player)}`;
  if (!isInputKind(ev.kind)) return `InputEvent.kind 非法：${show(ev.kind)}（只许 1 DOWN、2 RELEASE、3 PREMOVE、4 CANCEL）`;
  if (!isInt(ev.tx, I16_MIN, I16_MAX)) return `InputEvent.tx 必须是 i16 整数（厘米）：${show(ev.tx)}`;
  if (!isInt(ev.tz, I16_MIN, I16_MAX)) return `InputEvent.tz 必须是 i16 整数（厘米）：${show(ev.tz)}`;
  if (!isInt(ev.dx, I16_MIN, I16_MAX)) return `InputEvent.dx 必须是 i16 整数（‰屏宽）：${show(ev.dx)}`;
  if (!isInt(ev.dy, I16_MIN, I16_MAX)) return `InputEvent.dy 必须是 i16 整数（‰屏宽）：${show(ev.dy)}`;
  if (!isInt(ev.durMs, 0, U16_MAX)) return `InputEvent.durMs 必须是 0..65535 的整数：${show(ev.durMs)}`;
  return null;
}

function checkSpan(view: DataView, off: number, what: string): void {
  if (!isInt(off, 0, U32_MAX) || off + INPUT_EVENT_BYTES > view.byteLength) {
    throw new RangeError(`${what}：偏移 ${show(off)} 起放不下 ${INPUT_EVENT_BYTES} 字节（视图长度 ${view.byteLength}）`);
  }
}

/** 把 ev 写进 view[off .. off + 16)。越界或字段超范围抛 RangeError。 */
export function encodeInputEvent(ev: InputEvent, view: DataView, off: number): void {
  checkSpan(view, off, 'encodeInputEvent');
  const err = validateInputEvent(ev);
  if (err !== null) throw new RangeError(err);
  view.setUint32(off + IE_TICK, ev.tick, true);
  view.setInt8(off + IE_OFF_MS, ev.offMs);
  view.setUint8(off + IE_KIND_PLAYER, (ev.kind & IE_KIND_MASK) | (ev.player === 1 ? IE_PLAYER_BIT : 0));
  view.setInt16(off + IE_TX, ev.tx, true);
  view.setInt16(off + IE_TZ, ev.tz, true);
  view.setInt16(off + IE_DX, ev.dx, true);
  view.setInt16(off + IE_DY, ev.dy, true);
  view.setUint16(off + IE_DUR_MS, ev.durMs, true);
}

/**
 * 从 view[off .. off + 16) 读出一条 InputEvent。传入 out 时写进 out 并返回它（零分配），
 * 否则新建对象。越界抛 RangeError；kind 非法或保留位非 0 抛 InputEventError。
 */
export function decodeInputEvent(view: DataView, off: number, out?: InputEvent): InputEvent {
  checkSpan(view, off, 'decodeInputEvent');
  const b = view.getUint8(off + IE_KIND_PLAYER);
  if ((b & IE_RESERVED_MASK) !== 0) {
    throw new InputEventError(`InputEvent 第 5 字节的保留位（bit4–6）必须为 0：0x${b.toString(16)}（偏移 ${off}）`);
  }
  const kind = b & IE_KIND_MASK;
  if (!isInputKind(kind)) throw new InputEventError(`InputEvent.kind 非法：${kind}（偏移 ${off}）`);
  const ev: InputEvent =
    out !== undefined ? out : { tick: 0, offMs: 0, player: 0, kind: INPUT_KIND.DOWN, tx: 0, tz: 0, dx: 0, dy: 0, durMs: 0 };
  ev.tick = view.getUint32(off + IE_TICK, true);
  ev.offMs = view.getInt8(off + IE_OFF_MS);
  ev.player = (b & IE_PLAYER_BIT) !== 0 ? 1 : 0;
  ev.kind = kind;
  ev.tx = view.getInt16(off + IE_TX, true);
  ev.tz = view.getInt16(off + IE_TZ, true);
  ev.dx = view.getInt16(off + IE_DX, true);
  ev.dy = view.getInt16(off + IE_DY, true);
  ev.durMs = view.getUint16(off + IE_DUR_MS, true);
  return ev;
}

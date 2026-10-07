/**
 * InputEvent 16 字节编解码：边界值往返、黄金字节（fixtures/input-events.v0.json）、越界抛错、
 * 非法 kind / 保留位解码抛错、零分配解码（写入调用方对象）。
 */
import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { INPUT_KIND, type InputEvent, type InputKind } from '../src/api';
import {
  IE_KIND_PLAYER,
  INPUT_EVENT_BYTES,
  InputEventError,
  decodeInputEvent,
  encodeInputEvent,
  validateInputEvent,
} from '../src/input-event';

const FIXTURE = resolve(import.meta.dir, '../fixtures/input-events.v0.json');

interface Golden {
  name: string;
  event: InputEvent;
  hex: string;
}

function fromHex(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

function encode(ev: InputEvent): Uint8Array {
  const b = new Uint8Array(INPUT_EVENT_BYTES);
  encodeInputEvent(ev, new DataView(b.buffer), 0);
  return b;
}

function ev(over: Partial<InputEvent> = {}): InputEvent {
  return { tick: 100, offMs: -5, player: 0, kind: INPUT_KIND.DOWN, tx: 10, tz: -20, dx: 30, dy: -40, durMs: 50, ...over };
}

const KINDS: InputKind[] = [INPUT_KIND.DOWN, INPUT_KIND.RELEASE, INPUT_KIND.PREMOVE, INPUT_KIND.CANCEL];
const TICKS = [0, 1, 2147483647, 2147483648, 4294967295];
const OFFS = [-128, -127, -1, 0, 1, 127];
const I16 = [-32768, -32767, -1, 0, 1, 32766, 32767];
const DURS = [0, 1, 255, 256, 65534, 65535];

describe('InputEvent 往返', () => {
  test('边界值组合逐字段往返', () => {
    const view = new DataView(new ArrayBuffer(INPUT_EVENT_BYTES));
    let n = 0;
    for (const tick of TICKS)
      for (const offMs of OFFS)
        for (const kind of KINDS)
          for (const player of [0, 1] as const)
            for (let k = 0; k < I16.length; k++) {
              const e: InputEvent = {
                tick,
                offMs,
                player,
                kind,
                tx: I16[k]!,
                tz: I16[(k + 1) % I16.length]!,
                dx: I16[(k + 3) % I16.length]!,
                dy: I16[(k + 5) % I16.length]!,
                durMs: DURS[(k + n) % DURS.length]!,
              };
              encodeInputEvent(e, view, 0);
              expect(decodeInputEvent(view, 0)).toEqual(e);
              n++;
            }
    expect(n).toBe(TICKS.length * OFFS.length * KINDS.length * 2 * I16.length);
  });

  test('在大缓冲区的任意偏移编码，不碰相邻字节', () => {
    const buf = new Uint8Array(64).fill(0xaa);
    const view = new DataView(buf.buffer);
    const e = ev({ tick: 4294967295, offMs: -128, player: 1, kind: INPUT_KIND.CANCEL });
    encodeInputEvent(e, view, 23);
    for (let i = 0; i < 23; i++) expect(buf[i]).toBe(0xaa);
    for (let i = 23 + INPUT_EVENT_BYTES; i < 64; i++) expect(buf[i]).toBe(0xaa);
    expect(decodeInputEvent(view, 23)).toEqual(e);
  });

  test('解码写入调用方对象（零分配）并返回同一引用', () => {
    const view = new DataView(encode(ev({ player: 1, kind: INPUT_KIND.PREMOVE, tx: -7 })).buffer);
    const out = ev({ tick: 999, player: 0, kind: INPUT_KIND.RELEASE });
    const r = decodeInputEvent(view, 0, out);
    expect(r).toBe(out);
    expect(out).toEqual(ev({ player: 1, kind: INPUT_KIND.PREMOVE, tx: -7 }));
  });

  test('非零 byteOffset 的 DataView 也按视图内偏移读写', () => {
    const backing = new ArrayBuffer(48);
    const view = new DataView(backing, 8, 32);
    const e = ev({ tick: 77, kind: INPUT_KIND.RELEASE });
    encodeInputEvent(e, view, 16);
    expect(decodeInputEvent(new DataView(backing), 24)).toEqual(e);
  });
});

describe('黄金字节（fixtures/input-events.v0.json）', () => {
  const golden = (JSON.parse(readFileSync(FIXTURE, 'utf8')) as { events: Golden[] }).events;

  test('夹具非空且覆盖四种 kind 与两名球员', () => {
    expect(golden.length).toBeGreaterThanOrEqual(5);
    expect(new Set(golden.map((g) => g.event.kind))).toEqual(new Set(KINDS));
    expect(new Set(golden.map((g) => g.event.player))).toEqual(new Set([0, 1]));
  });

  for (const g of golden) {
    test(`编码等于夹具字节：${g.name}`, () => {
      expect(toHex(encode(g.event))).toBe(g.hex);
    });
    test(`夹具字节解码等于事件：${g.name}`, () => {
      expect(decodeInputEvent(new DataView(fromHex(g.hex).buffer), 0)).toEqual(g.event);
    });
  }

  test('手算一条的布局：小端、kind 低 4 位、player 在 bit7', () => {
    const b = encode({ tick: 0x01020304, offMs: -2, player: 1, kind: INPUT_KIND.RELEASE, tx: 0x0506, tz: -2, dx: 0x0708, dy: 1, durMs: 0xabcd });
    expect(toHex(b)).toBe('04030201' + 'fe' + '82' + '0605' + 'feff' + '0807' + '0100' + 'cdab');
  });
});

describe('越界与非法字段', () => {
  test('缓冲区放不下 16 字节时编码、解码都抛 RangeError（中文信息）', () => {
    const view = new DataView(new ArrayBuffer(20));
    for (const off of [5, 19, 20, -1, 1.5, Number.NaN]) {
      expect(() => encodeInputEvent(ev(), view, off)).toThrow(RangeError);
      expect(() => decodeInputEvent(view, off)).toThrow(RangeError);
    }
    expect(() => encodeInputEvent(ev(), view, 5)).toThrow(/放不下/);
    expect(() => encodeInputEvent(ev(), view, 4)).not.toThrow();
  });

  const bad: [string, Partial<InputEvent>, RegExp][] = [
    ['tick < 0', { tick: -1 }, /tick/],
    ['tick ≥ 2^32', { tick: 4294967296 }, /tick/],
    ['tick 非整数', { tick: 1.5 }, /tick/],
    ['tick NaN', { tick: Number.NaN }, /tick/],
    ['offMs < −128', { offMs: -129 }, /offMs/],
    ['offMs > 127', { offMs: 128 }, /offMs/],
    ['player 2', { player: 2 as 0 }, /player/],
    ['kind 0', { kind: 0 as InputKind }, /kind/],
    ['kind 5', { kind: 5 as InputKind }, /kind/],
    ['tx 32768', { tx: 32768 }, /tx/],
    ['tz −32769', { tz: -32769 }, /tz/],
    ['dx 非整数', { dx: 0.5 }, /dx/],
    ['dy 无穷', { dy: Number.POSITIVE_INFINITY }, /dy/],
    ['durMs −1', { durMs: -1 }, /durMs/],
    ['durMs 65536', { durMs: 65536 }, /durMs/],
  ];
  for (const [name, over, re] of bad) {
    test(`编码拒绝：${name}（RangeError，不写任何字节）`, () => {
      const buf = new Uint8Array(INPUT_EVENT_BYTES).fill(0x5a);
      expect(() => encodeInputEvent(ev(over), new DataView(buf.buffer), 0)).toThrow(RangeError);
      expect(() => encodeInputEvent(ev(over), new DataView(buf.buffer), 0)).toThrow(re);
      expect(buf.every((b) => b === 0x5a)).toBe(true);
      const msg = validateInputEvent(ev(over));
      expect(msg).not.toBeNull();
      expect(msg!).toMatch(/[一-鿿]/);
    });
  }

  test('validateInputEvent 对合法事件返回 null', () => {
    expect(validateInputEvent(ev())).toBeNull();
  });

  test('不是对象时返回中文错误（不抛 TypeError），编码抛 RangeError', () => {
    for (const bad of [null, undefined, 3]) {
      expect(validateInputEvent(bad as unknown as InputEvent)).toMatch(/InputEvent 必须是对象/);
      expect(() => encodeInputEvent(bad as unknown as InputEvent, new DataView(new ArrayBuffer(16)), 0)).toThrow(RangeError);
    }
  });

  test('−0 不合法：每个整数字段（含 player）validate 报"|0 归一"、编码抛 RangeError；|0 归一后往返仍相等', () => {
    // 回归：Math.round(−0.3) = −0 曾能过校验，编码读回却成 +0：实时局拿原对象、回放 / P2 拿解码对象，
    // 对符号零敏感的计算（1/x、Math.sign、min/max 的零）会分歧。
    const negZero = Math.round(-0.3);
    expect(Object.is(negZero, -0)).toBe(true);
    for (const f of ['tick', 'offMs', 'player', 'tx', 'tz', 'dx', 'dy', 'durMs'] as const) {
      const e = ev();
      (e as unknown as Record<string, number>)[f] = negZero;
      const msg = validateInputEvent(e);
      expect([f, msg]).toEqual([f, expect.stringContaining(`InputEvent.${f}`)]);
      expect(msg!).toMatch(/−0 不合法：量化结果请 \|0 归一/);
      const buf = new Uint8Array(INPUT_EVENT_BYTES).fill(0x5a);
      expect(() => encodeInputEvent(e, new DataView(buf.buffer), 0)).toThrow(RangeError);
      expect(buf.every((b) => b === 0x5a)).toBe(true);
    }
    const ok = ev({ offMs: negZero | 0 });
    expect(validateInputEvent(ok)).toBeNull();
    expect(decodeInputEvent(new DataView(encode(ok).buffer), 0)).toEqual(ok);
  });

  test('解码：kind 为 0 或未定义值抛 InputEventError', () => {
    for (const b5 of [0x00, 0x05, 0x0f, 0x80, 0x8f]) {
      const buf = encode(ev());
      buf[IE_KIND_PLAYER] = b5;
      expect(() => decodeInputEvent(new DataView(buf.buffer), 0)).toThrow(InputEventError);
      expect(() => decodeInputEvent(new DataView(buf.buffer), 0)).toThrow(/kind 非法/);
    }
  });

  test('解码：保留位（bit4–6）非 0 抛 InputEventError', () => {
    for (const b5 of [0x11, 0x21, 0x41, 0x71, 0xf1]) {
      const buf = encode(ev());
      buf[IE_KIND_PLAYER] = b5;
      expect(() => decodeInputEvent(new DataView(buf.buffer), 0)).toThrow(/保留位/);
    }
  });

  test('解码：bit7 = player 1，低 4 位 = kind', () => {
    const buf = encode(ev());
    buf[IE_KIND_PLAYER] = 0x83;
    const d = decodeInputEvent(new DataView(buf.buffer), 0);
    expect(d.player).toBe(1);
    expect(d.kind).toBe(INPUT_KIND.PREMOVE);
  });

  test('全零记录不是合法事件（kind 0 保留）', () => {
    expect(() => decodeInputEvent(new DataView(new ArrayBuffer(INPUT_EVENT_BYTES)), 0)).toThrow(InputEventError);
  });
});

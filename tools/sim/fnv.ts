/** 工具侧的逐字节 FNV-1a（u32），与 packages/sim/src/hash.ts 的 fnvBytes 定义相同。 */
export function fnv1aBytes(bytes: Uint8Array): number {
  let h = 0x811c9dc5 | 0;
  for (let i = 0; i < bytes.length; i++) h = Math.imul(h ^ bytes[i]!, 0x01000193);
  return h >>> 0;
}

export function hex8(u: number): string {
  return (u >>> 0).toString(16).padStart(8, '0');
}

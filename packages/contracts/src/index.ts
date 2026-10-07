/**
 * @badminton/contracts 统一导出。
 *
 * 契约草案 v0，待 10-11 人工审定冻结。
 *
 * 模拟核心（packages/sim/src）只许 import type 本包；需要运行时常量（快照偏移等）时用相对路径导入具体模块。
 */
export * from './api';
export * from './match-cfg';
export * from './input-event';
export * from './snapshot.schema';
export * from './gen/snapshot-offsets';
export * from './replay';

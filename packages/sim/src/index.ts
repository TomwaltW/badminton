/**
 * esbuild 入口：打包成 dist/sim.js（IIFE、ES2017、不压缩），文件末尾把 API 显式挂到全局。
 *
 * 不用 esbuild 的 --global-name：它产生的顶层 var 在微信（每个文件的顶层变量只在本文件有效，
 * 全局对象是 GameGlobal）、Cocos 插件脚本、Node、Bun 里都不会成为全局（计划 2.2）。
 */

import { api, type BadmintonSimApi } from './api';

declare global {
  /** 由 dist/sim.js 末尾赋值的模拟核心 API。 */
  var BadmintonSim: BadmintonSimApi;
}

/** 微信小游戏的全局对象；其他环境不存在，用 typeof 判断。 */
declare const GameGlobal: typeof globalThis;

(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api;

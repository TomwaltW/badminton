/*
 * tools/wx-selftest/game.js：BadmintonSim 真机内核自测（计划 0 #2、6 章"真机内核自测"、7 章 G0）。
 *
 * 一个不依赖 Cocos 的空白微信小游戏工程的入口，用来回答"同一份 sim.js 在真机上算出的哈希是否等于 Node"：
 * 1. require('./sim.js')（由 bun run wx-selftest:sync 从 packages/sim/dist/sim.js 原样复制），
 *    从 GameGlobal 取 BadmintonSim（没有 GameGlobal 时退回 globalThis，便于在 Node / Bun 的 vm 里测试）；
 * 2. wx.createCanvas() 取主屏画布，先画"运行中…"，再用 setTimeout 让出一帧后跑内核语料；
 * 3. dsqrt 路径（正式路径）：BadmintonSim.kernel.run({ checkpoints: false })，用 Date.now() 计时，
 *    在屏幕与 console 输出一行
 *        DET <8 位十六进制哈希> <steps> <steps/s 取整>
 *    前两项与 bun run det --kernel 末尾打印的 "DET <dsqrt 哈希> <steps>" 直接比对（同一份 sim.js、默认拍数与种子）；
 * 4. 再让出一帧，跑 Math.sqrt 路径（sqrt 由这里从外部注入，sim.js 里不出现 Math.sqrt），输出参考行：
 *    Math.sqrt 路径的哈希与 steps、dsqrt 路径每 tick 的微秒数、语料版本、apiVersion；
 * 5. 任何异常都画到屏幕上（红字）并 console.error；wx.onError 收到的未捕获异常同样处理。
 *
 * 写法约束：ES2017 以内的经典脚本，模块用 CommonJS 的 require，不用 import / export。
 * project.config.json 关闭了 ES6 转 ES5、增强编译与压缩，开发者工具不会替我们降级语法。
 * 这里是模拟核心之外的宿主代码：Date.now()、Math.sqrt 只用于计时与对照路径，不进入模拟状态。
 */
/* global wx, GameGlobal, require, console, setTimeout */
'use strict';

/** 画完"运行中…"后等多久再开始跑（毫秒）：让这一帧先上屏。 */
var RUN_DELAY_MS = 120;
/** dsqrt 路径结果上屏后，等多久再跑 Math.sqrt 参考路径。 */
var NEXT_DELAY_MS = 60;

/** 深色背景、浅色字。 */
var COLORS = {
  bg: '#0f1419',
  fg: '#e6edf3',
  dim: '#8b98a5',
  ok: '#7ee787',
  busy: '#f2cc60',
  err: '#ff7b72',
};

var G = typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis;

/** 屏幕：{ canvas, ctx, w, h, dpr, left, top, maxWidth, base }；初始化失败时为 null，只写 console。 */
var screen = null;

/** 屏幕上显示的内容；每次变化后整屏重画。 */
var state = {
  det: null,
  ref: null, // [Math.sqrt 哈希与 steps, 每 tick 微秒, 语料版本, apiVersion]
  timing: null,
  busy: null,
  errors: [],
  device: null,
};

function positive(x) {
  return typeof x === 'number' && x > 0 ? x : 0;
}

function clamp(x, lo, hi) {
  return x < lo ? lo : x > hi ? hi : x;
}

/** 窗口信息：优先新接口 wx.getWindowInfo，旧基础库退回 wx.getSystemInfoSync（后者已不推荐，会在控制台告警）。 */
function readWindowInfo() {
  try {
    if (typeof wx.getWindowInfo === 'function') return wx.getWindowInfo() || {};
    if (typeof wx.getSystemInfoSync === 'function') return wx.getSystemInfoSync() || {};
  } catch (e) {
    console.warn('[wx-selftest] 读取窗口信息失败，按画布尺寸布局：' + describeError(e));
  }
  return {};
}

/** 取主屏画布（第一次 wx.createCanvas() 返回的是上屏画布），按设备像素比放大，算出版面。 */
function setupScreen() {
  var info = readWindowInfo();
  var canvas = wx.createCanvas();
  var w = positive(info.windowWidth) || positive(info.screenWidth) || canvas.width;
  var h = positive(info.windowHeight) || positive(info.screenHeight) || canvas.height;
  var dpr = clamp(positive(info.pixelRatio) || 1, 1, 4);
  try {
    canvas.width = Math.round(w * dpr);
    canvas.height = Math.round(h * dpr);
  } catch (e) {
    dpr = 1;
    console.warn('[wx-selftest] 改不了画布尺寸，按 1 倍像素比绘制：' + describeError(e));
  }
  var ctx = canvas.getContext('2d');
  var sa = info.safeArea || null;
  var margin = Math.max(12, Math.round(w * 0.04));
  var left = margin + (sa && positive(sa.left) ? sa.left : 0);
  var right = margin + (sa && positive(sa.right) && sa.right < w ? w - sa.right : 0);
  var top = margin + (sa && positive(sa.top) ? sa.top : 0);
  return {
    canvas: canvas,
    ctx: ctx,
    w: w,
    h: h,
    dpr: dpr,
    left: left,
    top: top,
    maxWidth: Math.max(40, w - left - right),
    // 基准字号：随屏宽缩放，小屏不小于 12px
    base: clamp(Math.round(w / 24), 12, 18),
  };
}

function fontOf(block, size) {
  return (block.bold ? 'bold ' : '') + size + 'px ' + (block.mono ? 'monospace' : 'sans-serif');
}

/** fit 块（DET 行）：缩小字号直到一行放得下，最小 10px；仍放不下就交给换行。 */
function fitSize(ctx, block, maxWidth) {
  var size = block.size;
  var min = Math.max(10, Math.round(block.size * 0.5));
  while (size > min) {
    ctx.font = fontOf(block, size);
    if (ctx.measureText(block.text).width <= maxWidth) break;
    size -= 1;
  }
  return size;
}

/**
 * 按宽度换行：连续的可见 ASCII 字符（哈希、数字、英文词）算一个词，不在中间断开；
 * 汉字与其他字符一个字一个词；空白可作断点，行首不留空白。单个词比整行还宽时逐字硬断。
 */
function wrapText(ctx, text, maxWidth) {
  var out = [];
  var paras = String(text).split('\n');
  for (var p = 0; p < paras.length; p++) {
    var tokens = paras[p].match(/[\x21-\x7e]+|\s+|[^\s]/g) || [];
    var line = '';
    for (var i = 0; i < tokens.length; i++) {
      var tok = tokens[i];
      var space = /^\s+$/.test(tok);
      if (space && line === '') continue;
      if (ctx.measureText(line + tok).width <= maxWidth) {
        line += tok;
        continue;
      }
      if (line !== '') {
        out.push(line.replace(/\s+$/, ''));
        line = '';
        if (space) continue;
      }
      line = tok;
      while (line.length > 1 && ctx.measureText(line).width > maxWidth) {
        var k = 1;
        while (k + 1 < line.length && ctx.measureText(line.slice(0, k + 1)).width <= maxWidth) k++;
        out.push(line.slice(0, k));
        line = line.slice(k);
      }
    }
    line = line.replace(/\s+$/, '');
    if (line !== '' || tokens.length === 0) out.push(line);
  }
  return out;
}

function buildBlocks() {
  var b = screen.base;
  var small = Math.max(11, b - 3);
  var blocks = [{ text: 'BadmintonSim 真机内核自测', color: COLORS.fg, size: Math.round(b * 1.25), bold: true }];
  if (state.det) {
    blocks.push({ text: state.det, color: COLORS.ok, size: Math.round(b * 1.5), mono: true, bold: true, fit: true });
    blocks.push({
      text: '前两项（哈希、steps）应与 bun run det --kernel 末尾的 DET 行相同；第三项是本机 steps/s。',
      color: COLORS.dim,
      size: small,
    });
  }
  if (state.ref) {
    blocks.push({ text: state.ref[0], color: COLORS.fg, size: b, mono: true, fit: true });
    blocks.push({ text: state.ref.slice(1).join('；'), color: COLORS.fg, size: b });
  }
  if (state.timing) blocks.push({ text: state.timing, color: COLORS.dim, size: small });
  if (state.busy) blocks.push({ text: state.busy, color: COLORS.busy, size: b });
  for (var i = 0; i < state.errors.length; i++) {
    blocks.push({ text: state.errors[i].title, color: COLORS.err, size: b, bold: true });
    if (state.errors[i].detail) blocks.push({ text: state.errors[i].detail, color: COLORS.err, size: small, mono: true });
  }
  if (state.device) blocks.push({ text: state.device, color: COLORS.dim, size: small });
  return blocks;
}

/** 整屏重画（超出屏幕底部的内容不滚动，直接截掉；DET 行总在前面）。 */
function paint() {
  if (!screen) return;
  var s = screen;
  var ctx = s.ctx;
  ctx.setTransform(s.dpr, 0, 0, s.dpr, 0, 0);
  ctx.fillStyle = COLORS.bg;
  ctx.fillRect(0, 0, s.w, s.h);
  ctx.textBaseline = 'top';
  ctx.textAlign = 'left';
  var y = s.top;
  var blocks = buildBlocks();
  for (var i = 0; i < blocks.length; i++) {
    var block = blocks[i];
    var size = block.fit ? fitSize(ctx, block, s.maxWidth) : block.size;
    ctx.font = fontOf(block, size);
    ctx.fillStyle = block.color;
    var lines = wrapText(ctx, block.text, s.maxWidth);
    var lineHeight = Math.round(size * 1.45);
    for (var j = 0; j < lines.length; j++) {
      ctx.fillText(lines[j], s.left, y);
      y += lineHeight;
    }
    y += Math.round(s.base * 0.6);
  }
}

/** 画屏本身出错时不能再抛出（否则错误处理会递归）；只写 console。 */
function safePaint() {
  try {
    paint();
  } catch (e) {
    console.error('[wx-selftest] 绘制失败：' + describeError(e));
  }
}

function describeError(e) {
  if (e && typeof e === 'object') {
    var msg = e.message !== undefined ? String(e.message) : String(e);
    return e.stack ? msg + '\n' + String(e.stack) : msg;
  }
  return String(e);
}

function showError(stage, e) {
  var text = describeError(e);
  console.error('[wx-selftest] ' + stage + '出错：' + text);
  var nl = text.indexOf('\n');
  state.busy = null;
  state.errors.push({
    title: stage + '出错：' + (nl < 0 ? text : text.slice(0, nl)),
    detail: nl < 0 ? '' : text.slice(nl + 1),
  });
  safePaint();
}

/** 设备与运行环境摘要（只用于记录，取不到的项写"未知"）。 */
function deviceSummary() {
  var d = {};
  var k;
  try {
    var parts = [];
    if (typeof wx.getDeviceInfo === 'function') parts.push(wx.getDeviceInfo());
    if (typeof wx.getAppBaseInfo === 'function') parts.push(wx.getAppBaseInfo());
    if (parts.length === 0 && typeof wx.getSystemInfoSync === 'function') parts.push(wx.getSystemInfoSync());
    for (var i = 0; i < parts.length; i++) for (k in parts[i]) if (parts[i][k] !== undefined) d[k] = parts[i][k];
  } catch (e) {
    console.warn('[wx-selftest] 读取设备信息失败：' + describeError(e));
  }
  var items = [
    '设备 ' + (d.model || '未知'),
    '系统 ' + (d.system || '未知'),
    '平台 ' + (d.platform || '未知'),
    '微信 ' + (d.version || '未知'),
    '基础库 ' + (d.SDKVersion || '未知'),
  ];
  if (d.benchmarkLevel !== undefined) items.push('benchmarkLevel ' + d.benchmarkLevel);
  // 未经核实的字段：有就顺手记下，没有就不显示；iOS 标准 / 高性能模式以人工记录为准（见 README）
  if (G.isIOSHighPerformanceMode !== undefined) items.push('isIOSHighPerformanceMode ' + String(G.isIOSHighPerformanceMode));
  return items.join('；');
}

/** 加载 sim.js 并取全局 BadmintonSim；形状不对就抛错。 */
function loadSim() {
  require('./sim.js');
  var sim = G.BadmintonSim;
  if (!sim || !sim.kernel || typeof sim.kernel.run !== 'function' || !sim.hash || typeof sim.hash.hex8 !== 'function') {
    throw new Error(
      'sim.js 已加载，但 ' +
        (typeof GameGlobal !== 'undefined' ? 'GameGlobal' : 'globalThis') +
        '.BadmintonSim 不存在或缺少 kernel.run / hash.hex8',
    );
  }
  return sim;
}

/** 第一段：dsqrt 路径，输出 DET 行。 */
function runDsqrt(sim) {
  state.busy = null;
  try {
    var t0 = Date.now();
    var r = sim.kernel.run({ checkpoints: false });
    var ms = Date.now() - t0;
    var sps = Math.round((r.steps * 1000) / Math.max(ms, 1));
    state.det = 'DET ' + sim.hash.hex8(r.hash) + ' ' + r.steps + ' ' + sps;
    console.log(state.det);
    state.busy = '参考路径（Math.sqrt）运行中…';
    safePaint();
    setTimeout(function () {
      runMathSqrt(sim, r, ms);
    }, NEXT_DELAY_MS);
  } catch (e) {
    showError('内核语料（dsqrt 路径）', e);
  }
}

/** 第二段：Math.sqrt 参考路径，输出参考行与耗时。 */
function runMathSqrt(sim, r, ms) {
  state.busy = null;
  try {
    var t0 = Date.now();
    var q = sim.kernel.run({ checkpoints: false, sqrt: Math.sqrt });
    var msSqrt = Date.now() - t0;
    var usPerTick = r.steps > 0 ? ((ms * 1000) / r.steps).toFixed(2) : '—';
    // 屏幕上分行显示，console 里用"；"连成一行
    state.ref = [
      '参考 Math.sqrt ' + sim.hash.hex8(q.hash) + ' ' + q.steps,
      'dsqrt 每 tick ' + usPerTick + ' µs',
      '语料版本 ' + r.corpusVersion,
      'apiVersion ' + sim.apiVersion,
    ];
    state.timing =
      '耗时：dsqrt 路径 ' +
      ms +
      ' ms（' +
      r.shots +
      ' 拍、' +
      r.steps +
      ' tick、' +
      r.substeps +
      ' 子步，首轮运行、含 JIT 预热（如有）），Math.sqrt 路径 ' +
      msSqrt +
      ' ms；计时 Date.now()';
    console.log(state.ref.join('；'));
    console.log('[wx-selftest] ' + state.timing);
    console.log('[wx-selftest] ' + state.device);
    safePaint();
  } catch (e) {
    showError('参考路径（Math.sqrt）', e);
  }
}

function main() {
  try {
    screen = setupScreen();
  } catch (e) {
    screen = null;
    console.error('[wx-selftest] 画布初始化失败（只能看 console）：' + describeError(e));
  }
  if (typeof wx.onError === 'function') {
    wx.onError(function (res) {
      showError('未捕获的异常', res && res.message !== undefined ? res : String(res));
    });
  }
  state.device = deviceSummary();

  var sim;
  try {
    sim = loadSim();
  } catch (e) {
    showError('加载 sim.js（先在仓库根运行 bun run sim:build 与 bun run wx-selftest:sync）', e);
    return;
  }

  state.busy =
    '运行中…（内核语料 ' +
    sim.kernel.DEFAULT_SHOTS +
    ' 拍：先 dsqrt 路径，再 Math.sqrt 参考路径；语料版本 ' +
    sim.kernel.CORPUS_VERSION +
    '）';
  safePaint();
  console.log('[wx-selftest] ' + state.busy);
  setTimeout(function () {
    runDsqrt(sim);
  }, RUN_DELAY_MS);
}

main();

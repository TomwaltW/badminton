/**
 * 确定性门禁的引擎侧驱动：与引擎无关的 ES2017 经典脚本，在 sim.js 之后、同一个全局作用域里执行。
 *   node / bun：boot.cjs 用 vm.runInThisContext 依次执行 sim.js 与本文件，参数在全局 __detArgs；
 *   jsc：      jsc [flags] sim.js driver.js -- <参数>，参数在全局 arguments，输出用 print。
 * 只依赖语言内置对象与全局 BadmintonSim；process、console、performance 都按"可能不存在"处理
 * （jsc 命令行里没有 process 与 console）。
 *
 * 参数：--shots N（拍数，默认用 sim 的 DEFAULT_SHOTS）、--seed N（种子，默认用 sim 的 DEFAULT_SEED）。
 *
 * 做的事：
 * 1. 跑内核语料两遍：dsqrt 路径（sim 默认）与 Math.sqrt 路径（sqrt: Math.sqrt 由这里从外部注入，
 *    sim.js 里不出现 Math.sqrt），都带检查点；分别计时（1 step = 1 tick = 2 个子步）。
 * 2. 收集引擎信息：process.arch、process.version、process.versions.bun（jsc 下全无）。
 * 3. JIT 探针：全局 numberOfDFGCompiles（jsc 命令行）或 __detJitProbe（bun，由 boot.cjs 放入），
 *    作用于 BadmintonSim.flight.stepRk4：返回 1000000 = JIT 关闭，其他 = 开启；没有探针 = 未知（null）。
 * 4. 输出一行：@@DET@@ <JSON>。det.ts 只认这一行。
 */
(function () {
  'use strict';

  var G = typeof globalThis !== 'undefined' ? globalThis : Function('return this')();
  var MARK = '@@DET@@ ';
  /** JSC 在 JIT 关闭时 numberOfDFGCompiles 返回的哨兵值。 */
  var JIT_OFF_SENTINEL = 1000000;

  function emit(line) {
    if (typeof G.__detArgs !== 'undefined' && G.console && typeof G.console.log === 'function') {
      G.console.log(line);
    } else if (typeof G.print === 'function') {
      G.print(line);
    } else if (G.console && typeof G.console.log === 'function') {
      G.console.log(line);
    } else {
      throw new Error('driver.js：没有可用的输出函数（print / console.log）');
    }
  }

  function readArgs() {
    var src = typeof G.__detArgs !== 'undefined' ? G.__detArgs : G.arguments;
    var out = [];
    if (src) for (var i = 0; i < src.length; i++) out.push(String(src[i]));
    return out;
  }

  function parseIntArg(name, text) {
    if (!/^(0x[0-9a-fA-F]+|\d+)$/.test(text || '')) throw new Error('driver.js：' + name + ' 需要非负整数，收到 ' + text);
    return Number(text);
  }

  var args = readArgs();
  var shots = null;
  var seed = null;
  for (var i = 0; i < args.length; i++) {
    if (args[i] === '--shots') shots = parseIntArg('--shots', args[++i]);
    else if (args[i] === '--seed') seed = parseIntArg('--seed', args[++i]);
    else throw new Error('driver.js：未知参数 ' + args[i]);
  }

  var B = G.BadmintonSim;
  if (!B || !B.kernel || typeof B.kernel.run !== 'function') {
    throw new Error('driver.js：全局没有 BadmintonSim.kernel.run（sim.js 没有把 API 挂到全局？）');
  }
  if (shots === null) shots = B.kernel.DEFAULT_SHOTS;

  var now;
  var timer;
  if (G.performance && typeof G.performance.now === 'function') {
    now = function () {
      return G.performance.now();
    };
    timer = 'performance.now';
  } else if (typeof G.preciseTime === 'function') {
    now = function () {
      return G.preciseTime() * 1000;
    };
    timer = 'preciseTime';
  } else {
    now = function () {
      return Date.now();
    };
    timer = 'Date.now';
  }

  function runPath(sqrt) {
    var opts = { shots: shots, checkpoints: true };
    if (seed !== null) opts.seed = seed;
    if (sqrt) opts.sqrt = sqrt;
    var t0 = now();
    var r = B.kernel.run(opts);
    var t1 = now();
    return {
      hash: r.hash >>> 0,
      steps: r.steps,
      substeps: r.substeps,
      shots: r.shots,
      corpusVersion: r.corpusVersion,
      ms: t1 - t0,
      checkpoints: r.checkpoints,
    };
  }

  var dsqrtPath = runPath(null);
  var mathSqrtPath = runPath(Math.sqrt);

  var probe = null;
  if (typeof G.numberOfDFGCompiles === 'function') probe = G.numberOfDFGCompiles;
  else if (typeof G.__detJitProbe === 'function') probe = G.__detJitProbe;
  var dfgCompiles = null;
  var jit = null;
  if (probe && B.flight && typeof B.flight.stepRk4 === 'function') {
    dfgCompiles = probe(B.flight.stepRk4);
    jit = dfgCompiles !== JIT_OFF_SENTINEL;
  }

  var P = G.process;
  var engine = {
    hasProcess: !!P,
    arch: P && P.arch ? String(P.arch) : null,
    nodeVersion: P && P.version ? String(P.version) : null,
    bunVersion: P && P.versions && P.versions.bun ? String(P.versions.bun) : null,
  };

  emit(
    MARK +
      JSON.stringify({
        v: 1,
        apiVersion: B.apiVersion,
        corpusVersion: dsqrtPath.corpusVersion,
        shots: shots,
        seed: seed,
        engine: engine,
        jit: jit,
        dfgCompiles: dfgCompiles,
        timer: timer,
        cp: { stride: B.kernel.CP_STRIDE, tick: B.kernel.CP_TICK, shotEnd: B.kernel.CP_SHOT_END },
        paths: { dsqrt: dsqrtPath, mathSqrt: mathSqrtPath },
      }),
  );
})();

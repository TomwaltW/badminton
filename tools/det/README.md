# tools/det：确定性门禁

`bun run det --kernel [--profile linux|mac]`：用**构建产物** `packages/sim/dist/sim.js`（不是源码）在一档引擎上跑内核语料，
**跨引擎互比、不存期望值**（计划 6 章"确定性门禁"、派单 A 第 3–4 项）。

内核语料（`packages/sim/src/kernel.ts`）= 飞行 + 随机数 + 哈希：2,000 拍随机击球，每 tick 2 个 1/60 s RK4 子步，
每 30 tick 把完整状态混入滚动哈希并记一条检查点，每拍结束再记一条。门禁跑两条路径：

| 路径 | 平方根 | 说明 |
|---|---|---|
| dsqrt | 模拟核心自己的 `dsqrt` | 正式路径；`DET` 行报告它 |
| Math.sqrt | 由 driver 从外部注入 `Math.sqrt` | 对照路径；`sim.js` 里不出现 `Math.sqrt`（`sim:scan` 会拒绝） |

两条路径的哈希本来就不同（`dsqrt` 与 `Math.sqrt` 约 25% 输入差 1 ulp）；门禁要求的是**每条路径在各引擎上各自逐位一致**。

## 用法

```sh
bun run sim:build                         # det 跑的是 dist/sim.js，先构建
bun run det --kernel                      # 档按平台默认：darwin → mac，linux → linux
bun run det --kernel --profile linux
bun run det --kernel --profile linux --fixture sin   # 自测：必须判红
```

| 参数 | 说明 |
|---|---|
| `--kernel` | 跑内核语料（必需；目前只有这一种模式） |
| `--profile <档>` | `engines.json` 里的档名；默认 darwin → `mac`、linux → `linux` |
| `--sim <路径>` | 要跑的 sim.js；默认 `packages/sim/dist/sim.js` |
| `--engines <文件>` | 引擎清单；默认 `tools/det/engines.json` |
| `--shots <N>` | 拍数；默认用 sim 的 `kernel.DEFAULT_SHOTS`（2000） |
| `--fixture sin` | 构建"用了 `Math.sin` 的模拟"夹具到临时目录并对它跑门禁（见下文） |
| `--json` | stdout 只输出一个 JSON 对象（进度与表格改写 stderr） |
| `--matches [N]`、`--rollback` | 尚未实现（计划 10-27 / 11-10：`--rollback` 10-27，`--matches` 1,000 局 11-10），退出码 2 |
| `-h`、`--help` | 打印用法 |

带值的参数可写 `--flag value` 或 `--flag=value`；开关参数（`--kernel`、`--json`、`--rollback`、`--help`）不带值，
写成 `--json=false` 之类会按用法错误退出 2，免得被悄悄当成"打开"。

用默认 sim 路径时，det 先做三项检查，不过就以退出码 2 结束：
- `dist/sim.js` 不存在 → 提示先 `bun run sim:build`；
- `packages/sim/src` 下有任何 `.ts` 比 `dist/sim.js` 新 → 提示重新构建（并列出较新的文件）；
- `dist/sim.version` 存在但与 sim.js 的字节哈希不符（sim.js 被手改过）→ 提示重新构建。

`--sim` 显式指定路径时不做这些检查。

**退出码**：`0` 全部引擎通过且两条路径各自一致；`1` 有引擎失败或跨引擎不一致；`2` 用法 / 配置 / 前置条件错误。

## 两档引擎（`engines.json`）

| 档 | 引擎 | 命令 | 期望 |
|---|---|---|---|
| linux | `node` | `/opt/node22/bin/node` | x64，`v22.` |
| linux | `bun` | `/root/.bun/bin/bun` | x64，`1.4.`，JIT 开启 |
| linux | `bun-nojit` | 同上 + `BUN_JSC_useJIT=0` | x64，`1.4.`，JIT 关闭（JSC 解释器；Mac 上已验证与 `jsc --useJIT=false` 同哈希） |
| mac | `node-arm64` | `/usr/local/bin/node` | arm64，`v24.` |
| mac | `node-x64` | `/usr/bin/arch -x86_64 /usr/local/bin/node` | x64（Rosetta 下的 V8，代表服务端），`v24.` |
| mac | `bun` | `~/.bun/bin/bun` | arm64，`1.4.`，JIT 开启 |
| mac | `jsc-nojit` | `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc --useJIT=false` | JIT 关闭；版本期望留空（首跑后由人填，见下文） |

引擎条目的字段：

| 字段 | 说明 |
|---|---|
| `name` | 唯一名（字母、数字、`. _ -`） |
| `kind` | `node` \| `bun` \| `jsc`：决定加载方式与"版本"取哪个值 |
| `cmd` | 命令数组，见下面的路径规则 |
| `env` | 可选，附加环境变量 |
| `expect.arch` | 可选，`process.arch`（`x64`、`arm64`）；jsc 没有 `process`，不能设 |
| `expect.version` | 可选，版本**前缀**：node 比 `process.version`，bun 比 `process.versions.bun`，jsc 比 Info.plist 的 `CFBundleVersion`；空串 = 只打印不判定 |
| `expect.jit` | 可选，`true` 必须开启 / `false` 必须关闭 |

**路径规则**：`cmd[0]` 必须是绝对路径；其后不以 `-` 开头的元素也一律按路径检查（例如 `arch -x86_64` 后面的 node），
同样必须是绝对路径、存在、可执行。唯一的例外是开头的 `~/`：det 把它展开为 `os.homedir()`，展开后仍须是绝对路径
（`~`、`~user/` 不展开）。其余相对路径一律判失败。带值的引擎参数请写成一个元素 `--flag=value`。

**环境**：子进程继承当前环境，但去掉 `BUN_JSC_*`、`JSC_*`、`NODE_OPTIONS`、`BUN_OPTIONS`、`NODE_V8_COVERAGE`
（它们会改变引擎行为），再叠上条目里的 `env`。所以在 `BUN_JSC_useJIT=0 bun run det` 下，`bun` 一项仍是 JIT。

**判失败**（任何一个引擎）：可执行文件不存在 / 不是绝对路径 / 不可执行、退出码非 0、超时（300 秒）、
输出里没有 `@@DET@@` 行、arch 不符、版本前缀不符、JIT 状态不符（或期望了 JIT 却没有探针）、`kind` 与实际引擎不符。
期望不符但能跑出结果的引擎仍参与互比，只是已记为失败。

## 加载方式：每个引擎都一样

每个引擎都把 `sim.js` 与 `driver.js` **当经典脚本、在同一个全局作用域里依次执行**（与微信、Cocos 插件脚本的加载方式一致，
不走模块加载）：

- **jsc**：`jsc [flags] <sim.js> <driver.js> -- <参数>`；driver 从全局 `arguments` 取参数，用 `print` 输出。
- **node / bun**：`<cmd> boot.cjs <sim.js> <driver.js> <参数>`；`boot.cjs` 读两个文件，用
  `vm.runInThisContext(源码, { filename })` 依次执行（已实测 bun 1.4 支持），参数放在 `globalThis.__detArgs`；
  bun 下把 `require('bun:jsc').numberOfDFGCompiles` 放在 `globalThis.__detJitProbe`。

`driver.js` 是与引擎无关的 ES2017 脚本（测试用 esbuild 校验没有更新的语法），只依赖语言内置对象与全局 `BadmintonSim`，
`process`、`console`、`performance` 都按"可能不存在"处理：

1. 跑 `BadmintonSim.kernel.run({ shots, checkpoints: true })`（dsqrt 路径）与 `run({ shots, checkpoints: true, sqrt: Math.sqrt })`；
   分别计时（`performance.now` → `preciseTime` → `Date.now`，取第一个可用的）；1 step = 1 tick = 2 个子步。
2. 引擎信息：`process.arch`、`process.version`、`process.versions.bun`（jsc 下没有 `process`）。
3. JIT 探针：全局 `numberOfDFGCompiles`（jsc 命令行）或 `__detJitProbe`（bun），作用于 `BadmintonSim.flight.stepRk4`：
   返回 `1000000`（JSC 在 JIT 关闭时的哨兵值）= 关闭，其他 = 开启；没有探针（node）= 未知。
4. 输出一行 `@@DET@@ <JSON>`（node / bun 用 `console.log`，jsc 用 `print`）。

jsc 的版本由 det 读取：jsc 二进制所在目录的 `../Resources/Info.plist`，
`/usr/bin/plutil -extract CFBundleVersion raw -o - <plist>`；读不到打印"未知"。

## 输出示例与读法

linux 档（2026-10-07，本容器实测）：

```
[det] 确定性门禁 --kernel：档 linux（tools/det/engines.json），拍数 默认
[det] sim：packages/sim/dist/sim.js  simVer=7d4357a0  12,852 字节
[det] 依次运行 3 个引擎（不并行，免得 steps/s 失真；每个超时 300 秒）
[det]   node：完成（0.2 秒）
[det]   bun：完成（0.1 秒）
[det]   bun-nojit：完成（0.8 秒）

语料版本 1，API 版本 0，拍数 2000；1 step = 1 tick = 2 个 1/60 s 子步；steps/s 取 dsqrt 路径
引擎       arch  版本      JIT   dsqrt 哈希  Math.sqrt 哈希  steps    steps/s  结果
node       x64   v22.22.0  未知  efc2c7f7    99ef999f        98311  1,236,382  通过
bun        x64   1.4.2     开启  efc2c7f7    99ef999f        98311  1,520,658  通过
bun-nojit  x64   1.4.2     关闭  efc2c7f7    99ef999f        98311    208,372  通过

dsqrt 路径：一致——3 个引擎的哈希 efc2c7f7、steps 98311 与全部 5277 条检查点相同（基准 node）
Math.sqrt 路径：一致——3 个引擎的哈希 99ef999f、steps 98311 与全部 5277 条检查点相同（基准 node）

结论：通过——linux 档 3 个引擎（node、bun、bun-nojit）在 dsqrt 路径与 Math.sqrt 路径上各自逐位一致
DET efc2c7f7 98311
```

（哈希随源码变化，上面的值只是示例；门禁从不和固定值比较。）

- **simVer**：所跑 sim.js 文件字节的 FNV-1a，与 `dist/sim.version` 相同。
- **表格**：每个引擎一行。`arch` 是 `process.arch`（jsc 没有，这一栏打印版本）；`版本` 按 kind 取；
  `JIT` 是探针结果；`steps/s` 是 dsqrt 路径的模拟速度（含 JIT 预热，只作量级参考）；`结果` 是该引擎自身的检查（路径、退出码、期望）。
- **路径行**：以第一个成功的引擎为基准，比较哈希、steps 与**整个检查点序列**（每条 = 种类、拍号、全局 tick、哈希）。
- **`DET <dsqrt 哈希> <steps>`**：基准引擎的 dsqrt 路径结果。`tools/wx-selftest` 在真机上打印的 `DET <hash> <n> <steps/s>`
  前两项应与它相同（同一份 sim.js、默认拍数与种子）。

不一致时，每个与基准不同的引擎打印首个分歧（`--fixture sin` 的实测输出节选）：

```
dsqrt 路径：不一致（基准 node：f30315c0，94646 steps，5154 条检查点）
  bun 与 node 不一致：
    首个分歧：第 12 条检查点，语料号（拍号）4，全局 tick 240，检查点种类：30 tick 完整状态
      node：42c71ac1
      bun：30a7c45e
      真正的分歧发生在上一条相同的检查点（语料号（拍号）3，全局 tick 231，一拍结束）之后、这一条之前
      最终：node f30315c0 / 94646 steps；bun 47ee85ce / 94646 steps
```

读法：检查点只在每 30 tick 与每拍结束时记，所以"首个分歧"给的是**第一条不同的检查点**，真正的分歧发生在它与
上一条相同的检查点之间。上例里第 3 拍结束时双方还相同，第 4 拍发射后状态不同，第一次被 tick 240 的完整状态检查点抓到。
种类"30 tick 完整状态"= 每 30 个全局 tick 混入一次 i32 + f64 全部槽；"一拍结束"= 混入落点、事件结果之后。
如果双方连检查点的位置都不同了（例如一方早一个 tick 落地），会分别列出双方那一条的拍号、tick 与种类。

`--json` 的字段：`ok`、`exitCode`、`profile`、`sim{path,simVer,bytes,fixture}`、`shots`、`corpusVersion`、
`engines[]{name,kind,cmd,env,ok,errors,arch,version,jit,dfgCompiles,timer,wallMs,paths{dsqrt,mathSqrt}{hash,steps,substeps,ms,stepsPerSec,checkpoints}}`、
`paths{dsqrt,mathSqrt}{consistent,baseline,hash,steps,checkpoints,divergences[]}`、`det`。哈希一律是 8 位十六进制字符串。

## 在 Mac 上跑（mac 档）

```sh
bun run sim:build
bun run det --kernel --profile mac      # 在 Mac 上 --profile 可省略
```

1. 首跑时 `jsc-nojit` 的期望版本是空串，只打印不判定。把表格里 jsc 一行打印出的版本（来自
   `/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Resources/Info.plist` 的 `CFBundleVersion`）
   的前缀填进 `engines.json` 的 `profiles.mac[jsc-nojit].expect.version`，例如 `"20621."`，以后 macOS 升级换了 JSC 就会判失败、提醒你重新确认。
   如果打印"未知"（读不到 Info.plist），就保持空串。
2. node 的版本前缀是 `"v24."`、bun 是 `"1.4."`；升级大版本时同步改期望值。
3. `node-x64` 需要 Rosetta 2，且 `/usr/local/bin/node` 必须含 x86_64 架构（可用 `lipo -archs /usr/local/bin/node` 确认；
   Node 官方 .pkg 一般是通用二进制）；否则 `arch` 会报 "Bad CPU type"，该引擎判失败。
4. Apple Silicon 上 Homebrew 装的 node 在 `/opt/homebrew/bin/node`，通常只含 arm64，不能直接拿来当 `node-x64`；要改路径就同时改两条并确认架构。
5. 用原生 arm64 的 bun 跑 det。若 det 本身跑在 Rosetta 下（x64 的 bun，或从 Rosetta 终端启动），macOS 会让子进程
   也优先选 x86_64 切片，`node-arm64` 与 `bun` 就会报"arch 不符"——这正是 arch 期望要抓的情况，换成原生 bun 重跑即可。
6. Mac 档有 4 个引擎，`dsqrt` 与 `Math.sqrt` 两条路径都必须 4 个一致才退出 0。

## 自测夹具（`--fixture sin`）

`fixtures/sin-entry.ts`：API 与真实 sim 完全相同，只把 `kernel.run` 换成另一个发射参数生成器（经由 `runKernelWith`）——
由仰角、侧向角（弧度）用 `Math.sin` / `Math.cos` 算方向向量；飞行、`sqrt` 选项、检查点与哈希规则都照旧。入口末尾同样把 API
显式挂到 `GameGlobal` / `globalThis`。det 用 `buildSim({ entry, outDir: 临时目录, dts: false })` 构建它，跑完删除。

实测（linux 档）：小角度上 `Math.sin` / `Math.cos` 在 V8（node 22）与 JSC（bun 1.4）之间约 1%–3% 的输入差 1 ulp，
每拍 4 次调用；第 4 拍就分歧，dsqrt 与 Math.sqrt 两条路径都判红，退出码 1。`bun` 与 `bun-nojit` 同为 JSC、用同一个 libm，彼此一致。
这证明门禁确实能抓住"模拟里混进了超越函数"。

## 测试

```sh
bun test tools/det/test
```

- `compare.test.ts`：首个分歧逻辑（构造检查点数组）与基准选择；
- `config.test.ts`：清单结构校验、随仓库的两档清单、相对路径 / `~/` 展开 / 缺失 / 不可执行、arch / 版本 / JIT / kind 不符、
  用 `/bin/sh` 假引擎测退出码、无 `@@DET@@`、超时、环境变量，`@@DET@@` 行形状校验（检查点不是整条记录、引擎字段缺失），
  假 `plutil` 测 jsc 版本读取；
- `driver.test.ts`：driver 只用 ES2017 语法；在只有 `print` 与 `arguments` 的 vm 上下文里跑通并与源码同哈希；JIT 探针语义；`boot.cjs`；
- `cli.test.ts`：参数解析（开关参数不接受 `=值`）、尚未实现的模式、前置条件错误；默认 sim 路径的三项前置检查
  （不存在 / 比源码旧 / `sim.version` 不符 → 2，检查通过后照常跑引擎）用注入的临时目录验证，不碰真实 `dist`；
- `det.integration.test.ts`（只在 linux 上跑，linux 档引擎不全时跳过）：真实 sim 三引擎通过、`--fixture sin` 判红（退出码 1）、
  引擎缺失 / 相对路径 / arch 不符时即使哈希一致也退出 1、`--json`，
  以及有 `/usr/bin/jsc` 时把 `jsc --useJIT=false`（kind jsc）与 node 放在一起跑，验证 jsc 的加载与输出路径。
  `/usr/bin/jsc` 是 WebKitGTK 的 JSC 命令行，只用来测 jsc 代码路径，不属于任何 det 档。

测试不依赖预先构建的 `packages/sim/dist`（用 `buildSim` 构建到临时目录）。

## 文件

| 文件 | 作用 |
|---|---|
| `det.ts` | 命令行入口：参数、前置检查、依次跑引擎、互比、打印 / JSON、退出码 |
| `config.ts` | `engines.json` 读取与校验、`~/` 展开、路径检查、期望检查 |
| `runner.ts` | 拼命令、起子进程（超时 300 秒）、解析 `@@DET@@`、读 jsc 版本 |
| `compare.ts` | 检查点互比与首个分歧（纯函数） |
| `boot.cjs` | node / bun 的加载器（`vm.runInThisContext`） |
| `driver.js` | 引擎侧驱动（ES2017 经典脚本） |
| `engines.json` | 两档引擎清单 |
| `fixtures/sin-entry.ts` | 自测夹具：用了 `Math.sin` 的模拟 |

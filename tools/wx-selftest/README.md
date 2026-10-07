# tools/wx-selftest：真机内核自测（空白微信小游戏工程）

## 用途

G0 的真机确定性**不依赖 Cocos**（计划 0 #2、6 章"真机内核自测"、7 章 G0）：把门禁验过的同一份
`packages/sim/dist/sim.js` 放进一个什么都没有的微信小游戏工程，在真机上跑内核语料（飞行 + 随机数 + 哈希，
2,000 拍），打印哈希。真机哈希 = Node 哈希，才说明"受限双精度"路线在真机上成立；否则走计划 8 章的预案。

顺带给出真机每 tick 的耗时，用于换算 `bench:sim` 的预算（计划 6 章）。测试号就能预览，手机到货当天就能测。

| 文件 | 说明 | 提交 |
|---|---|---|
| `game.js` | 入口：加载 `sim.js`、跑内核语料、在屏幕与 console 打印结果 | 是 |
| `game.json` | 竖屏、不显示状态栏 | 是 |
| `project.config.json` | 微信开发者工具的项目配置（测试号占位 `touristappid`，关闭改写代码的编译选项） | 是 |
| `README.md` | 本文件（打包时忽略） | 是 |
| `sim.js` | 由 `bun run wx-selftest:sync` 从 `packages/sim/dist/sim.js` 原样复制 | 否（已在 `.gitignore`） |

## 云端无法运行

云容器里没有 Mac、微信开发者工具和真机。云端只做这一步验证：

```sh
bun test tools/sim/test/wx-selftest.test.ts
```

测试把 `sim.js` 构建到临时目录、用同步函数复制进临时工程，再在 `node:vm` 的新上下文里模拟微信运行时
（`GameGlobal` 指向全局对象、记录型假画布、按微信方式包一层函数执行的 `require('./sim.js')`、同步冲刷的
`setTimeout`、捕获的 `console`）运行 `game.js`，断言屏幕与 console 的 `DET` 行等于主进程加载同一份 `sim.js`
跑出的结果；另测小屏换行、没有 `sim.js`、内核抛错等情形。真机上的结果只能在 Mac 上由人跑。

## 输出怎么读

屏幕（深色背景）与 console 输出相同的内容，例如（2026-10-07 云端 bun 在 vm 模拟运行时里的示例值，设备行是测试里的假设备信息；哈希随源码变化）：

```
DET efc2c7f7 98311 1467328
参考 Math.sqrt 99ef999f 98311；dsqrt 每 tick 0.68 µs；语料版本 1；apiVersion 0
[wx-selftest] 耗时：dsqrt 路径 67 ms（2000 拍、98311 tick、195597 子步，首轮运行、含 JIT 预热（如有）），Math.sqrt 路径 32 ms；计时 Date.now()
[wx-selftest] 设备 iPhone 7<iPhone9,1>；系统 iOS 15.8；平台 ios；微信 8.0.50；基础库 3.5.8
```

- **`DET <哈希> <steps> <steps/s>`**：dsqrt 路径（正式路径）。前两项与 `bun run det --kernel` 末尾打印的
  `DET <dsqrt 哈希> <steps>` **必须完全相同**（同一份 sim.js、默认拍数与种子）；第三项是本机速度，只作量级参考。
- **参考行**：`Math.sqrt` 路径的哈希与 steps（对照 det 表格的"Math.sqrt 哈希"列）、dsqrt 路径每 tick 的微秒数、
  语料版本、`apiVersion`。`Math.sqrt` 由 `game.js` 从外部注入，`sim.js` 里没有它。
  dsqrt 相同而 `Math.sqrt` 不同，说明该机的 `Math.sqrt` 与桌面引擎不逐位一致——正好印证模拟核心禁用 `Math.sqrt`，照实记录即可。
- **每 tick 微秒数** → `bench:sim` 的真机倍率：真机每 tick µs ÷（1,000,000 ÷ det 表里对应桌面引擎的 steps/s）。
  iOS 标准模式没有 JIT，与 `jsc-nojit` 比；iOS 高性能模式和安卓有 JIT，与 JIT 开启的引擎（`bun`、`node-arm64`）比。
  两边都是首轮运行、含 JIT 预热，口径相同。
- 出错时屏幕上是红字（同时 `console.error`），最常见的是没先同步 `sim.js`。

## 在 Mac 上跑

### 1. 准备 sim.js（仓库根）

```sh
bun install                            # 首次；postinstall 会把 git 钩子指向 .githooks
bun run sim:build                      # 生成 packages/sim/dist/{sim.js,sim.d.ts,sim.version}
bun run wx-selftest:sync               # 复制为 tools/wx-selftest/sim.js，校验并打印 simVer
bun run det --kernel --profile mac     # 记下 simVer、表格与末尾的 DET 行
git rev-parse --short HEAD             # 记下提交
```

`wx-selftest:sync` 与 `det` 打印的 `simVer` 必须相同（= 同一份 sim.js）。`dist` 不存在时 sync 会提示先
`bun run sim:build` 并以退出码 1 结束；复制后字节的 FNV-1a 与 `dist/sim.version` 不符也会失败。

### 2. 用微信开发者工具打开

1. 打开微信开发者工具 →「小游戏」→「导入项目」，目录选 `<仓库>/tools/wx-selftest`。
2. AppID：
   - 仓库里是 `touristappid`（游客模式的占位）。游客模式通常只能在模拟器里跑，不能预览到手机、不能真机调试。
   - 真机预览需要**测试号** AppID：在 <https://developers.weixin.qq.com/sandbox> 用微信扫码申请小游戏测试号，
     导入时填它（或导入后在「详情 → 基本信息」里改）。这个改动只留在本地，**不必提交**：提交前
     `git diff tools/wx-selftest/project.config.json` 确认，或 `git restore tools/wx-selftest/project.config.json`。
   - 正式 AppID 到手后同理（计划 1.2：测试号能预览、不能上传）。
3. 开发者工具导入时可能往 `project.config.json` 里补字段（如 `libVersion`），并生成本地的
   `project.private.config.json`；都不要提交。
4. 点「编译」：模拟器屏幕先显示"运行中…"，一两秒后出现 `DET` 行；「调试器 → Console」里有同样的行。
5. 比对：`DET` 行前两项 = 第 1 步 det 末尾的 `DET` 行；参考行的 `Math.sqrt` 哈希 = det 表格的 `Math.sqrt` 哈希。
   模拟器跑在开发者工具自带的桌面 JS 引擎上，只证明工程、加载方式与输出正确；G0 的证据是真机结果。
   模拟器屏幕截图留档（计划 10 章 10-09 的产出"wx-selftest 截图"）。

### 3. 真机

1. 工具栏「预览」→ 手机微信扫码打开，读屏幕上的 `DET` 行（看 console 用「真机调试」，或在小游戏右上角菜单里打开调试后重进）。
2. **iOS 标准模式与高性能模式各跑一次**并分别记录：
   - 标准模式：仓库里的 `game.json` 原样（不开高性能）。
   - 高性能模式：按微信官方文档开启（目前所知是在 `game.json` 里加 `"iOSHighPerformance": true`，开发版、体验版生效；
     **以官方文档为准，待核实**）。只在本地改，跑完 `git restore tools/wx-selftest/game.json`，不提交。
   - 屏幕上的设备行不一定能区分两种模式，模式以你的记录为准。
3. 安卓 ≤22 档与 23–29 档各跑一次（计划 7 章 G0 的设备矩阵：iPhone 7/8 两种模式、Face ID iPhone、安卓 ≤22、安卓 23–29）。
4. 每台、每种模式至少跑 2 次：steps/s 会波动，哈希必须每次相同。

### 4. 开发者工具命令行（可选）

先在开发者工具「设置 → 安全设置」里打开服务端口，并保持登录。`--project` 必须是绝对路径。

```sh
CLI=/Applications/wechatwebdevtools.app/Contents/MacOS/cli
$CLI open --project "$(pwd)/tools/wx-selftest"                            # 在开发者工具里打开
$CLI preview --project "$(pwd)/tools/wx-selftest" --qr-format terminal    # 终端里出二维码，手机扫码
```

`preview` 需要测试号或正式 AppID（游客模式不能预览）。

## 为什么 project.config.json 关掉这些选项

目标是让真机跑的就是门禁验过的那份 `sim.js`，开发者工具不改写、不校验代码：

| 设置 | 值 | 原因 |
|---|---|---|
| `setting.es6` | `false` | ES6 转 ES5 会用 Babel 改写代码（降级 `let/const`、箭头函数、类等），跑的就不是门禁验过的代码；`sim.js` 已是 ES2017，`game.js` 也只用 ES2017 |
| `setting.enhance` | `false` | 增强编译同样经 Babel 改写并注入辅助代码 |
| `setting.minified` | `false` | 压缩会重排、改名脚本 |
| `setting.uglifyFileName` | `false` | 代码保护会改文件名 |
| `setting.postcss` | `false` | 样式补全，与小游戏无关，一并关掉 |
| `setting.swc` / `setting.disableSWC` | `false` / `true` | 新版工具可用 SWC 编译脚本，一并关掉（字段名以官方文档为准） |
| `setting.urlCheck` | `false` | 不做域名与 TLS 校验；本工程不联网，关掉免得工具拦截或弹窗 |
| `setting.babelSetting.ignore` | `["sim.js"]` | 双保险：即使有人打开了 ES6 转换或增强编译，Babel 也不碰 `sim.js` |
| `setting.ignoreUploadUnusedFiles` / `ignoreDevUnusedFiles` | `false` | 不按依赖分析过滤文件，目录里有什么就打包什么 |
| `packOptions.ignore` | `README.md`、`.md` 后缀 | 说明文件不进代码包 |

即使这样，**预览与上传时微信仍会编译 `.js`**（计划 1.2），真机上的代码不保证与 `sim.js` 逐字节相同，
所以只能做行为检查——哈希比对就是这个检查。

## 结果记录

结果写进 `docs/spike-report.md`（计划 7 章 G0），每次运行一行，例如：

| 日期 | 提交 | simVer | 设备 | 系统 | 微信 / 基础库 | 模式 | DET（哈希 steps steps/s） | Math.sqrt 哈希 | 每 tick µs | det --kernel 的 DET | 一致 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| 10-1x | `abc1234` | `7d4357a0` | iPhone 8 | iOS 16.7 | 8.0.x / 3.x | 标准 | `efc2c7f7 98311 …` | `99ef999f` | … | `efc2c7f7 98311` | 是 |

- 通过线：所有设备、所有模式的 `DET` 前两项与 det（Node）相同。
- 不一致时按计划 8 章"浮点确定性"：① 扫产物找禁用函数（`bun run sim:scan tools/wx-selftest/sim.js`，
  并确认 project.config.json 的编译选项没被打开）；② 仍不一致 → 内核改 Q16.16，10-31 是最后决定日。

# 云端派单 A：仓库骨架 + 模拟内核 + 确定性门禁（计划第一周，2026-10-08 → 10-11）

开工前先读：
- `docs/工程构建计划.md` 全文，重点是第 2 章（布局、发布与禁令、契约、2.4 时间与接触语义）、第 6 章（工具）、第 10 章（第一周逐日清单）。
- `docs/微信羽毛球小游戏 制作方案.md` 的 §2.3–2.4、§3.2–3.3、§3.8；其余按需查。
- `docs/spike/det-smoke.js` 与 `docs/spike/det-smoke-结果.md`：2026-10-07 在 Mac 上的跨引擎实测。

方案与计划冲突时以计划为准。

## 范围：只做这些

云端没有 Mac、Cocos、微信开发者工具和真机，所以本单只做计划第 10 章"Claude（INT 会话）"一列里不依赖它们的部分。

1. **仓库骨架**：Bun workspaces；目录按计划 2.1（`packages/{contracts,sim,content,input-map,protocol}`、`server/`、`tools/`、`docs/`），暂时没有内容的目录放 `.gitkeep`。不要创建 `client/` 的 Cocos 工程。
2. **模拟内核** `packages/sim/src`：
   - `math.ts`：`dsqrt`，照搬方案 §3.3。
   - `rng.ts`：xorshift32，由种子派生 AI-A、AI-B、散布 3 路。
   - `hash.ts`：FNV-1a，覆盖 `Int32Array` 与 `Float64Array` 的位。
   - `flight.ts`：二次阻力 RK4，1/60 s 子步、每 tick 2 个子步；时间缩放 α：g′ = α²g、v0′ = αv0、k 不变。
   - `events.ts`：落地、过网平面高度、到达击球高度这三类事件在子步内线性插值，由一个共用函数提供（tablegen 以后也用它）。
   - 热路径零分配。
3. **内核语料**：把 `docs/spike/det-smoke.js` 移植成 `tools/det` 的内核语料（飞行 + 随机数 + 哈希，每 30 tick 混入完整状态）。保留原脚本的结论：dsqrt 路径与 Math.sqrt 路径在各引擎上各自一致。
4. **`tools/det`**：`bun run det --kernel [--profile linux|mac]`。
   - 引擎清单写在 `tools/det/engines.json`，全部用绝对路径。
     - linux 档：`node`（V8 x64）、`bun`（JSC JIT）、`BUN_JSC_useJIT=0 bun`（JSC 解释器；已在 Mac 上验证与 `jsc --useJIT=false` 同哈希）。
     - mac 档：`/usr/local/bin/node`（arm64）、`arch -x86_64 /usr/local/bin/node`、`~/.bun/bin/bun`、`/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc --useJIT=false`。
   - 跨引擎互比，不存期望值。
   - 配置的引擎任何一个缺失，或 arch/版本不符，即非零退出。
   - 每行打印：引擎名、`process.arch`（jsc 打印版本）、哈希、steps/s。
   - 不一致时打印首个分歧的语料号与 tick。
   - 自测：一个用了 `Math.sin` 的夹具必须让 det 判红。
5. **`sim:build` / `sim:scan`**：
   - esbuild 把模拟核心打成 `packages/sim/dist/sim.js`（IIFE、ES2017、不压缩）。
   - 文件末尾显式赋值 `(typeof GameGlobal !== 'undefined' ? GameGlobal : globalThis).BadmintonSim = api`。不要用 esbuild 的 `--global-name`：它产生的顶层 `var` 在微信、Cocos、Node、Bun 里都不会成为全局。
   - `tsc --emitDeclarationOnly` 生成 `sim.d.ts`（声明全局变量）。
   - 写 `dist/sim.version`（文件字节的 FNV-1a）。
   - `sim:scan` 拒绝：`Math.` 除 `abs/min/max/floor/ceil/trunc/round/sign/imul/fround` 以外的调用、`**`、`Date`、`Math.random`、`Math.sqrt`。
   - det 跑的必须是 `dist/sim.js`，不是源码。
6. **契约草案 v0**（`packages/contracts`）：
   - `api.ts`、`match-cfg.ts`（MatchCfg/PlayerCfg，按计划 2.3）。
   - `snapshot.schema.ts` + 偏移生成器（含每名球员最近 8 个 tick 的位置环、只许追加的 AI 状态块）。
   - BMRP 回放编解码 + 往返测试夹具。
   - InputEvent 16 字节编解码 + 测试。
   - 文件头写明"草案 v0，待 10-11 人工审定冻结"。不要自行宣布冻结。
7. **门禁与合并**：
   - `bun run gate`：`tsc -b`、ESLint 禁令、`bun test`、`sim:build`、`sim:scan`、`det --kernel`。
   - `bun run merge <轨>`：按计划 4.2 实现——在 worktree 跑 gate → `git merge --no-ff` → 主干再跑 gate → 红了回退，并把输出写到 `review/receipt-<轨>.md`。
   - pre-commit 钩子：ESLint 禁令 + 暂存区的 `sim:scan`。钩子放在仓库内的 `.githooks/`，用 `git config core.hooksPath .githooks` 启用，并写进 `bun install` 的 postinstall。
8. **`tools/wx-selftest`**：空白微信小游戏工程。
   - 包含 `game.json`、`game.js`、`project.config.json`（appid 用测试号占位 `touristappid`）。
   - `game.js` 加载同目录的 `sim.js`，跑内核语料，在屏幕和 console 打印 `DET <hash> <n> <steps/s>`。
   - 加 `bun run wx-selftest:sync`，把 `dist/sim.js` 复制进去。
   - 云端无法运行它；在 README 里写清楚 Mac 上怎么用微信开发者工具打开。
9. **`docs/AGENTS.md`**：代理红线。
   - 包体：主包 4 MB、总包 30 MB。
   - 禁用 API 与确定性规则。
   - 只用 Cocos 3.8 的 `cc` API。
   - 代理不碰 `.scene/.prefab/.meta`。
   - 热路径不分配。
   - 模拟核心不引用 `cc/wx/DOM/Node` 内置模块。

## 不做

Cocos 工程、真机、MP 后台、服务端、tablegen/calib/arena/playground（下一单），以及任何发布或外部账号操作。

## 规则

- 代码注释、提交信息、文档用中文（跟随仓库）。
- 在分支 `int/a-segment` 上工作，小步提交；完成后开 PR 到 `main`，不要直接推 `main`。
- 如果用 Python，命令写 `python3`。
- 契约细节拿不准时，按计划写的默认值做，并在 PR 描述的"待审定"里列出；不要停下来问。
- 云端没有 bun 就先装（`npm i -g bun` 或官方安装脚本），装不上就在回执里写明，并用 node 跑完其余部分。

## 验收（都要贴真实输出，不要自述）

- `bun run det --kernel --profile linux`：3 个引擎在 dsqrt 路径、Math.sqrt 路径上各自哈希一致；`Math.sin` 夹具判红（非零退出）。
- `bun run gate`：退出码 0，贴出测试条数。
- `bun run sim:build && bun run sim:scan`：退出码 0；`dist/sim.js` 在 node 与 bun 下加载后 `globalThis.BadmintonSim` 存在。
- 契约：InputEvent 与 BMRP 往返测试、快照偏移生成器测试通过。

## 回执（写在 PR 描述里）

1. 改动清单（文件 → 一句话）。
2. 验收命令与真实输出（测试条数、退出码、det 表）。
3. 待审定：契约里按默认值做的决定，以及与计划不一致之处。
4. 需要在 Mac 上由人做的事：mac 档 det 的跑法、wx-selftest 的打开方式。

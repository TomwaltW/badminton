# 代理红线（AGENTS.md）

> 适用于本仓库里所有 Claude Code 会话（INT 主干会话与各轨 worktree 会话）。来源：方案 §3.3、§3.6、§3.8 的操作纪律，
> 计划 2.2–2.4、4.2–4.4、6 章、10 章 10-10。方案与计划冲突时以计划为准。本文件由 INT 维护；代理不得自行放宽，
> 需要改动时写进回执的"变更请求"。
>
> 每条都是可检查的规则；能由工具强制的，后面注明由谁强制（ESLint / `sim:scan` / `det` / pre-commit / `gate`）。

## 0. 开工前

1. 读本文件、仓库根的 `CLAUDE.md` 与本轨派单（`review/paste-*.md`）。
2. 确认 git 钩子已启用：`git config core.hooksPath` 输出 `.githooks`（`bun install` 的 postinstall 会设置）。
3. 轨道会话：确认自己在本轨的 worktree（`.worktrees/task-tN`）里，基线是派单写明的主干 sha；INT 会话在派单写明的分支上。
4. 只写派单列出的写入范围；范围外的改动一律写进回执的"变更请求"，不要动手。

## 1. 包体

| 项 | 微信官方硬限制 | 本项目预算（计划 6 章 `size:check`） |
|---|---|---|
| 主包 | ≤ 4 MB（含代码与资源） | **≤ 3.5 MB**，按"含引擎"计（启用引擎插件后引擎代码仍计入首包） |
| 总包（主包 + 全部分包） | ≤ 30 MB | **≤ 20 MB** |
| 独立分包 | ≤ 4 MB | — |

- 只认上传结果或 `bun run size:check <构建目录>`（计划 10-14 上线）的独立扫描。**预览与真机调试时主包放宽到 8 MB，预览通过不算数。**
- 主包含引擎后 > 3.0 MB 就触发计划 8 章的预案（启动场景只放 2D 加载页，3D 全进分包）。
- 新增依赖、字体、贴图、音频前先估算包体；资源进分包（Asset Bundle）由人在编辑器里设。
- 不得把健康游戏忠告、适龄提示等合规内容挪出主包来"省"包体。
- 运行时预算（方案 §3.6；自拟预算 G1 实测后才定稿，不得自行放宽）：DrawCall 官方基准 ≤200，本项目对局 ≤100–150；
  内存峰值 ≤700 MB（iPhone 7/8 红线机）；低档机锁 30 fps、逻辑固定 30 Hz。不把 GPU Instancing 当作 DrawCall 预算的前提。

## 2. 确定性规则（模拟核心）

适用范围：`packages/sim/src/**` 与会被打进 `sim.js` 的 `packages/contracts/src/**`。

### 2.1 数学

1. 只用 `+ − × ÷`、比较、整数运算（`| 0`、`>>>`、`Math.imul` 等）与 `dsqrt`（`math.ts`）。
2. `Math` 只许 `abs / min / max / floor / ceil / trunc / round / sign / imul / fround`。（ESLint、`sim:scan`）
3. 禁用：
   - `Math.sqrt`——一律用 `dsqrt`（两者约 25% 的输入差 1 ulp，只能选一个）；
   - `Math.sin / cos / tan / exp / log / pow / hypot / atan2 / random` 及其他一切 `Math` 成员（超越函数在 V8 与 JSC、arm64 与 x64 之间不逐位一致，实测见计划 1.1）；
   - `**`、`**=`（实现相关的 pow，用连乘）（ESLint、`sim:scan`）；
   - `Date`、`performance` 等一切时钟（ESLint 禁这两个全局名；`sim:scan` 只查 `Date`）；
   - `eval`、`new Function`（微信也不支持）（ESLint）；
   - 把 `Math` 起别名、传参、解构或以计算属性访问（`Math[name]`）（ESLint、`sim:scan`）；
   - 名为 `Math` / `Date` 的成员访问与解构，不论对象是什么（`x.Math`、`x['Math']`、`x?.Date`、`const { Date: D } = x`、
     `import D = x.Date`）：全局对象可以先起别名（`const root = …; root.Math.sin`）或包在条件 / 逻辑 / 逗号表达式里，
     对象一侧无法静态判断，所以只看成员名；对全局对象做计算属性访问（`globalThis[k]`）。（ESLint、`sim:scan`）
4. 需要角度、三角函数时：离线查表（`tools/tablegen`，表的生成器也用模拟核心自己的 RK4 与 `dsqrt`）或改写成向量代数，运行时不调超越函数。
5. 固定运算顺序：同一个量在各处用同一段代码算（例如 RK4 的运算顺序与 `docs/spike/det-smoke.js` 逐项一致），不为"优化"重排浮点运算。

### 2.2 时间与步进

1. 逻辑步固定 **30 Hz**；每个 tick 恰好 **2 个 1/60 s 的 RK4 子步**（`flight.ts` 的 `stepSubstep`）。不改步长、不换积分器。
2. 时间单位 **u = 1/30000 s**：1 tick = 1000 u、1 ms = 30 u，tick 与 ms 都是整数 u。模拟里的时间一律用整数 u；
   事件时刻只取整一次（`events.ts` 的 `eventTimeU`）。
3. 落地、过网平面高度、到达击球高度这三类事件一律在子步内线性插值，**只用 `events.ts` 的 `crossSubstep` / `eventTimeU`**；
   模拟与 tablegen 共用这一个函数，不另写插值。
4. 时间缩放 α：g′ = α²g、v₀′ = αv₀、k 不变（`flightLaunch`）；力度只乘 α，不改 v₀ 档。
5. hit-stop 是模拟状态（冻结 tick：Perfect 2、杀球与赢分 3、赛点 4；赢分与赛点在死球时触发），不是纯视图效果。

### 2.3 随机数、状态与哈希

1. 随机数只走 `rng.ts` 的三路 xorshift32 流：**AI-A、AI-B、散布**，由 `MatchCfg.seed` 派生（`deriveRngStreams`）。
   不新增随机源，不跨流取数（AI 的随机选择也走它）。
2. 状态 = 预分配的定长 `Int32Array` + `Float64Array`；不用对象图、`Map` / `Set` 的迭代顺序、`for…in` 顺序参与计算。
3. 快照：写入前 **−0 归一为 0**，**禁止 NaN**（调试版断言）；派生缓存（如预测轨迹）不入快照，`load` 时重建；
   快照布局由 `snapshot.schema.ts` 生成偏移，12-21 前只许追加。
4. 校验和：FNV-1a 覆盖 i32 + f64 的位（`hash.ts`），每 30 tick 一个。

### 2.4 输入与配置

1. 输入按**触摸那一帧所显示的模拟时间**打戳，减去延迟校准值后量化成 16 字节的 `InputEvent`（消费 tick + 有符号 `offMs`，本地输入恒 ≤ 0）。
   延迟校准是唯一的偏移；不用真实时间或渲染滞后常数给模拟打戳。
2. **影响模拟的一切都进 `MatchCfg` 或 `contentHash`**：装备、属性、新手窗口、A/B 组等写进回放头与快照；
   远程 JSON 只放开关，不放模拟数值；场馆只改外观，不改终端速度。

### 2.5 门禁扫的是构建产物

1. 模拟核心只发布一个产物 `packages/sim/dist/sim.js`（IIFE、ES2017、不压缩，末尾显式挂到 `GameGlobal` / `globalThis`）；
   客户端插件脚本、服务端、门禁、`tools/wx-selftest` 都用它。不手改 `dist/`，不在别处直接引源码绕过它。
2. `bun run sim:scan` 扫的是 `dist/sim.js`（与以后的构建产物），不是源码；ESLint 管源码。两道都要过。
   （pre-commit 另用 `sim:scan --staged` 扫暂存区里的 `packages/sim/src/**/*.ts`、`packages/contracts/src/**/*.ts` 与 `dist/sim.js`。）
3. `bun run det --kernel` 用 `dist/sim.js` 在一档引擎上**跨引擎互比、不存期望值**；改了模拟就先 `sim:build` 再 `det`。
4. 不得为了变绿而放宽门禁：不改 ESLint 禁令、`sim:scan` 的允许清单、`tools/det/engines.json` 的期望，不在测试或门禁里写死哈希，
   不跳过测试。确需调整时写变更请求，由 INT 决定。

## 3. 模拟核心的边界

1. `packages/sim` 零依赖：不引用 `cc`、`wx`、DOM、Node 内置模块（`fs`、`path` 等）与 npm 包，只许相对路径导入，
   且只能留在本包内或指向 `packages/contracts/src`：契约的类型与运行时常量一律用相对路径 `../../contracts/src/<模块>`
   导入，不用包名 `@badminton/contracts`（工作区未链接，`tsc` 与 `sim.d.ts` 都解析不了）；`packages/contracts/src`
   同样只许相对路径，不得导入 `sim`；相对路径写成规范形式（不写 `./../`、`a/../`、`/./`、`//`）；不用动态 `import()`。（ESLint）
2. 不读写全局：`globalThis` / `GameGlobal` 只在 `src/index.ts` 末尾出现一次（挂 API）；不用 `console`、`setTimeout`、`process`。
   （ESLint：`index.ts` 以外禁这些全局名；`index.ts` 只放开 `globalThis` / `GameGlobal` 两个名字，其余禁令照样生效。
   "只出现一次、在末尾"靠人工审查；用 `declare const GameGlobal` 之类声明同名绑定会遮蔽全局、让 ESLint 的全局名检查失效，
   所以 `index.ts` 以外不写这类声明，也靠人工审查。）
3. `packages/*/src` 不用 `enum` / `namespace`，类型导入一律带 `type`（`import type { X }` 或 `import { type X }`）；
   导入不写 `.ts` 扩展名（含 `import type` 与 `export … from`）。（ESLint）
4. `sim.js` 的 API 字段只增不删，改名视为契约变更（走 INT）。

## 4. 热路径不分配

1. `step()` 以及名字以 **`step` / `cross` / `fnvMix` / `fnvHash` / `rngNext`** 开头的函数内，禁止 `new`、数组字面量、
   对象字面量、闭包（函数表达式、箭头函数）、展开。（ESLint 强制；按名字识别函数声明、`const` 函数、对象方法、
   类方法与类字段函数（`stepX = () => …`），方法本身不算闭包；`obj.stepX = function …` 这类赋值识别不到）
2. 状态放预分配的 TypedArray，函数签名用"数组 + 偏移"传入传出；临时量用模块级的 scratch 数组，不在热路径里 `push` 增长数组。
3. 新写的热路径函数按上面的前缀命名，让 ESLint 管得到；不要为绕过规则改名。

## 5. Cocos 与微信

1. **只用 Cocos Creator 3.8（3.8.8）的 `cc` 模块 API**（`import { Node, Vec3 } from 'cc'`）。不是 2.x：不写 `cc.Class`、
   全局 `cc.find` / `cc.director` 这类 2.x 用法，不照抄 2.x 教程。
2. Cocos 只支持 **TS 4.1 语法**、隐式 `isolatedModules`、**不读 tsconfig**、忽略类型错误。所以客户端代码：
   - 导入不写 `.ts` 扩展名；
   - 不用 `enum` / `const enum` / `namespace`；
   - 类型用独立的 `import type { X } from '…'`（内联的 `import { type X }` 是 TS 4.5 语法，不行）；
     隐式 `isolatedModules` 下转导出类型也要写 `export type { X } from '…'`；
   - 不用 TS 4.1 之后的语法：`override`（4.3）、`static {}` 块（4.4）、`satisfies`（4.9）、`accessor`（4.9）、`const` 类型参数（5.0）、`using`（5.2）等；
   - 类型错误由我们单独跑 `tsc`（用固化进仓库的 `cc.d.ts`）抓，Cocos 不会报。
3. `wx.*` 以官方 `minigame-api-typings` 为准，不凭记忆写 API 名与参数；平台调用集中在 `platform-wx` 层，用 mock `wx` 单测。
4. **代理不碰 `.scene`、`.prefab`、`.meta`**（11-18 起由 `merge` 的写入范围检查拦截，只许 INT 提交；在此之前靠本条与人工审查）：
   - 场景与资源只经编辑器、由人改；资源的增删移动只在编辑器里做，`.meta` 由编辑器生成后由人提交；
   - 静态环境（相机、灯光、平面阴影、球场、挂 `Bootstrap` 的节点）在 `boot.scene` 里由人手工搭；
   - 动态内容（角色、球、特效、UI）在 TS 里于运行时创建；资源只按路径加载（引用生成的 `assetPaths` 常量），不靠序列化引用；
   - 代理可以改已有 `.effect` 的文本，不新建资源文件；`Bootstrap.ts.meta` 的 uuid 永不改。
5. `sim.js` 在客户端是"导入为插件"的脚本（`client/assets/plugins/sim.js`，由同步脚本复制），通过全局 `BadmintonSim` 使用。
6. Cocos 构建只在构建车道上由人串行跑（官方命令行 + GUI 会话）；代理的验收只跑 `tsc` 与单测。P0 不用 cocos-mcp-server，
   也不把 alpha 工具（如 cocos-cli）放进流程。

## 6. 工作方式

1. **每轨一个 worktree**（`.worktrees/task-tN`，基线钉主干具体 sha）；只在自己的 worktree 里写。
2. **交付前跑 `bun run gate`**，必须退出 0；回执里贴真实输出（测试条数、退出码、det 表），不要自述。
3. **合并只由人运行 `bun run merge <轨>`**（worktree 跑 gate → `git merge --no-ff` → 主干再跑 gate → 红了自动回退，
   输出写到 `review/receipt-<轨>.md`）。代理不自己合并、不推 `main`、不改主干。
4. **契约改动只走 INT**：`packages/contracts` 的改动由 INT bump 版本并在 `packages/contracts/CHANGELOG.md` 记一行；
   轨道需要改契约时写变更请求（11-18 起为 `review/ccr-NNN.md`，周五不收）。
5. **pre-commit 钩子不得绕过**：禁止 `git commit --no-verify`，禁止改 `core.hooksPath`、删改 `.githooks/` 来求通过。
6. 提交信息、代码注释、文档用中文；标识符用英文。小步提交：一个任务 = 一个先失败的测试 + 一个目标，
   单次改动控制在几百行以内（方案 §3.8）。
7. **不做发布与外部账号操作**：不上传体验版、不登录或改 MP 后台、不申请或填写 AppID、不提交真实 AppID
   （`tools/wx-selftest/project.config.json` 保持 `touristappid`）、不推送派单未要求的远程分支。
8. 拿不准的契约或设计细节：按计划写的默认值做，在回执的"待审定"里列出，不停下来问。
9. 测试用 `bun:test`，不依赖预先构建的 `packages/sim/dist`（需要时 `buildSim({ outDir: 临时目录 })`）；
   临时文件放 `os.tmpdir()` 下的 `mkdtemp` 目录并清理。
10. 同一工作树可能有别的代理并行：不跑全仓库格式化，不删、不改不属于自己的文件。

## 7. 常用命令速查

| 命令 | 作用 |
|---|---|
| `bun install` | 安装依赖；postinstall 把 `core.hooksPath` 设为 `.githooks` |
| `bun run gate [--profile linux\|mac]` | 门禁总入口：`tsc -b --force`、ESLint 禁令、契约偏移（`contracts:gen --check`）、`bun test`（`CI=true`，禁 `.only`）、`sim:build`、`sim:scan`、`det --kernel`；交付前必须退出 0 |
| `bun run det --kernel [--profile linux\|mac]` | 用 `dist/sim.js` 在一档引擎上跨引擎互比内核语料，不一致时打印首个分歧的语料号与 tick；`--fixture sin` 自测必须判红 |
| `bun run sim:build` | 打包 `packages/sim/dist/sim.js` + `sim.d.ts` + `sim.version`（simVer = 文件字节的 FNV-1a） |
| `bun run sim:scan [文件\|目录…]` | 扫构建产物里的禁用 API（默认 `dist/sim.js`）；`--staged` 扫暂存区里的 sim / contracts 源码与 `dist/sim.js`（pre-commit 用） |
| `bun run merge <轨>` | **只由人运行**：gate → `merge --no-ff` → 主干 gate → 红了回退，回执写 `review/receipt-<轨>.md` |
| `bun run wx-selftest:sync` | 把 `dist/sim.js` 复制进 `tools/wx-selftest` 并校验 simVer（真机内核自测，见该目录 README） |
| `bun run contracts:gen [--check]` | 由 `snapshot.schema.ts` 生成快照命名偏移；`--check` 只比较 |
| `bun run typecheck` / `bun run lint` | `tsc -b` / `eslint .` |
| `bun test <目录>` | 单测 |

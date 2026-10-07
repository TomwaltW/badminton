# 羽毛球小游戏（微信小游戏，Cocos Creator 3.8.8 + 纯 TS 确定性模拟）

- 产品与合规方案：`docs/微信羽毛球小游戏 制作方案.md`（下称"方案"）
- 工程执行计划：`docs/工程构建计划.md`（下称"计划"）；两者冲突时以计划为准
- 代理红线：`docs/AGENTS.md`（第一单建立）
- 文档、代码注释、提交信息一律中文
- 模拟核心（`packages/sim`）只用 + − × ÷、比较、整数运算与 `dsqrt`；禁用 `Math.sqrt/sin/cos/tan/exp/log/pow/hypot/atan2/random`、`**`、`Date`；不引用 `cc`、`wx`、DOM、Node 内置模块
- 代理不得编辑 `.scene`、`.prefab`、`.meta`

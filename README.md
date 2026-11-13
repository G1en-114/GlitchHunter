# GlitchHunter / 卡洞玩家

单个 Agent 游玩与测试游戏的基础设施原型。
目标是通过玩家输入探索漏洞，并保留可核对的复现证据。

**当前状态**：单 Agent 截图决策、通用玩家动作、公开反馈与短期记忆、任务判定、限次重试、运行预算，以及操作记录与状态探针重放。
`npm run demo` 仍是脚本基线；`npm run play:deepseek` 才会调用模型。尚未实现 Godot 驱动、Fuzz 引擎和步骤缩减。

## 运行

需要 Node.js 22+，以及 Chromium。安装依赖：

```sh
npm ci
# 如果没有系统 Chromium，可以安装 Playwright 对应浏览器：
npx playwright install chromium
```

使用系统 Chromium：

```sh
CHROMIUM_PATH=/usr/bin/chromium npm run demo
CHROMIUM_PATH=/usr/bin/chromium npm test
```

安装了 Playwright 自带浏览器时不必设置 CHROMIUM_PATH。
demo 启动仅监听本机的 2048，执行 24 段真实键盘输入，再在干净上下文重放并核对所有探针检查点。
输出在 runs/ 下，包含初始截图、逐步截图、元数据、输入序列和摘要。
`verified: true` 表示本次被探针观察的状态检查点一致，不表示发现了漏洞，也不表示完整游戏状态逐位一致。

真人试玩本地示例：

```sh
npm run serve
```

打开 http://127.0.0.1:4173 。示例来源与许可在 third_party/2048/ 中；上游 MIT 许可保留。

## 用现有 DeepSeek Harness 游玩

需要已安装 `dsh`，并已在 Harness 中登录 DeepSeek 账号。
当前默认复用本机核查到的 `deepseek-account / deepseek-flash / high` 选择。
Harness 安装在本机，推理使用该账号的远端模型服务，不是 Ollama 本地推理。

```sh
CHROMIUM_PATH=/usr/bin/chromium npm run play:deepseek
# 默认目标为构造 32 方块，最多 12 个高层动作、180 秒。
CHROMIUM_PATH=/usr/bin/chromium GLITCHHUNTER_SEEDS=42,7 GLITCHHUNTER_TARGET_TILE=16 GLITCHHUNTER_MOVES=8 npm run play:deepseek
```

可设置 `DSH_BINARY`、`DSH_PLAYER_PROVIDER`、`DSH_PLAYER_MODEL`、`DSH_PLAYER_EFFORT`。
使用 `dsh --profile headless --patch ... --json`，启动时覆盖认证、模型和工具选择；不修改 Web profile 或复制登录凭据。
正常运行会由 Harness 生成其自身的会话与附件记录，并重写其 headless 空根配置，遵循所安装版本的标准启动流程。

模型每次获得当前截图、按键说明、公开分数/界面状态、最近最多六次动作及结果，以及自报的事实/假设/失败尝试短记忆。
必须成功读取当前截图，才接受其 JSON 动作。执行器将短按、保持、松开或等待展开为原子输入。
内部探针仅由独立任务检查与重放使用。单次模型调用默认 60 秒，决策最多两次尝试，格式修复失败后保存错误并结束。
宿主区分成功、游戏失败、停滞、预算耗尽和执行错误；模型主动停止不等于任务成功。
每次决策仍启动新的 headless 会话，尚未实现持久 SDK 连接和长程规划。

任务与预算可设置 `GLITCHHUNTER_TARGET_TILE`、`GLITCHHUNTER_SEED` 或 `GLITCHHUNTER_SEEDS`、`GLITCHHUNTER_MOVES`、`GLITCHHUNTER_MODEL_CALLS`、`GLITCHHUNTER_SECONDS`，详见 [M1 运行接口](docs/agent-loop.zh-CN.md)。
其中 `GLITCHHUNTER_MODEL_CALLS` 限制 Harness 决策尝试数，不是底层 API 请求数或 token 预算。

输出为 `runs/deepseek-*/`：

- `seed-*/decisions/`：实际截图、模型动作、重试错误和操作事件审计，不复制推理流或凭据。
- `seed-*/episode/`：原子输入、截图、内部检查点、公开反馈事件和运行摘要。
- `seed-*/result.json`：本轮结束状态、指标和重放结果。
- `batch.json`：本次请求的种子、任务与每轮结果。

2048 模式显式设置 `screenshotAnimations: disabled`，在截图时完成有限 CSS 动画，避免入场动画使棋盘暂时空白。
已检查该示例的游戏脚本不依赖 animationend/transitionend。此配置记录在轨迹中；普通适配器默认仍允许动画。
其他游戏必须单独验证，特别是依赖动画事件的实时游戏，不能直接套用这项截图配置。

## 接入策略

src/episode.mjs 的 runEpisode 接受一个异步 policy 函数，输入是截图、公开反馈和剩余预算，输出例如：

```json
{"type":"tap","key":"ArrowRight"}
```

仍兼容 `{"held":["ArrowRight"],"ticks":12}` 原子输入。高层动作的展开、预算和清理语义见 [接口说明](docs/agent-loop.zh-CN.md)。
传入 null 结束策略；任务成功由独立 evaluate 回调判定。Harness 连接位于 policy 边界，内部检查器数据不发送给模型。

## 设计

- [项目进度与实测记录](docs/progress.zh-CN.md)
- [后续工作计划与验收标准](ROADMAP.md)
- [架构与实现边界](docs/architecture.zh-CN.md)
- [M1 动作、预算、状态和反馈接口](docs/agent-loop.zh-CN.md)
- [开源游戏选型与 Rest-in-Pieces 核查](docs/games.zh-CN.md)
- [版本变化](CHANGELOG.md)

## 开源许可

项目代码采用 [MIT License](LICENSE)。`third_party/2048/` 保留上游独立许可与来源说明；其他候选游戏尚未纳入源码分发。
`runs/`、模型账户凭据和本机配置不纳入仓库。运行 Harness 模型示例需要使用者自己的安装与账号。

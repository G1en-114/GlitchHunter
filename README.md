# GlitchHunter / 卡洞玩家

单个 Agent 游玩与测试游戏的基础设施原型。
目标是通过玩家输入探索漏洞，并保留可核对的复现证据。

**当前状态**：浏览器输入、截图观察、隔离重置、时钟推进、录制与状态探针重放；已接入电脑上安装的 DeepSeek Harness，让单个模型根据截图选择按键。
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
# 默认 4 次模型决策；每次点击展开成按下和松开两段记录。
CHROMIUM_PATH=/usr/bin/chromium GLITCHHUNTER_MOVES=6 npm run play:deepseek
```

可设置 `DSH_BINARY`、`DSH_PLAYER_PROVIDER`、`DSH_PLAYER_MODEL`、`DSH_PLAYER_EFFORT`。
使用 `dsh --profile headless --patch ... --json`，启动时覆盖认证、模型和工具选择；不修改 Web profile 或复制登录凭据。
正常运行会由 Harness 生成其自身的会话与附件记录，并重写其 headless 空根配置，遵循所安装版本的标准启动流程。

模型每次只获当前截图、按键说明、最近最多六次选择和公开执行反馈。
必须成功读取当前截图，才接受它返回的 JSON 按键。工具执行守卫只放行当前图片；执行器检查按键后完成短按及松开。
内部状态探针仍仅用于重放核验。每次决策有 90 秒超时，失败结束本轮，不悄悄换成脚本。
首版每次决策启动一个新的 headless 会话，支持短历史，但尚未实现持久 SDK 连接与长程规划。

输出为 `runs/deepseek-*/`：

- `decisions/`：模型实际看的图片、按键决定和只含操作事件的审计，不复制推理流或凭据。
- `episode/`：展开后的完整按键序列、截图与内部核验检查点。
- `result.json`：模型选择、动作数和重放结果；失败时保存 `failure.json`。

2048 模式显式设置 `screenshotAnimations: disabled`，在截图时完成有限 CSS 动画，避免入场动画使棋盘暂时空白。
已检查该示例的游戏脚本不依赖 animationend/transitionend。此配置记录在轨迹中；普通适配器默认仍允许动画。
其他游戏必须单独验证，特别是依赖动画事件的实时游戏，不能直接套用这项截图配置。

## 接入策略

src/episode.mjs 的 runEpisode 接受一个异步 policy 函数，输入是截图、公开反馈和剩余预算，输出例如：

```json
{"held":["ArrowRight"],"buttons":[],"ticks":12}
```

下一次传入 `held: []` 会松开按键。持续 held 不会自动重复 keydown。
传入 null 结束本轮。Harness 连接位于 policy 边界，内部检查器数据不发送给模型。

## 设计

- [项目进度与实测记录](docs/progress.zh-CN.md)
- [后续工作计划与验收标准](ROADMAP.md)
- [架构与实现边界](docs/architecture.zh-CN.md)
- [开源游戏选型与 Rest-in-Pieces 核查](docs/games.zh-CN.md)
- [版本变化](CHANGELOG.md)

## 开源许可

项目代码采用 [MIT License](LICENSE)。`third_party/2048/` 保留上游独立许可与来源说明；其他候选游戏尚未纳入源码分发。
`runs/`、模型账户凭据和本机配置不纳入仓库。运行 Harness 模型示例需要使用者自己的安装与账号。

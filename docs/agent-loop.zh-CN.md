# M1：单 Agent 的任务、动作和结束状态

更新日期：2026-11-13。

## 一轮运行

1. 在新上下文中启动声明过的游戏配置，保存初始截图、探针状态与构建指纹。
2. 宿主先判断真实任务条件，已完成或失败时无需再问模型。
3. 模型读取当前截图、公开 HUD、最近动作结果和自己保留的短期记忆。
4. 模型输出一个高层动作，宿主校验并展开成玩家原子输入。
5. 每个输入执行前写入尝试事件，执行后保存截图和检查点。
6. 一个完整动作结束后，比较可见进度，生成公开反馈，再进行独立任务判定。
7. 达到目标、游戏失败、停滞或预算耗尽时结束；释放尚未松开的输入。

## 动作接口

模型策略输出动作；运行器仍兼容 v0.1 的原子输入。

| 动作 | 示例 | 语义 |
| --- | --- | --- |
| tap | `{"type":"tap","key":"ArrowLeft"}` | 默认按下 6 tick、松开并推进 12 tick；已有按住输入时先松开 1 tick，保证新的按下事件 |
| hold | `{"type":"hold","held":["ArrowRight"],"ticks":12}` | 设置完整持续按下状态，推进指定时间；支持声明过的鼠标按钮和位置 |
| release | `{"type":"release"}` | 松开全部键和鼠标，默认推进 1 tick |
| wait | `{"type":"wait","ticks":30}` | 松开输入后等待指定时间 |

持续 hold 不会自动重复 keydown。相反方向同时按下仍是可测试的玩家输入。
模型可以请求 `stop`，该请求只导致 `policy-stopped`，不能自行认证成功。

复合动作必须完整放入剩余原子输入和 tick 预算，包括它的松开阶段；预算不够则不执行，不静默截断。
任务检查在完整动作之后进行，避免成功时漏掉 tap 的松开记录。
逐原子输入检查仍可发现中间状态异常。

## 公开反馈和记忆

2048 的公开观察来自截图和已渲染的分数/终局 HUD。
宿主读取渲染格子的值与位置生成进度签名，只把“画面/局面是否变化”传给策略，不传签名或格子矩阵。
这是一项游戏专用的可见界面辅助观察，不是通用图像变化算法。

公开反馈包括动作已执行或被拒绝、是否出现可见变化、连续无变化次数、公开分数和界面状态。
规则检查和内部状态探针始终留在宿主。

模型可维护三个短列表：`facts`、`hypotheses`、`failedAttempts`。
每列表最多 4 项，每项最多 180 字符；记录明确标注为模型自报，不视为独立验证。
最近最多六个动作与对应公开结果也会被传入下一次决策。
当前仍逐决策启动新的 headless 会话，这些显式内容构成跨调用记忆。

## 结束状态

| status | 典型 reason | 含义 |
| --- | --- | --- |
| success | target-tile-reached | 独立任务条件已满足 |
| failure | game-over | 游戏失败；不等同于发现 Bug |
| failure | win-state-without-target-tile | 结束标记与实际目标状态不一致；保留证据，尚无自动缺陷归因 |
| stalled | no-visible-progress | 连续动作未产生可见进度；不证明游戏无解或软锁 |
| budget-exhausted | action-budget / step-budget / tick-budget / wall-time-budget / model-call-budget | 某项运行预算耗尽 |
| policy-stopped | model-requested-stop / policy-stop | 策略主动停止，宿主没有认证任务成功 |
| error | execution-error / cleanup-error / rejected-action-budget | 模型、输入、检查器或清理失败，保存错误摘要 |

2048 的任务是构造指定数值的方块。宿主检查真实格子状态，不以高分、模型声称成功或单独的胜利标记代替目标条件。
示例默认目标为 32；短程任务成功也不表示完整 2048 通关。

## 预算和失败处理

- 每轮分别限制高层动作数、原子输入数、模拟 tick 和墙上时间。
- 模型调用次数包括失败尝试，单次调用默认最多 60 秒，每个决策最多两次尝试。
- `modelCalls` / `GLITCHHUNTER_MODEL_CALLS` 的计数单位是 Harness 决策调用（包括失败尝试），由 `callUnit: harness-invocation` 声明。一次 Harness 调用通常含读图前后的多个模型步骤；该数字不是底层模型 API 请求数、token 用量或计费统计。
- 第一次输出错误后，用同一截图发起精简格式修复，只要求最小动作 JSON。
- 拒绝的最终答复可截取最多 4096 字符保留到本地错误记录，用于解释格式错误；不复制推理流。
- 重试耗尽如实结束为 error；不替换成脚本动作。
- 输入格式被运行器拒绝后，下一次决策能收到拒绝原因；重复拒绝也有上限。
- 墙上时间截止会取消模型调用，进程先 SIGTERM，最多另给 3 秒清理后 SIGKILL。
- 在途浏览器操作依赖自身超时，可能在当前操作完成后才能停止；释放输入与保存证据也有收尾开销。因此总进程时间可略高于决策预算。
- 若输入部分已发送但截图失败，事件明确标记 `mayHaveApplied`，使用驱动的实际按住状态释放输入，不把不确定执行伪装成完整成功轨迹。

## 轨迹和指标

新运行使用 `schemaVersion: 2`，重放器仍读取 v1。
`trace.jsonl` 保存每个原子输入及对应截图、公开 HUD、内部检查点。
`events.jsonl` 保存输入尝试、可能部分执行的错误、动作拒绝和可见进度反馈。

退出时如果仍有按键按住，宿主追加 `kind: release-all` 记录，不推进模拟时间；重放执行同一清理操作。
`steps` 和 `ticks` 统计预算内执行的玩家输入；`recordedSteps` 包含清理记录，`cleanupSteps` 单列。

摘要额外记录：高层动作数、策略调用数、拒绝数、产生可见变化的动作数、无进展次数、最大连续无进展次数、总耗时及模型调用/重试/失败次数。
可见变化率只是探索反馈，不是玩法正确性、通关率或漏洞发现率。

## 运行示例

```sh
# 默认：seed 42，目标 32，最多 12 个动作，180 秒。
CHROMIUM_PATH=/usr/bin/chromium npm run play:deepseek

# 多初始配置实测，每轮独立记忆与预算。
CHROMIUM_PATH=/usr/bin/chromium \
GLITCHHUNTER_SEEDS=42,7 \
GLITCHHUNTER_TARGET_TILE=16 \
GLITCHHUNTER_MOVES=8 \
GLITCHHUNTER_MODEL_CALLS=10 \
GLITCHHUNTER_SECONDS=120 npm run play:deepseek
```

结果位于 `runs/deepseek-*/seed-*/`，批次摘要为 `batch.json`。
某轮出现执行错误或重放偏差时，CLI 以非零状态退出并停止后续种子；正常预算耗尽和停滞保留独立状态。
CLI 正常退出表示实验流程结束，不表示任务必然成功；自动化调用应读取 `summary.status`。

# 被测游戏选型

核查日期：2026-11-11。下面的接入难度与测试用途是项目判断，不是上游承诺。

| 游戏 | 来源与许可 | 推荐用途 |
| --- | --- | --- |
| 2048 | https://github.com/gabrielecirulli/2048 ，MIT，见 LICENSE.txt | 第一接入：箭头输入、观察、重置、随机过程记录和回放。回合制，适合隔离基础设施问题。 |
| Javascript Tiny-Platformer | https://github.com/jakesgordon/javascript-tiny-platformer ，MIT，见 LICENSE | 第二接入：按住移动、跳跃、碰撞、坠落和连续时间。作者提供纯客户端 Canvas 实现。 |
| Javascript Tetris | https://github.com/jakesgordon/javascript-tetris ，MIT，见 LICENSE | 补充接入：旋转/移动/下落时序、暂停、结束与重开；验证“保持按键”和“多次按键”的区别。 |
| Dodge the Creeps | https://github.com/godotengine/godot-demo-projects/tree/master/2d/dodge_the_creeps ，代码 MIT | Godot 桥接的最小样例，先验证输入事件与截图，再接复杂 3D。README 单独列出音乐 CC-BY 3.0、图像 CC0、字体 OFL，分发时保留相应署名。 |
| 棺不住 / Rest-in-Pieces | https://github.com/G1en-114/Rest-in-Pieces | 自有项目的实际案例，接单人＋内置电脑队友。需要 3D 渲染和复杂物理验证。根目录未见独立 LICENSE，本文不将“公开仓库”推定为任意再分发许可。 |

## Rest-in-Pieces 源码核查

- README 标注 Godot 4.7.2；project.godot 使用 Godot 4.7、Forward Plus、Jolt Physics、120Hz 物理步进。当前工作环境没有 Godot 可执行程序，尚未运行该游戏。
- 支持单人、双人本地和双人联机。首轮只使用单人，内置电脑队友保留。
- main.gd 的 `_control_mouse_player()` 使用 WASD 物理键、Space、鼠标左右键；`_unhandled_input()` 处理鼠标与界面事件。不能只注入动作名就假设覆盖所有控制路径。
- 已有 --bot、--levelbot、--solotest、--botpath 等测试入口。它们可作现有回归和基线，不能冒充新 Agent 的玩家输入探索。
- README 明确存在有意设计的近路与秘密，所以“走了非默认路线”不能自动判成缺陷。
- 通关判定与分数分开：main.gd 中 `_update_rules()` 检查灵台、棺材倾角、逝者状态和持续时间。独立验证器应观察这些条件，而不只读分数。

推荐顺序：2048 → Tiny-Platformer → Dodge the Creeps → Rest-in-Pieces。
Tetris 作为额外跨游戏回归，第一阶段不并行接完所有游戏。

## 来源

- https://github.com/gabrielecirulli/2048/blob/master/LICENSE.txt
- https://github.com/jakesgordon/javascript-tiny-platformer/blob/master/LICENSE
- https://github.com/jakesgordon/javascript-tetris/blob/master/LICENSE
- https://github.com/godotengine/godot-demo-projects/blob/master/2d/dodge_the_creeps/LICENSE
- https://github.com/godotengine/godot-demo-projects/blob/master/2d/dodge_the_creeps/README.md
- https://github.com/G1en-114/Rest-in-Pieces/blob/main/README.md
- https://github.com/G1en-114/Rest-in-Pieces/blob/main/game/project.godot
- https://github.com/G1en-114/Rest-in-Pieces/blob/main/game/scripts/main.gd

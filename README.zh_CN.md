# Mortis — 最小 Coding Agent 学习项目

[English](./README.md) | [中文](./README.zh_CN.md)

实现最小 coding agent。核心循环：**接收 prompt → 调用 LLM → 执行工具 → 反馈结果 → 循环直到完成**——外面包一层小状态机与结构化的 Effect 生命周期。

不涉及多会话、复杂作用域，只关注一个可运行、可测试的最小闭环。

## 特性

- **副作用是一等公民**：小状态机内核（`State → think → Decision → act → reduce`），reducer 是唯一的状态变换点；工具并发执行、按声明顺序提交；普通历史只追加，前缀缓存友好
- **受限 Context**：Agent 授予私有 lease 后直接执行 compact，无模型往返。前缀替换为非信任摘要，最近消息原样保留。compact 不可撤销，也不保存 revision；提交前被替换消息先存档到磁盘
- **完整的 Effect 生命周期管理**：父链取消 Scope（Agent > Run > Effect）；Esc/Ctrl+C 随时中断运行中的回合，在飞的模型请求与子进程一并取消、会话保持可用；中断是正式的状态转移而非异常处理
- **受约束的副作用**：五区文件系统权限（custom R/RW/DENY > secrets > workspace > scratch > outside）对 read/write/edit 严格执法；bash 运行在由同一策略生成的 OS 沙箱内（macOS Seatbelt / Linux bubblewrap）
- **Persona——无副作用的认知**：`~/.mortis/persona/*.md` 用户可编辑的认知角色，只思考不行动，输出结构化 Evidence（Conclusion / Evidence / Proposal / Uncertainty / Effort）；`/planner` 把 Evidence 交给 Main Agent，执行前必先询问用户，代码也总是由 Main Agent 编写
- **人类在环**：`ask_user` 询问面板（Approve / Reject / Revise，键盘选择）为有风险的决策把关
- 流式 OpenAI 兼容供应商（含思考呈现）、聊天式 TUI、每次状态转移的会话 checkpoint 构成完整闭环

## 结构

```
src/
├── types.ts           # Message、Tool(+ToolContext)、Decision、Effect、ChatProvider
├── config.ts          # 配置解析；defaultSystemPrompt(tools, agentsMd)
├── context.ts         # compact direct action、context 估算、非信任摘要边界
├── instructions.ts    # AGENTS.md 发现（全局 + git 根→当前目录）
├── agent/
│   ├── state.ts       # AgentState + reduce()——唯一的状态变换点
│   ├── loop.ts        # Agent 循环（think → act）+ RunInterruptedError
│   ├── scope.ts       # 父链取消 Scope（Agent > Run > Effect）
│   └── events.ts      # Domain 事件（不含 UI 语义）
├── provider/
│   └── openai.ts      # OpenAI 兼容供应商：SSE、tool-call 缝合、思考流
├── tools/
│   └── index.ts       # read / write / edit / bash
├── session.ts         # 版本化 SessionSnapshot + latest.json checkpoint
├── tui/
│   └── index.ts       # pi-tui 终端 UI（交互聊天 + 单次两种布局）
├── cli.ts             # CLI 入口
└── index.ts           # 库公共出口
test/                  # vitest 测试套件，含属性式状态不变量测试
```

## 用法

```sh
# 安装
pnpm install

# 运行（面对任意 OpenAI 兼容端点）
MORTIS_BASE_URL=http://localhost:11434/v1 MORTIS_MODEL=qwen2.5-coder pnpm dev "给当前目录写一个 README.md"

# 或带参数
pnpm build
node dist/cli.js --base-url http://localhost:11434/v1 --model qwen2.5-coder "列出项目文件"

# 交互式 TUI（备用屏幕聊天布局）：输入框输入任务，Enter 提交，
# /q 或 Ctrl+D 退出；Ctrl+C 中断运行中的回合并保留会话
pnpm dev
pnpm dev "写个 fibonacci.ts 并运行验证"
pnpm dev --plain "写个 fibonacci.ts 并运行验证"

# 恢复最近一次会话继续聊（checkpoint 在每次状态转移后写入）
pnpm dev --continue

# 控制思考强度（作为 thinking_effort 发送；也可用 MORTIS_THINKING_EFFORT
# 或 ~/.mortis/config.json 配置）
pnpm dev --thinking-effort high

# 测试
pnpm test
```

## 配置

配置目录 `~/.mortis`，配置文件 `~/.mortis/config.json`。**首次运行会自动创建目录与配置文件**（只写入 baseUrl 与 model；**apiKey 永不自动落盘**——来自环境变量或 CLI 参数的 key 只在本次运行生效），无需手动 `--init`。

解析优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

```sh
# 显式初始化配置文件；首次运行也会自动创建
pnpm dev --init --base-url http://localhost:11434/v1 --model qwen2.5-coder
```

```json
{
  "model": "longcat/longcat-2.0",
  "providers": {
    "longcat": {
      "type": "openai",
      "apiKey": "xxxxx",
      "baseUrl": "https://api.longcat.chat/openai/v1"
    },
    "opencode": {
      "type": "openai",
      "apiKey": "xxxxx",
      "baseUrl": "https://opencode.ai/zen/v1"
    }
  },
  "models": {
    "longcat/longcat-2.0": {
      "provider": "longcat",
      "model": "LongCat-2.0",
      "maxContextSize": 1048576,
      "maxOutputSize": 131072,
      "capabilities": ["thinking", "tool_use"],
      "displayName": "LongCat-2.0"
    },
    "opencode/gpt-5.5-pro": {
      "provider": "opencode",
      "model": "gpt-5.5-pro",
      "maxContextSize": 1050000,
      "maxInputSize": 922000,
      "maxOutputSize": 128000,
      "capabilities": ["image_in", "always_thinking", "tool_use"],
      "displayName": "GPT-5.5 Pro",
      "supportEfforts": ["medium", "high", "xhigh"]
    }
  },
  "filesystem": {
    "scratchDir": "/tmp",
    "rules": [
      { "path": "/data/projects", "access": "rw" },
      { "path": "/etc/ssl/private", "access": "deny" },
      { "path": "/var/log", "access": "r" }
    ]
  }
}
```

`providers` 保存 OpenAI 兼容供应商连接。每个 `models` 键就是模型别名，
它引用一个供应商和一个实际模型 ID。顶层 `model` 选择 main agent 的别名。
Persona frontmatter 使用相同模型别名。顶层 `model` 写实际模型时，继续使用
`baseUrl`、`apiKey` 和 `thinkingEffort` 作为单供应商回退配置。

配置文件仍是 JSON。TOML 风格的 `api_key`、`base_url` 和
`max_context_size` 分别对应 `apiKey`、`baseUrl` 和 `maxContextSize`。

| 配置项 | CLI 参数 | 环境变量 | 默认 |
|---|---|---|---|
| Base URL | `--base-url` | `MORTIS_BASE_URL` | `https://api.openai.com/v1` |
| 模型 | `--model` | `MORTIS_MODEL` | `gpt-4o-mini` |
| API Key | `--api-key` | `MORTIS_API_KEY` | 无 |
| 思考强度 | `--thinking-effort` | `MORTIS_THINKING_EFFORT` | 不发送 |
| 权限模式 | `--permission-mode default\|acceptEdits\|yolo` | — | `default` |
| TUI | `--plain` 禁用 | — | TTY 下启用 |

交互模式中，`/sessions` 列出已保存会话，`/resume <id>` 恢复指定会话。默认权限
模式下写文件与 shell 命令会在对话框中请求批准（`acceptEdits` 只管 bash，
`yolo` 全部放行）；同一会话内已批准的命令不再重复询问。非交互运行不做审批。

## Context Compact

Compact 是运行时直执行的 direct action，不是模型决策。每次普通模型请求前，
Mortis 优先使用 provider 上次上报的 `prompt_tokens`，缺少时按
`JSON({ messages, tools })` 的 UTF-8 字节数除以二估算 token。估算值
达到输入上限的 80% 时，Agent 创建一次私有 lease：

- 优先使用模型别名的 `maxInputSize`。
- 缺少它时，用 `maxContextSize - maxOutputSize`。
- 两者都缺少时，不预先 compact。

随后 Agent 直接执行 compact，无模型往返。lease 历史在最后一个安全边界切分：
前缀以 JSON 交给用户可编辑的 `compact` persona（按 compact 模型自身的输入
预算从最旧开始截断）；最近的消息（默认 8 条，`keepRecentMessages`）原样保留。
Persona 只返回摘要数据，不接触 lease、State 或替换接口。Reducer 提交
`context_compacted`：保留连续的根 system 消息，前缀替换为一条
`<mortis-compacted-context>` user 记录，后接保留的原文尾部。根 prompt 把该
记录当作非信任数据，不会执行其中指令。

Persona 报错、空摘要或取消会丢弃 lease，不修改 State。供应商返回 context
超限错误时直接报错。请配置模型容量元数据，并在阈值前 compact。compact 后
不能 undo，也没有 revision UI；每次提交前，被替换的消息会存档到
`~/.mortis/sessions/latest.pre-compact.json`。

交互模式输入 `/compact` 可在阈值触发前手动 compact。该命令不会写入 Agent
history。自动流程 compact 后继续原任务。工具与 Persona 都不能请求 compact。

## 终端 UI

基于 pi-tui。**默认启用**，`--plain` 是唯一关闭开关：

- 无 prompt 参数时**直接进入交互模式**（备用屏幕聊天布局）：**多行输入框**——Enter 提交、Shift+Enter 换行（不支持 Shift+Enter 的终端用行尾 `\`+Enter）、↑/↓ 翻提交历史；`/q` 或 Ctrl+D 退出，**多轮答案累积**在滚动 transcript 里
- **Esc 立刻中断运行中的回合**：取消在飞的模型请求和 shell 命令，回到输入框继续输入；Ctrl+C 同样中断，空闲时按 Ctrl+C 直接退出
- transcript 滚动：鼠标滚轮 / PageUp / PageDown / Home / End，新输出自动跟随到底部；`Ctrl+Shift+F` 内容搜索；退出时完整对话打印回终端 scrollback
- **思考过程呈现**：模型 reasoning（`reasoning_content` / `reasoning` 流）生成期间在输入框上方实时预览（最多两行、跟随尾部），结束后落为 transcript 中的 `✻ thinking` 灰色块；`--thinking-effort` 控制思考强度
- **Context compact 状态**：compact 流程只显示状态行，不把 compact persona 的内部输出写进 transcript
- **询问面板（ask_user）**：模型可调用 `ask_user` 工具向用户提问——transcript 与输入框之间弹出 `✻ question` 面板（markdown 渲染、鼠标滚轮滚动），下方 `[ Approve ] [ Reject ] [ Revise ]` 选项，键盘 ↑/↓/←/→ 选择、Enter 确认、Esc 快速拒绝；选 Revise 时模型收尾本轮，用户的下一条消息即修订内容；Ctrl+C 中断整个回合
- 同一轮的多个工具调用**并发执行**、按声明顺序提交，工具行各自显示 ✓ / ✗
- 带 prompt 参数的单次运行用主屏流式渲染：每轮工具调用一行，完成后 ✓ 与结果摘要，最终答案按 markdown 渲染

实现：agent 通过 `onEvent` 回调发 **Domain 事件**（`model_request` / `context_compacting` / `context_compacted` / `assistant_thinking` / `assistant_text` / `tool_start` / `tool_result` / `run_interrupted`），`AgentTui` 订阅并从事件派生全部显示。模型与端点只从配置解析，无设置阶段。

## 架构

内核是一个小状态机，其余一切都是观察者：

```
State → think → Decision → act (Effect) → Result → reduce → State
```

七条核心不变量（详见 [AGENTS.md](./AGENTS.md)）：

1. State 是普通、可序列化的数据（`messages` + 派生的 `status`）
2. Reducer 是唯一的 State mutation authority
3. Decision 只描述下一步意图，不执行副作用；Effect 不可直接修改 State
4. Effect 可以并发，但 State transition 必须串行且 deterministic——并发执行、按声明顺序提交
5. Scope 拥有 Effect 的生命周期，Run 结束必须清理（Agent > Run > Effect 父链）
6. Agent Core 不知道 TUI、Persistence、具体 Runtime——UI 与持久化只观察 State/事件
7. 普通对话历史只追加。唯一例外是 Main Agent 授权的不可撤销 `context_compacted` direct Effect：它保留 system 根消息，把其余消息替换为一条非信任 user 摘要

由此带来的性质：

- **Decision ≠ 模型输出**：模型响应被解释为意图（`respond` / `execute` / `wait` / `finish`）；tool 调用是 `Effect` 的一种
- **中断是正式的状态转移**：`run_interrupted` 为悬空 tool 调用追加合成结果，任何非 running 状态都可直接发送，会话在取消/崩溃/恢复后依然可用
- **取消按层映射**：Effect 层见原生 `AbortError`、循环层抛 `RunInterruptedError`、UI 层渲染提示——没有跨层共享的错误类
- **观察者在边界**：TUI 与会话持久化只观察；checkpoint（`SessionSnapshot` 版本化、hydrate 时校验）在每次转移后写入，中途崩溃最多丢在飞的那一次转移
- **显式失败**：工具错误返回文本给模型而非抛异常；超时与取消内建（bash：默认 120 秒、上限 600 秒）
- **契约式测试**：provider 用本地 mock 服务器，循环用脚本化 mock provider，状态不变量用属性式测试回放随机事件序列

## Persona（认知角色）

**Persona 负责思考，Main Agent 负责决策，Effect 负责改变世界。** Persona 是被临时调用的认知视角：拥有 model / prompt / context / budget，但**没有工具**——不能读写文件、执行命令或联网。它的输出不是命令，而是供决策的结构化 Evidence：

```
Conclusion  推荐方案与理由
Evidence    支撑观察（事实与假设分开）
Proposal    可执行的有序计划
Uncertainty 未知与风险及消解方式
Effort      low | medium | high + 预期范围
```

交互模式输入 `/planner <task>`：Persona 先思考（流式呈现，含 reasoning），**Evidence 随后自动交给 Main Agent 判断**——接受并执行 Effect / 拒绝并说明 / 继续询问 Persona（`persona` 工具）/ 先用工具收集信息 / 没把握时 `ask_user`。Planner 只给概览（步骤/文件/签名/边界），不写完整实现代码；执行前 Main Agent **总是先 `ask_user` 确认**，代码也总是由 Main Agent 编写。Esc/Ctrl+C 在两个阶段都可中断。

**Persona 是用户可编辑的 markdown 文件**，放在 `~/.mortis/persona/`（首次启动自动生成 `planner.md` 与 `compact.md`，永不覆盖你的修改）。格式：frontmatter（`name` / `description`，可选 `model` / `thinking-effort` 覆盖）+ 正文即 system prompt：

```markdown
---
name: reviewer
description: Reviews code changes for bugs and style.
model: opencode/gpt-5.5-pro # 可选：配置模型别名或实际模型
thinking-effort: high       # 可选：换推理强度
---

You are Reviewer, a cognitive persona invoked by the Mortis main agent.
You think; you do not act. ...
```

Persona 使用别名时，会读取引用供应商的端点、API key、实际模型和模型元数据。
frontmatter 的 `thinking-effort` 会覆盖模型默认值。

系统启动时读取目录下全部 `*.md` 注册为可用 persona（坏文件跳过、name 缺省取文件名）。模型可经 `persona` 工具咨询普通角色。`compact` 只能经 Agent 带 lease 的 direct compact action 调用。它只能总结历史，不能直接替换 history。

## 自定义供应商

`ChatProvider` 是唯一抽象。OpenAI 兼容端点直接可用；其他协议实现该接口即可接入：

```ts
import type { ChatProvider, Message, StreamChunk, Tool } from 'mortis-agent'

class MyProvider implements ChatProvider {
  async *completeStream(messages: Message[], tools: Tool[], signal?: AbortSignal): AsyncGenerator<StreamChunk> {
    // 你的协议实现：流式产出 { kind: 'thinking' | 'text', delta } 增量，
    // 最后产出一个 { kind: 'tool_calls', tool_calls }；响应 signal 以支持取消
  }
}
```

## 文件系统权限

`read` / `write` / `edit` 由五区策略严格约束（`src/fs-policy.ts`）：

| 优先级 | 区 | 默认 | 权限 |
|---|---|---|---|
| 1 | custom | config.json `filesystem.rules` / CLI `--fs-rw` `--fs-r` `--fs-deny` | 每条规则自定 R / RW / DENY，最长前缀匹配，可覆盖一切内置区 |
| 2 | secrets | `~/.ssh`、`~/.mortis` | 拒绝一切访问 |
| 3 | workspace | cwd 的 git 根 | 读写 |
| 4 | scratch | `/tmp`（`--scratch` / `filesystem.scratchDir` 可配置） | 读写 |
| 5 | outside | 其余路径 | 只读 |

路径经 `realpath` 归一化，符号链接逃逸会被识别。拒绝以文本返回给模型，模型可据此调整。

## 安全边界

文件工具（read/write/edit）由五区策略严格约束；**bash 由操作系统级沙箱管住**：

- **macOS**：`sandbox-exec`（Seatbelt）——全局拒写 + RW 区子路径放行 + 拒绝区拒读，规则由策略自动生成。路径经 realpath 归一化（`/tmp` → `/private/tmp` 别名已处理），符号链接逃逸无效；超时会连带沙箱内子进程一起终止
- **Linux**：bubblewrap（`bwrap`，需已安装）——只读根挂载 + RW 区读写绑定 + 拒绝区 tmpfs 遮蔽
- **不可用或 `--no-sandbox`**：如实降级——启动警告、系统提示与工具描述都明示"unsandboxed"，不假装管住了

macOS Seatbelt 已知存在历史逃逸手法，沙箱是强约束而非绝对边界；对完全不受信任的模型仍需谨慎。

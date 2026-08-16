# Mortis — 最小 Coding Agent 学习项目

[English](./README.md) | [中文](./README.zh_CN.md)

实现最小 coding agent。核心循环：**接收 prompt → 调用 LLM → 执行工具 → 反馈结果 → 循环直到完成**——外面包一层小状态机与结构化的 Effect 生命周期。

不涉及多会话、复杂作用域，只关注一个可运行、可测试的最小闭环。

## 特性

- **流式 OpenAI 兼容供应商**——SSE 解析、增量 tool-call 缝合、非 SSE 回退、思考流（`reasoning_content` / `reasoning`）、`AbortSignal` 可取消
- **聊天式 TUI**——备用屏幕布局：滚动 transcript、多行输入框、实时思考预览、逐工具状态行；退出时完整对话打印回终端 scrollback
- **可中断**——Ctrl+C 取消在飞的模型请求与子进程，收尾状态后保留会话继续使用
- **并行工具、确定性状态**——同轮工具调用并发执行、按声明顺序提交；历史只追加不修改，供应商前缀缓存持续命中
- **会话恢复**——每次状态转移写 checkpoint，`--continue` 接续上次对话

## 结构

```
src/
├── types.ts           # Message、Tool(+ToolContext)、Decision、Effect、ChatProvider
├── config.ts          # 配置解析；defaultSystemPrompt(tools, agentsMd)
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
  "baseUrl": "http://localhost:11434/v1",
  "model": "qwen2.5-coder",
  "apiKey": "sk-...",
  "thinkingEffort": "high"
}
```

| 配置项 | CLI 参数 | 环境变量 | 默认 |
|---|---|---|---|
| Base URL | `--base-url` | `MORTIS_BASE_URL` | `https://api.openai.com/v1` |
| 模型 | `--model` | `MORTIS_MODEL` | `gpt-4o-mini` |
| API Key | `--api-key` | `MORTIS_API_KEY` | 无 |
| 思考强度 | `--thinking-effort` | `MORTIS_THINKING_EFFORT` | 不发送 |
| TUI | `--plain` 禁用 | — | TTY 下启用 |

## 终端 UI

基于 pi-tui。**默认启用**，`--plain` 是唯一关闭开关：

- 无 prompt 参数时**直接进入交互模式**（备用屏幕聊天布局）：**多行输入框**——Enter 提交、Shift+Enter 换行（不支持 Shift+Enter 的终端用行尾 `\`+Enter）、↑/↓ 翻提交历史；`/q` 或 Ctrl+D 退出，**多轮答案累积**在滚动 transcript 里
- **Ctrl+C 中断运行中的回合**：取消在飞的模型请求和 shell 命令，会话保留、可继续提问；空闲时按 Ctrl+C 直接退出
- transcript 滚动：鼠标滚轮 / PageUp / PageDown / Home / End，新输出自动跟随到底部；`Ctrl+Shift+F` 内容搜索；退出时完整对话打印回终端 scrollback
- **思考过程呈现**：模型 reasoning（`reasoning_content` / `reasoning` 流）生成期间在输入框上方实时预览（最多两行、跟随尾部），结束后落为 transcript 中的 `✻ thinking` 灰色块；`--thinking-effort` 控制思考强度
- 同一轮的多个工具调用**并发执行**、按声明顺序提交，工具行各自显示 ✓ / ✗
- 带 prompt 参数的单次运行用主屏流式渲染：每轮工具调用一行，完成后 ✓ 与结果摘要，最终答案按 markdown 渲染

实现：agent 通过 `onEvent` 回调发 **Domain 事件**（`model_request` / `assistant_thinking` / `assistant_text` / `tool_start` / `tool_result` / `run_interrupted`），`AgentTui` 订阅并从事件派生全部显示。模型与端点只从配置解析，无设置阶段。

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
7. **对话历史只追加、不修改**——所有事件（含中断补齐）都只 append，请求前缀逐字节稳定，供应商前缀缓存持续命中

由此带来的性质：

- **Decision ≠ 模型输出**：模型响应被解释为意图（`respond` / `execute` / `wait` / `finish`）；tool 调用是 `Effect` 的一种
- **中断是正式的状态转移**：`run_interrupted` 为悬空 tool 调用追加合成结果，任何非 running 状态都可直接发送，会话在取消/崩溃/恢复后依然可用
- **取消按层映射**：Effect 层见原生 `AbortError`、循环层抛 `RunInterruptedError`、UI 层渲染提示——没有跨层共享的错误类
- **观察者在边界**：TUI 与会话持久化只观察；checkpoint（`SessionSnapshot` 版本化、hydrate 时校验）在每次转移后写入，中途崩溃最多丢在飞的那一次转移
- **显式失败**：工具错误返回文本给模型而非抛异常；超时与取消内建（bash：默认 120 秒、上限 600 秒）
- **契约式测试**：provider 用本地 mock 服务器，循环用脚本化 mock provider，状态不变量用属性式测试回放随机事件序列

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

## 安全边界

Mortis **没有沙箱**。系统提示要求它在当前仓库内工作，但 `write` / `edit` / `bash` 接受任意绝对路径、可执行任意 shell 命令，实际不做任何路径或权限限制。只在你信任模型与端点的环境下运行。

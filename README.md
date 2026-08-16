# Mortis — 最小 Coding Agent 学习项目

实现最小 coding agent。核心循环：**接收 prompt → 调用 LLM → 执行工具 → 反馈结果 → 循环直到完成**。

不涉及多会话、复杂作用域，只关注一个可运行、可测试的最小闭环。

## 结构

```
src/
├── types.ts           # 共享类型：Message / Tool / ChatProvider / ModelResponse
├── provider/
│   └── openai.ts      # OpenAI API 兼容供应商（自定义 baseUrl + model）
├── tools/
│   └── index.ts       # 内置工具：read / write / edit / bash
├── agent/
│   ├── loop.ts        # Agent 循环核心
│   └── events.ts      # 循环事件（TUI 订阅）
├── tui/
│   └── index.ts       # pi-tui 终端 UI
├── config.ts          # 配置解析（CLI > env > ~/.mortis/config.json > 默认）
├── cli.ts             # CLI 入口
└── index.ts           # 库公共出口
test/
├── agent.test.ts         # Agent 循环测试（脚本化 mock provider）
├── provider.test.ts      # Provider 测试（本地 mock HTTP 服务器）
├── tools.test.ts         # 内置工具测试（read / write / edit / bash）
├── tui.test.ts           # TUI 渲染测试
├── instructions.test.ts  # AGENTS.md 发现与加载测试
└── config.test.ts        # 配置解析测试
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

# 直接进入交互式 TUI（备用屏幕聊天布局）：无 prompt 参数即在输入框输入任务，Enter 提交，/q 或 Ctrl+C/Ctrl+D 退出
pnpm dev
pnpm dev "写个 fibonacci.ts 并运行验证"
pnpm dev --plain "写个 fibonacci.ts 并运行验证"

# 测试
pnpm test
```

## 配置

配置目录 `~/.mortis`，配置文件 `~/.mortis/config.json`。**首次运行会自动创建目录与配置文件**（只写入 baseUrl 与 model；**apiKey 永不自动落盘**——来自环境变量或 CLI 参数的 key 只在本次运行生效），无需手动 `--init`。

解析优先级：**CLI 参数 > 环境变量 > 配置文件 > 默认值**。

```sh
# 初始化配置文件（写入 ~/.mortis/config.json）；首次运行也会自动创建
pnpm dev --init --base-url http://localhost:11434/v1 --model qwen2.5-coder

# ~/.mortis/config.json 内容示例
{
  "baseUrl": "http://localhost:11434/v1",
  "model": "qwen2.5-coder",
  "apiKey": "sk-..."
}
```

| 配置项 | CLI 参数 | 环境变量 | 默认 |
|---|---|---|---|
| Base URL | `--base-url` | `MORTIS_BASE_URL` | `https://api.openai.com/v1` |
| 模型 | `--model` | `MORTIS_MODEL` | `gpt-4o-mini` |
| API Key | `--api-key` | `MORTIS_API_KEY` | 无 |
| TUI | `--plain` 禁用 | — | TTY 下启用 |

## 终端 UI

基于 pi-tui。**默认启用**，`--plain` 是唯一关闭开关：

- 无 prompt 参数时**直接进入交互模式**（备用屏幕聊天布局）：内置输入框，Enter 提交任务、`/q` 或 Ctrl+C/Ctrl+D 退出，**多轮答案累积**在滚动 transcript 里
- transcript 滚动：鼠标滚轮 / PageUp / PageDown / Home / End，新输出自动跟随到底部；`Ctrl+Shift+F` 内容搜索；退出时完整对话打印回终端 scrollback
- 带 prompt 参数的单次运行用主屏流式渲染：每轮工具调用一行，完成后 ✓ 与结果摘要，最终答案按 markdown 渲染

实现：agent 通过 `onEvent` 回调发事件（`model_request` / `assistant_text` / `tool_start` / `tool_result`），`AgentTui` 订阅并驱动 pi-tui 组件树。模型与端点只从配置解析，无设置阶段。

## 自定义供应商

`ChatProvider` 是唯一抽象。OpenAI 兼容端点直接可用；其他协议实现 `ChatProvider` 即可接入：

```ts
import type { ChatProvider, Message, StreamChunk, Tool } from 'mortis-agent'

class MyProvider implements ChatProvider {
  async *completeStream(messages: Message[], tools: Tool[]): AsyncGenerator<StreamChunk> {
    // 你的协议实现：流式产出 { kind: 'text', delta } 或 { kind: 'tool_calls', tool_calls }
  }
}
```

## 安全边界

Mortis **没有沙箱**。系统提示要求在当前仓库内工作，但 `write` / `edit` / `bash` 接受任意绝对路径、可执行任意 shell 命令，实际不做任何路径或权限限制。只在你信任模型与端点的环境下运行。

## 核心思想

- **强类型自文档化**：类型即契约，`Message`/`Tool`/`ChatProvider` 直接映射 OpenAI wire 格式。
- **接口隔离**：provider、工具、agent 循环三者解耦，各自可替换。
- **显式失败**：工具错误返回文本给模型而非抛异常，模型可据此调整。
- **测试驱动**：provider 用本地 mock 服务器验证 wire 翻译，agent 用脚本化 mock provider 验证循环逻辑。
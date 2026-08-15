# AGENTS.md — Mortis

最小 coding agent 学习项目

## 结构

- `src/types.ts` — 共享类型（Message / Tool / ChatProvider / ModelResponse），映射 OpenAI wire 格式
- `src/provider/openai.ts` — OpenAI API 兼容供应商
- `src/tools/index.ts` — 内置工具 read / write / edit / bash
- `src/agent/loop.ts` + `src/agent/events.ts` — Agent 循环 + 事件回调
- `src/tui/index.ts` — pi-tui 终端 UI；含交互模式（输入框 + 答案累积）
- `src/cli.ts` — CLI 入口；无 prompt 参数且非 --plain 时进交互 TUI
- `test/` — vitest：agent 用脚本化 mock provider，provider 用本地 mock HTTP 服务器

## 规则

- 代码要简洁、表达清楚，不炫技
- 强类型：strict + noUncheckedIndexedAccess，类型即契约
- 相对导入用 `.js` 扩展名（NodeNext + verbatimModuleSyntax）
- 工具失败返回文本给模型，不抛异常
- 新增功能保持最小闭环：类型 → provider → 工具 → 循环 → CLI → 测试
- 测试用 vitest，provider 测试用本地 mock 服务器（不依赖真实 API）

## 命令

- `pnpm dev` — 交互式 TUI（输入框，Ctrl+D 退出）；`pnpm dev <prompt>` — 单次运行；`--plain` 关闭 TUI
- `pnpm build` — tsc 编译到 dist/
- `pnpm typecheck` — 类型检查
- `pnpm test` — vitest
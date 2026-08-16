# AGENTS.md — Mortis

最小 coding agent 学习项目

## 结构

- `src/types.ts` — 共享类型（Message / Tool / ToolContext / Decision / Effect / ChatProvider），映射 OpenAI wire 格式
- `src/provider/openai.ts` — OpenAI API 兼容供应商（SSE 流解析 + tool-call 缝合）
- `src/tools/index.ts` — 内置工具 read / write / edit / bash（工厂 `createBuiltinTools(policy)`）
- `src/fs-policy.ts` — 文件系统五区权限（custom 最高 > secrets > workspace > scratch > outside）
- `src/sandbox.ts` — bash 的 OS 级沙箱（darwin: sandbox-exec/Seatbelt；linux: bwrap；不可用则如实降级）
- `src/agent/state.ts` — AgentState + `reduce()`（唯一状态变换点；不变量的家）
- `src/agent/loop.ts` — Agent 循环（think → act）+ `RunInterruptedError`
- `src/agent/scope.ts` — 父链取消 Scope（Agent > Run > Effect 层次）
- `src/agent/events.ts` — Domain 事件（UI 语义不进这里）
- `src/session.ts` — 版本化 `SessionSnapshot` + latest checkpoint
- `src/tui/index.ts` — pi-tui 终端 UI；交互模式用 TuiAltScreen 聊天布局（ScrollView transcript + 多行 Editor 输入框），单次模式用 TuiMainScreen
- `src/cli.ts` — CLI 入口；无 prompt 参数且非 --plain 时进交互 TUI
- `test/` — vitest：agent 用脚本化 mock provider，provider 用本地 mock HTTP 服务器，state 含不变量测试

## 核心不变量

1. State 是普通、可序列化的数据
2. Reducer 是唯一的 State mutation authority —— `reduce()` 之外禁止修改状态
3. Decision 只描述下一步意图，不执行副作用；Effect 不可直接修改 State
4. Effect 可以并发，但 State transition 必须串行且 deterministic（并发执行、按声明顺序提交）
5. Scope 拥有 Effect 的生命周期，Run 结束必须清理
6. Agent Core 不知道 TUI、Persistence、具体 Runtime —— UI 与持久化只观察 State/事件
7. **对话历史只追加、不修改**：所有事件（含中断补齐、awaiting_user）都只 append，从不回改既有消息——请求前缀逐字节稳定，供应商前缀缓存可命中；system prompt 在进程内只构建一次，`--continue` 从快照原样恢复（含首条 system 消息）

职责边界：Model → Decision，Tool → ToolResult，Runtime → 执行 Effect，Reducer → 唯一改 State，UI / Persistence → 只观察。

状态保证：任何 `status !== 'running'` 的状态都可直接发送（悬空 tool 调用由 `run_interrupted` / `awaiting_user` 转移补齐合成结果）。

## 规则

- 代码要简洁、表达清楚，不炫技
- 强类型：strict + noUncheckedIndexedAccess，类型即契约
- 相对导入用 `.js` 扩展名（NodeNext + verbatimModuleSyntax）
- 工具失败返回文本给模型，不抛异常（取消的 AbortError 除外，需向上传播）
- 事件必须是具体的判别联合，禁止万能事件（string type + unknown payload）
- 新增功能保持最小闭环：类型 → provider → 工具 → 循环 → CLI → 测试
- 测试用 vitest，provider 测试用本地 mock 服务器（不依赖真实 API）；reducer 改动要过不变量测试

## 命令

- `pnpm dev` — 交互式 TUI（Esc 或 Ctrl+C 中断运行中的回合并保留会话，空闲时 Ctrl+C 退出；/q 或 Ctrl+D 退出）；`pnpm dev <prompt>` — 单次运行；`--plain` 关闭 TUI
- `pnpm dev --continue` — 恢复最近一次会话（~/.mortis/sessions/latest.json）
- `pnpm build` — tsc 编译到 dist/
- `pnpm typecheck` — 类型检查（src + test）
- `pnpm test` — vitest

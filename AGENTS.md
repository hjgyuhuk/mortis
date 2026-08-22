# AGENTS.md — Mortis

最小 coding agent 学习项目

## 结构

- `src/types.ts` — 共享类型（Message / Tool / ToolContext / Decision / Effect / ChatProvider），映射 OpenAI wire 格式
- `src/provider/openai.ts` — OpenAI API 兼容供应商（SSE 流解析 + tool-call 缝合 + HTTP 状态错误）
- `src/tools/index.ts` — 内置工具 read / write / edit / bash / grep / glob（工厂 `createBuiltinTools(policy, sandbox?, gate?)`）+ ask_user（交互模式询问面板）；write/edit/bash 可选审批门 `ApprovalGate`
- `src/fs-policy.ts` — 文件系统五区权限（custom 最高 > secrets > workspace > scratch > outside）
- `src/sandbox.ts` — bash 的 OS 级沙箱（darwin: sandbox-exec/Seatbelt；linux: bwrap；不可用则如实降级）
- `src/context.ts` — context compact direct action、容量估算、非信任摘要边界
- `src/agent/state.ts` — AgentState + `reduce()`（唯一状态变换点；不变量的家）
- `src/agent/loop.ts` — Agent 循环（think → act）+ `RunInterruptedError`
- `src/agent/scope.ts` — 父链取消 Scope（Agent > Run > Effect 层次）
- `src/agent/events.ts` — Domain 事件（UI 语义不进这里）
- `src/session.ts` — 版本化 `SessionSnapshot` + 多会话存储（`<id>.json` + `index.json`，兼容旧 `latest.json`）
- `src/persona.ts` — Persona 认知角色（无工具、单次完成、结构化 Evidence；默认生成 planner.md 与 compact.md；`/planner` 用户入口 + 模型侧 persona 工具）
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
7. **普通对话历史只追加**：普通事件、中断补齐和 awaiting_user 都只 append。唯一例外是运行时直执行的 `context_compacted`：Agent 只在 80% 阈值或 `/compact` 时创建私有一次性 lease，并直接执行（无模型往返；compact 是容量策略，不是模型意图）。它保留连续的根 system 消息，把前缀历史替换为一条非信任 user 摘要，保留最近 N 条原文（`keepRecentMessages`，默认 8，切分点不落在未应答 tool 调用中间）。该替换不可 undo，不保存 revision；提交前把被替换消息存档到 `latest.pre-compact.json`。compact persona 只返回数据，不接触 lease、State 或 Effect。

职责边界：Model → Decision，Agent lease → 运行时直执行 compact，Compact Persona → 摘要数据，Tool → ToolResult，Reducer → 唯一改 State，UI / Persistence → 只观察。

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

- `pnpm dev` — 交互式 TUI（Esc 或 Ctrl+C 中断运行中的回合并保留会话，空闲时 Ctrl+C 退出；/q 或 Ctrl+D 退出；/sessions 列会话、/resume <id> 恢复；`--permission-mode default|acceptEdits|yolo` 控制写/命令审批）；`pnpm dev <prompt>` — 单次运行；`--plain` 关闭 TUI
- `pnpm dev --continue` — 恢复最近一次会话（~/.mortis/sessions/latest.json）
- `pnpm build` — tsc 编译到 dist/
- `pnpm typecheck` — 类型检查（src + test）
- `pnpm test` — vitest

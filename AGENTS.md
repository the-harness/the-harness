# 项目约定

## 项目目标

本项目旨在从头重写一个 Harness，也就是 Agent。

最本质的设计风格：一切设计均采用当下最优方案。

## 技术选择

- 基本技术选择：DI、PTC-native、extensible、HMR。
- 基本技术栈：TypeScript、VitePlus、Vite、Vue、Vitest。
- `reactivity` 依赖对应 `@reactive-vscode/reactivity`（提供 `ref`、`reactive`、`shallowReactive`、`computed`、`watch`、`watchEffect`、`effectScope` 等）。
- Node.js 等有 LTS 的工具选用较新的 LTS 大版本，编译 target 等无 LTS 的配置选用较新的稳定版本。

禁止擅自引入复杂逻辑。任何复杂逻辑的引入，都必须由人类亲自确认。

## 仓库结构

- 每个 DI service 独立成一个包，每个包必须有独立的文件夹。
- `packages/`：纯 TypeScript 源码库，没有编译流程，也没有 `dist`。
- `apps/`：每个包都有编译流程，产出最终应用。`apps/` 里最多只能有 service 装配层和只与具体 app 形态相关的 service；核心 UI 逻辑等通用逻辑应当放在 `packages/` 里合适的包或新包中。
- `temp/worktrees/`：需要创建临时 Git worktree 时，统一放在此目录下，使用能体现任务的子目录名。
- `temp/artifacts/`：需要保存临时产物（如日志、截图、测试报告、调试输出）时，统一放在此目录下。
- VS Code 相关逻辑只是顺带实现的内容，核心是 Harness 系统本身，不得以 VS Code 为中心做设计。
- VS Code 兼容层的 API 仅服务于兼容需求，采用 VS Code 的 API 风格；其余模块必须保持本项目自身的设计风格，不得受其影响。

## 开发方式

- 不要运行 fmt、lint、test 等检查脚本，除非用户明确要求。
- 开发功能时，不允许自动添加测试。
- 不做测试覆盖率要求。
- 针对遇到的 bug，必须添加对应的端到端测试。
- 后台开发 Agent 可能会主动寻找潜在问题，并报告问题、补充测试。
- 代码中少写注释；每条注释必须提供无法从代码库推断的增量信息。
- 如果是可拓展的 interface，需要在 interface 开头加注释且在 README 中指出；否则是不可拓展的 interface。
- 如果有扩充 interface 的情况，需要在 README 中体现。
- 除非明确要求，禁止编写 Markdown 文档。
- 每个包必须有 `README.md`，内容仅限对外主接口的签名（并非所有导出项）及其方法或字段的简短注解，不得包含其他内容，保持克制。此要求优先于上述 Markdown 文档限制。

## 测试组织

- app 内的测试就近放在 `apps/` 中，要求全部通过。
- 其余测试放在仓库根目录的 `/tests` 中，按场景和 scope 组织。
- `tests/passed-baseline.json` 记录累计已通过的测试。根目录测试的普通失败不阻塞 CI，基线中的测试失败、跳过或缺失视为 regression。
- CI 在主分支和 PR 上都追加新增通过的基线记录，不自动删除旧记录；测试名称及参数名称应稳定且唯一。

## 提交与 PR 约定

建议快速提交。用户决定开始下一件事情时，若判断上一步修改已完整完成，则自动提交；若尚未完整完成，则暂不提交。

- 所有修改（即使是临时修改）都必须在新的 worktree（`temp/worktrees/` 下）中进行，而不是在根仓库。
- PR 标题必须遵循 Conventional Commits 规范。
- PR 合并需要用户明确指令。
- PR 必须通过 squash merge 合并。
- 合并 PR 不需要等待 CI 完成，不需要验证测试。
- 合并 PR 后，要将根仓库更新到最新的 `main` 分支。
- PR 描述必须写清楚对外接口的签名变化，禁止长篇文字。涉及接口变更时，代码块语言仍使用 `ts`，在增删行行首分别以 `+` / `-` 标注变动，未改动的方法仍需一并写出。

## 技术讨论与决策

善用 GitHub Issues。每个尚未确定的技术议题都必须创建 GitHub issue，并在其中展开讨论。必要时，在代码注释中链接相关 issue。

讨论技术决策时，推荐使用 subagent 并行探索 `references/{kimi-code,deepseek-harness,codex,pi,opencode,zcode}` 中的设计，再综合决策。

## 后端持久化

- 业务状态统一由中心 service 落盘，默认使用 SQLite，只有必要时才使用其他介质。所有介质遵守同一约定，断电恢复后的状态须等价于按全局受理顺序执行了前若干笔写入。
- 业务写入须在返回前固定内容并同步入队。`SqliteService.write()` 不得返回 Promise，正常返回仅表示已受理。进程持续运行且存储正常时，已受理的写入最终须落盘。
- 同一段连续同步执行中的写入必须整批生效。任一笔入队或提交失败，即使调用方捕获异常，整批也不得留下持久化效果，后续批次不得越过它。跨 `await` 的写入可分批提交。
- 运行时以业务内存为准，普通持久化读取不保证读到刚写入的数据。除 session 恢复等一次性加载外，只有必要时才读盘，并由调用方保证所读版本满足用途。

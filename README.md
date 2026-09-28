# 纪要成事 · Meeting Action Agent

把中文会议纪要转换成可审批、可验证、可追踪的行动项。系统会保留负责人、截止日期、优先级及理由、依赖、风险、原文证据和置信度，并用状态机约束外部写入。

继续开发前请完整阅读 [`docs/DEVELOPMENT_AGENT_HANDBOOK.md`](docs/DEVELOPMENT_AGENT_HANDBOOK.md)。中期实现与逐项验收结果见 [`docs/MIDTERM_REPORT.md`](docs/MIDTERM_REPORT.md) 和 [`docs/ACCEPTANCE_RESULTS.md`](docs/ACCEPTANCE_RESULTS.md)；可重复使用的功能输入见 [`docs/MANUAL_TEST_CASES.md`](docs/MANUAL_TEST_CASES.md)。

## 本地运行

```bash
npm install
npm run dev
```

打开终端显示的前端地址。Windows 也可双击 `启动演示.bat`，固定从 <http://localhost:5174> 启动，API 默认使用 `8788` 端口。启动 Agent 前必须配置并测试一个模型 API。

生产构建与启动：

```bash
npm run build
npm start
```

生产服务默认位于 <http://localhost:8788>，可通过 `PORT` 修改。

## 完整工作流

前端已接入有状态 Agent API：

```text
会议纪要 → 分析 → 必要澄清 → 统一审批 → 任务创建（Local Task Hub / 飞书任务）
         → 逐字段回读验证 → 状态追踪 → 完成闭环
```

- 信息缺失、置信度较低或优先级信号冲突时，界面会提出负责人、日期、确认或优先级问题，并保存澄清历史。
- 审批页支持选择创建范围、编辑字段和调整优先级；未选任务不会创建。
- 批准后显示工具调用、任务 ID（本地任务为 `LTH-*`，飞书任务为平台 GUID）、回读验证结果和追踪统计。
- 追踪页可更新任务状态（本地任务直接生效，飞书任务会写回平台）；所有已批准任务完成后，运行进入 `completed`。
- 对话区接受自然语言补充、进度查询、任务状态请求，以及标题、描述、负责人、截止日期和优先级修改。含糊指令会追问；写入先展示旧值与新值并等待确认，追踪中的修改会回读对应任务，活动记录说明变化。
- 当前待处理只显示未解决的澄清，已回答或撤销的项目保留在历史；任务开始、完成和首次逾期会留下带任务上下文的事件。
- 浏览器仅保存最近一次运行的 `runId`，刷新页面会从服务端恢复同一运行。可用“新建运行”清除当前浏览器关联；执行中或失败待恢复时该入口会隐藏。
- Markdown 和 CSV 导出仍然可用。

首页提供一组综合演示输入：`完整流程测试纪要` 用真实对话式纪要在同一次运行中覆盖部分批准、单条飞书写入、状态与字段写回复测、澄清、成员别名、优先级冲突、依赖风险和非任务讨论。它需要配合一份用户 Markdown Skill（会提示载入，不会自动覆盖已保存内容），并在审批时只勾选飞书复测任务写入飞书，其余行动项保留在系统内。

任务写入默认使用仓库内的 **Local Task Hub**，用于验证审批、幂等创建、回读和追踪闭环。配置飞书应用并在“平台连接”完成成员绑定后，可把审批选中的任务真实写入 **飞书任务 v2**：支持创建、按 GUID 回读、幂等复跑、状态与字段写回、清单归类、到期提醒和任务定位，评论同步以飞书应用权限为界。Trello、Todoist、Notion 属于后续扩展方向。

## 用户 Markdown Skill 与 Prompt Skill

用户 Skills 面板支持创建多个独立 Markdown 文件。你可以用自然语言写成员别称、术语、优先级习惯、会议类型要求或任务整理偏好；系统不要求固定字段，也不会用正则把正文解析成本地规则。启用的文件会随运行保存快照，并在运行检查器中展示实际注入内容。Skill 只能补充业务知识，不能绕过审批或改变工具权限。

分析、对话和流程规则拆分为 9 个版本化 Prompt Skill：`meeting-extraction`、`completeness-check`、`clarification`、`task-planning`、`priority-reasoning`、`verification`、`tracking`、`dialogue-orchestration`、`task-editing`。抽取请求实际注入抽取、完整性和优先级模块；自然语言意图请求注入对话编排与任务编辑模块。其余模块目前指导确定性的状态机流程，并非每一步都调用模型。运行记录保存版本，便于回归和审计。

## 启用 AI 结构化抽取

点击页面顶部的模型连接入口，填写 API Endpoint、API Key 和模型名称并测试连接。默认预设兼容 DeepSeek，也可以连接其他 OpenAI-compatible Chat Completions API。环境变量配置仍然可用。

通过页面填写的 API Key 会保存到被 Git 忽略的 `data/model-config.env`，不写入浏览器存储、任务 JSON 或仓库；接口只返回脱敏状态，服务重启后仍可使用。模型未配置、调用失败或结构化输出无效时，系统会明确报错，不会静默生成本地规则结果。

## Agent API

| 方法 | 路径 | 用途 |
|---|---|---|
| `POST` | `/api/agent/runs` | 创建运行并分析纪要 |
| `GET` | `/api/agent/runs/:id` | 按 `runId` 恢复运行 |
| `POST` | `/api/agent/runs/:id/clarify` | 提交当前澄清答案 |
| `POST` | `/api/agent/runs/:id/approve` | 批准选中任务并执行创建、回读验证 |
| `POST` | `/api/agent/runs/:id/track` | 刷新已验证任务的追踪状态 |
| `POST` | `/api/agent/runs/:id/commands` | 页面快捷操作的统一 Agent 命令入口 |
| `POST` | `/api/agent/runs/:id/messages` | 用配置的模型理解自然语言消息并给出回报或待确认操作 |
| `POST` | `/api/agent/runs/:id/confirm-action` | 确认或取消对话提出的状态或字段变更 |
| `PATCH` | `/api/agent/tasks/:id` | 修改任务状态（本地任务或飞书任务） |
| `GET` / `PUT` | `/api/user-skills` | 读取或保存用户 Markdown Skill |
| `GET` / `POST` / `PUT` | `/api/integrations/feishu/*` | 飞书连接状态、OAuth 身份绑定、写入设置和清单检索 |
| `GET` | `/api/connectors` | 连接器状态与配置检测（本地 / 飞书） |

兼容用的 `POST /api/analyze` 仍保留，但主界面使用 Agent API。

## 验证

```bash
npm test
npm run build
npm audit --omit=dev
```

当前自动化测试为 3 个测试文件、93 个用例。测试通过模型 mock 验证状态机和对话命令，不调用真实供应商 API。另用隔离运行数据对真实模型的澄清、审批、回读、歧义追问、状态确认、字段修改和闭环做了浏览器冒烟；飞书侧另有真实创建、按 GUID 回读、幂等复跑与评论同步的实机记录。构建会提示主 JavaScript 包约 1.05 MB，属于待优化的分包提醒，不是构建失败。

人工验收提供 13 套分析输入和 10 套对话输入，覆盖完整抽取、澄清、成员别名、泛称负责人、相对日期、优先级规则与冲突、依赖与风险、审批安全、部分批准、刷新恢复、任务编辑和追踪闭环。机器可读版本位于 `test-data/manual-test-cases.json`；对话样本尚未全部逐项运行。

## 安全与当前限制

- 所有任务创建必须经过显式人工批准；审批前调用追踪或注入计划外任务会被拒绝。
- 创建使用幂等键，重复提交相同审批不会重复创建；创建后会逐字段回读。
- `data/agent-store.json` 同时保存运行、用户 Skill 快照和 Local Task Hub 数据；飞书身份绑定与写入设置保存在 `data/feishu-identities.json`。两者均已被 Git 忽略；历史团队结构只作为兼容数据读取。
- 当前 JSON store 适合本地单进程演示，不支持多进程并发或生产级数据库能力。
- API 尚无身份认证；不要把当前服务直接暴露到不受信任网络。
- 失败运行通过原审批载荷复用 `/approve` 安全重试，尚无独立 retry API。
- `analyzing` 为同步请求内阶段，前端只会短暂展示该状态。
- 飞书任务 v2 是当前唯一真实接入的任务平台；负责人变更、子任务、附件 / 文档上传和 Webhook 自动同步尚未接入，Trello、Todoist、Notion 属于后续扩展。
- 评论同步依赖飞书应用权限；权限不足时不回滚主任务，界面会给出可见提示和权限检查入口。
- 对话目前不支持任意新增 / 删除任务，也不把自由文本直接当作创建审批。

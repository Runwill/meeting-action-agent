# 中期汇报实拍截图索引

> 采集日期：2026-09-21。目录：`screenshots/midterm-2026-09-21/`（本机存在、被 Git 忽略，不会随仓库提交）。
>
> 全部来自运行中的 React 界面和隔离的 Local Task Hub；会议、人员、任务均为合成测试数据。没有拍摄 API Key 或用户原有运行数据。

## 按功能组交付

下游制作请优先使用 `midterm-delivery-2026-09-21/FUNCTION_GROUPS.md` 和同名文件夹中的截图副本。截图按“优先级人工审核、人员别称、负责人澄清、澄清生命周期、任务生命周期、Agent 对话、检查器、响应式界面”八组组织；同一组的输入、处理中和结果图属于一个功能证据链，不要按每个状态单独命名产品亮点。重点开题问题的主线图为 H01a-c、H02a-b、H03a-d。

## 建议用于 PPT 的主图

| 图号 | 文件 | 适合说明的事实 |
|---|---|---|
| S01 | [会议纪要输入](../screenshots/midterm-2026-09-21/S01c-meeting-input-from-start.png) | 从标题、日期与参会人开始展示完整形态的合成纪要，并启动 Agent |
| S02 | [主动澄清](../screenshots/midterm-2026-09-21/S02-clarification-workspace.png) | 三个候选行动项中，仅公告初稿的截止日期需要确认 |
| S03 | [当前待处理](../screenshots/midterm-2026-09-21/S03d-open-items-unobstructed.png) | 一个尚未回答的日期问题；来自独立澄清补拍运行，不与 S05 冒充同一次运行 |
| S04 | [执行轨道](../screenshots/midterm-2026-09-21/S04-agent-rail-clarifying.png) | 分析、澄清、审批、执行、验证、追踪的阶段状态 |
| S05 | [待处理归零](../screenshots/midterm-2026-09-21/S05-resolved-open-items.png) | 同一运行回答日期后，问题从当前待处理转入已处理历史 |
| S06 | [人工审批](../screenshots/midterm-2026-09-21/S06c-approval-unobstructed-top.png) | 负责人、日期、优先级和选择创建范围；审批图取自另一条合成运行 |
| S07 | [用户 Markdown Skill](../screenshots/midterm-2026-09-21/S07-user-markdown-skill.png) | 用自然语言写成员别称、术语和优先级习惯 |
| S08 | [运行检查器](../screenshots/midterm-2026-09-21/S08g-dialogue-and-task-editing-skills.png) | 项目对话规则与用户 Skill 分层，包含新增 `task-editing` 模块 |
| S09 | [进度问答](../screenshots/midterm-2026-09-21/S09-progress-query-conversation.png) | 聊天框触发模型理解进度查询并由 Agent 回报 |
| S10 | [状态变更提案](../screenshots/midterm-2026-09-21/S10-status-change-proposal.png) | 修改状态先显示旧值→新值，等待明确确认 |
| S11 | [日期修改提案](../screenshots/midterm-2026-09-21/S11b-date-edit-before-after-proposal.png) | 新增对话任务字段编辑，确认前不写入 |
| S12 | [创建与回读](../screenshots/midterm-2026-09-21/S12-local-task-hub-readback.png) | 三个 `LTH-*` 本地任务 ID 和“回读一致” |
| S13 | [完成闭环](../screenshots/midterm-2026-09-21/S13d-completed-local-tasks.png) | 三项任务全部完成，运行进入闭环状态 |
| S15 | [390px 移动端](../screenshots/midterm-2026-09-21/S15j-mobile-completed-header-390.png) | 移动端完成态统计与任务；视口裁切，固定导航不遮挡正文 |

PPT 正文建议选其中 6–8 张，不要每页堆多张小图。报告正文及附录可用下列补充证据。

## 报告附录与答辩备份

| 主题 | 可用文件 | 说明 |
|---|---|---|
| 模型连接 | `S00-model-connection-desktop.png`、`S00b-model-connection-390.png` | 已连接、保存在本机、可测试/保存/清除的 UI；Key 预览区在采集时遮盖，移动版标题换行较紧，适合附录而非主图 |
| 首页与输入 | `S01d-entry-desktop-from-start.png` | 含纪要首行、常驻导航的宽屏视图；输入框内剩余内容需滚动查看 |
| 澄清前后 | `S03c-clarification-answer-ready.png`、`S03d-open-items-unobstructed.png`、`S05b-clarification-conversation.png` | 输入日期、当前问题、回答与 Agent 回报；`S03d` 来自独立的第二条澄清运行，不要与 S05 冒充同一运行 |
| 审批依据 | `S06d-priority-reason-unobstructed.png`、`S06e-approval-confirmation-controls.png`、`S06f-priority-menu-open.png` | 原文证据、优先级理由、按钮与菜单；这些图来自未执行创建的独立审批运行 |
| 多份用户 Skill | `S07b-multiple-user-skills.png` | 第二份 Markdown 在首条演示运行之后加入；不是那次分析的 Skill 快照 |
| 检查器 | `S08a-inspector-original-notes.png`、`S08b-inspector-user-skill-snapshot.png`、`S08d-inspector-model-output.png`、`S08e-inspector-dialogue-calls.png`、`S08h-model-input-context.png`、`S08i-model-original-output.png` | 原文、运行快照、结构化输出及对话实际输入/原始输出。长 JSON 图适合附录，不宜缩小塞进 PPT |
| 模糊指令 | `S11a-incomplete-date-asks-again.png` | 只给“2027年”时模型追问月日，没有产生提案 |
| 确认结果 | `S11c-date-edit-confirmed.png`、`S11d-field-edit-activity.png`、`S10b-status-confirmed-activity.png` | 确认后的回报、回读事件和状态变更来源 |
| 工具与追踪 | `S12b-tool-verification-activity.png`、`S13b-tracking-in-progress.png`、`S13e-completion-activity.png` | 创建/验证活动、进行中统计、完成记录 |
| 移动端 | `S15-mobile-clarification-390.png`、`S15g-mobile-approval-header-390.png`、`S15h-mobile-approval-priority-390.png`、`S15k-mobile-completed-task-390.png`、`S15l-mobile-completed-header-320.png` | 澄清、审批、优先级依据与 390px/320px 完成态。后四张按可视区域截取，顶端导航没有进入裁切范围 |

## 运行与使用边界

- 主闭环运行 `7f6d91bb-d340-408f-b653-38f6a8e2c390`：真实 DeepSeek 分析、一次日期澄清、三项审批创建、回读、进度问答、模糊日期追问、完整日期字段提案确认、状态提案确认及最终 3/3 完成。
- 补拍审批运行 `6485fe5b-fa2f-4008-89b2-a1f4d4d0dddc`：只停留在 `awaiting_approval`，用于无遮挡显示审批；没有创建任务。
- 补拍当前待处理运行 `9c4f0764-9cad-4648-8f1b-888b6c241e06`：只用于显示一个未解决的日期问题。
- 浏览器已在 1440px、390px 和 320px 检查相关视图；补上站点 favicon 后隔离页面复测无控制台错误。`npm test`、构建与审计结果以 `ACCEPTANCE_RESULTS.md` 的最新命令输出为准，不制作“终端截图”假图。
- 下列 13 张早期试拍有文本停在末尾、导航遮挡、长元素截图拼接、裁切不完整或文件名不准确，**不要用于报告/PPT**：`S01-meeting-input-workspace.png`、`S01b-entry-desktop.png`、`S03-open-items.png`、`S03b-agent-conversation-clarifying.png`、`S06-human-approval-list.png`、`S06b-priority-reason-evidence.png`、`S08f-model-dialogue-output.png`、`S15b-mobile-approval-390.png`、`S15c-mobile-tracking-390.png`、`S15d-status-menu-scrollbar-visible.png`、`S15e-mobile-conversation-390.png`、`S15f-mobile-completed-320.png`、`S02b-clarification-desktop-context.png`。另有 `S15g` 的首次无效试拍已被同名有效视口图覆盖。可用替代图已列在上表；环境限制未允许清理其余二进制试拍文件。

这些截图是功能存在和流程运行的证据，不是模型在真实会议数据上的准确率证明。需要提交或分享给组员时，须将本机截图目录单独打包传递；不要把图片、配置、临时 store 或 API Key 提交 Git。

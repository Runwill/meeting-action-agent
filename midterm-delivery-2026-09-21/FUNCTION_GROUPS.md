# 功能组截图索引

## 01 优先级判断与人工审核

主线：`H01a-priority-conflict-question.png` → `H01b-priority-human-options.png` → `H01c-priority-ai-reason-and-review.png`。

它证明模型识别“紧急”和“可选”的冲突，先给出中优先级和理由，再让用户选择，最后在审批页同时展示模型依据和人工结果。`S06d`、`S06e`、`S06f` 是审批理由、确认控件和菜单的补充图。

## 02 人员别称归一

主线：`H02a-alias-skill-snapshot.png` → `H02b-alias-resolved-owner.png`。

用户用 Markdown 写“老张、张哥和小张都指张三”，模型将纪要中的“老张”归一为张三，审批页不再重复询问负责人。`S07`、`S08b` 可作为 Skill 编辑器和运行快照补充。

## 03 人员与任务关系不明确

主线：`H03a-ambiguous-owner-question.png` → `H03b-ambiguous-owner-open-item.png` → `H03c-owner-answer-before-submit.png` → `H03d-owner-confirmed-in-approval.png`。

纪要只说“研发团队”时，系统不把团队名冒充具体负责人；负责人问题进入当前待处理事项，用户回答李四后，同一任务更新并进入审批。

## 04 澄清生命周期

`S02-clarification-workspace.png`、`S03d-open-items-unobstructed.png`、`S05-resolved-open-items.png` 共同展示澄清前、当前问题和回答后归档。它们是一个生命周期，不是三个独立功能。

## 05 任务状态生命周期

`S12-local-task-hub-readback.png`、`S13b-tracking-in-progress.png`、`S13d-completed-local-tasks.png`、`S13e-completion-activity.png` 展示创建回读、进行中和完成闭环。状态图属于同一任务追踪能力，正文选一张主图，其余放附录。

## 06 Agent 对话与二次确认

`S09-progress-query-conversation.png` 展示进度查询，`S10-status-change-proposal.png` 和 `S10b-status-confirmed-activity.png` 展示状态变更先提案后确认，`S11a` 到 `S11c` 展示不完整日期追问、字段修改提案和确认结果。

## 07 检查器与非黑盒输入

`S08a`、`S08b`、`S08d`、`S08e`、`S08h`、`S08i` 分别覆盖纪要原文、用户 Skill 快照、结构化输出、对话调用、模型输入上下文和原始输出。正文选 `S08a` 或 `S08h`，长 JSON 放报告附录。

## 08 响应式界面

`S15g`、`S15h`、`S15k`、`S15l` 证明 390px 和 320px 下审批、优先级和完成态仍可读。它们是视觉验收附录，不需要拆成多个产品亮点。

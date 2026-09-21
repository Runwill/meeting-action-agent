import { ArrowRight, CaretDown, Check } from "@phosphor-icons/react";
import { useId, useState } from "react";
import type { ActionTask, Priority } from "../types";
import { SelectField } from "./SelectField";

type ApprovalTaskListProps = {
  tasks: ActionTask[];
  selectedTaskIds: string[];
  busy: boolean;
  onTasksChange: (tasks: ActionTask[]) => void;
  onSelectionChange: (ids: string[]) => void;
  onApprove: () => void;
};

type TaskEditorProps = {
  task: ActionTask;
  index: number;
  selected: boolean;
  expanded: boolean;
  onSelect: (selected: boolean) => void;
  onChange: (patch: Partial<ActionTask>) => void;
  onExpand: () => void;
};

export function TaskEditor({ task, index, selected, expanded, onSelect, onChange, onExpand }: TaskEditorProps) {
  const editorId = useId();
  const titleId = `${editorId}-title`;
  const titleHintId = `${editorId}-title-hint`;
  const titleErrorId = `${editorId}-title-error`;
  const ownerId = `${editorId}-owner`;
  const ownerErrorId = `${editorId}-owner-error`;
  const dueDateId = `${editorId}-due-date`;
  const dueDateErrorId = `${editorId}-due-date-error`;
  const detailId = `${editorId}-detail`;
  const titleMissing = selected && !task.title.trim();
  const ownerMissing = selected && !task.owner?.trim();
  const dueDateMissing = selected && !task.due_date;

  return (
    <article className={`approval-task liquid-glass priority-${task.priority} ${selected ? "is-selected" : ""}`}>
      <div className="approval-task-main">
        <label className="selection-control" title={selected ? "取消创建此任务" : "选择创建此任务"}>
          <input type="checkbox" checked={selected} onChange={(event) => onSelect(event.target.checked)} />
          <span aria-hidden="true"><Check weight="bold" /></span>
          <span className="visually-hidden">{selected ? "取消创建" : "选择创建"}任务 {index + 1}</span>
        </label>
        <span className="task-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div className="task-body">
          <label className="task-title-label" htmlFor={titleId}>任务标题</label>
          <textarea
            id={titleId}
            className="task-title"
            rows={2}
            value={task.title}
            required={selected}
            aria-invalid={titleMissing}
            aria-describedby={`${titleHintId}${titleMissing ? ` ${titleErrorId}` : ""}`}
            onChange={(event) => onChange({ title: event.target.value })}
          />
          <span className="visually-hidden" id={titleHintId}>任务标题支持多行文本。</span>
          {titleMissing && <small id={titleErrorId} role="alert">请输入任务标题。</small>}
          <div className="task-fields approval-fields">
            <label htmlFor={ownerId}><span>负责人</span><input id={ownerId} value={task.owner ?? ""} required={selected} aria-invalid={ownerMissing} aria-describedby={ownerMissing ? ownerErrorId : undefined} onChange={(event) => onChange({ owner: event.target.value || null })} placeholder="待确认" />{ownerMissing && <small id={ownerErrorId} role="alert">请输入负责人。</small>}</label>
            <label htmlFor={dueDateId}><span>截止日期</span><input id={dueDateId} type="date" value={task.due_date ?? ""} required={selected} aria-invalid={dueDateMissing} aria-describedby={dueDateMissing ? dueDateErrorId : undefined} onChange={(event) => onChange({ due_date: event.target.value || null })} />{dueDateMissing && <small id={dueDateErrorId} role="alert">请选择截止日期。</small>}</label>
            <div className="app-select-field"><span id={`${editorId}-priority`}>优先级</span><SelectField value={task.priority} labelledBy={`${editorId}-priority`} options={[{ value: "high", label: "高" }, { value: "medium", label: "中" }, { value: "low", label: "低" }]} onValueChange={(value) => { const priority = value as Priority; onChange({ priority, priority_reason: `用户在审批中将优先级调整为${priority === "high" ? "高" : priority === "low" ? "低" : "中"}优先级。`, priority_evidence: null, priority_conflict: false }); }} /></div>
          </div>
          <div className="priority-explanation">
            <span>判断依据</span>
            <p>{task.priority_reason || "当前没有单独的优先级说明，可在批准前调整。"}</p>
            {task.priority_evidence && <blockquote>{task.priority_evidence}</blockquote>}
          </div>
        </div>
        <button className="expand-button" type="button" onClick={onExpand} aria-expanded={expanded} aria-controls={detailId} aria-label={`${expanded ? "收起" : "展开"}任务 ${index + 1} 详情`} title={expanded ? "收起详情" : "展开详情"}><CaretDown /></button>
      </div>
      {expanded && (
        <div className="task-detail approval-detail" id={detailId}>
          <label><span>交付说明</span><textarea value={task.description} onChange={(event) => onChange({ description: event.target.value })} rows={3} /></label>
          <div className="evidence"><span>原文证据</span><blockquote>{task.evidence || "人工补充，无原文证据。"}</blockquote></div>
          {(task.risk || task.dependencies.length > 0) && <dl className="task-context"><div><dt>风险</dt><dd>{task.risk || "无"}</dd></div><div><dt>依赖</dt><dd>{task.dependencies.join("、") || "无"}</dd></div></dl>}
          <footer><span>置信度 {Math.round(task.confidence * 100)}%</span><span>不创建此任务时，请取消左侧勾选。</span></footer>
        </div>
      )}
    </article>
  );
}

export function ApprovalTaskList({ tasks, selectedTaskIds, busy, onTasksChange, onSelectionChange, onApprove }: ApprovalTaskListProps) {
  const [expandedId, setExpandedId] = useState<string | null>(tasks[0]?.id ?? null);
  const selected = new Set(selectedTaskIds);
  const allSelected = tasks.length > 0 && selectedTaskIds.length === tasks.length;
  const incompleteSelected = tasks.filter((task) => selected.has(task.id) && (!task.title.trim() || !task.owner?.trim() || !task.due_date));

  const updateTask = (id: string, patch: Partial<ActionTask>) => {
    onTasksChange(tasks.map((task) => task.id === id ? { ...task, ...patch } : task));
  };
  return (
    <section className="agent-panel approval-panel" aria-labelledby="approval-title">
      <header className="agent-panel-head approval-head">
        <div>
          <p className="section-label">HUMAN APPROVAL</p>
          <h3 id="approval-title">确认要创建的行动项</h3>
        </div>
        <label className="select-all-control">
          <input type="checkbox" checked={allSelected} onChange={(event) => onSelectionChange(event.target.checked ? tasks.map((task) => task.id) : [])} />
          <span>全选 {tasks.length} 项</span>
        </label>
      </header>
      <p className="panel-intro">检查负责人、日期和优先级。只有点击底部批准按钮后，任务才会写入本地任务中心。</p>
      <div className="approval-task-list">
        {tasks.map((task, index) => (
          <TaskEditor
            key={task.id}
            task={task}
            index={index}
            selected={selected.has(task.id)}
            expanded={expandedId === task.id}
            onSelect={(checked) => onSelectionChange(checked ? [...selectedTaskIds, task.id] : selectedTaskIds.filter((id) => id !== task.id))}
            onChange={(patch) => updateTask(task.id, patch)}
            onExpand={() => setExpandedId(expandedId === task.id ? null : task.id)}
          />
        ))}
      </div>
      <footer className="agent-panel-actions approval-actions">
        <p id="approval-safety-note">{incompleteSelected.length ? `仍有 ${incompleteSelected.length} 个已选任务缺少标题、负责人或截止日期。` : `已选择 ${selectedTaskIds.length} 项。未选任务不会创建。`}</p>
        <button className="primary-action" type="button" disabled={busy || selectedTaskIds.length === 0 || incompleteSelected.length > 0} onClick={onApprove} aria-describedby="approval-safety-note">
          {busy ? "正在创建并回读…" : `批准并创建 ${selectedTaskIds.length} 项`}
          <ArrowRight aria-hidden="true" />
        </button>
      </footer>
    </section>
  );
}

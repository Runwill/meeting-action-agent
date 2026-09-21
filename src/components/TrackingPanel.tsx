import { ArrowsClockwise, CheckCircle, WarningCircle } from "@phosphor-icons/react";
import type { AgentState, CreatedTaskRecord, TaskStatus, TrackingSummary } from "../types";
import { SelectField } from "./SelectField";

type TrackingPanelProps = {
  state: AgentState;
  tasks: CreatedTaskRecord[];
  tracking: TrackingSummary | null;
  busy: boolean;
  /** External task currently being updated. A non-null value locks every tracking mutation. */
  statusBusyId: string | null;
  onRefresh: () => void;
  onStatusChange: (externalId: string, status: TaskStatus) => void;
};

const statusText: Record<TaskStatus, string> = { todo: "待开始", in_progress: "进行中", done: "已完成" };
const priorityText = { high: "高", medium: "中", low: "低" } as const;

export function TrackingPanel({ state, tasks, tracking, busy, statusBusyId, onRefresh, onStatusChange }: TrackingPanelProps) {
  const statusUpdateInProgress = statusBusyId !== null;
  const controlsBusy = busy || statusUpdateInProgress;
  const terminal = state === "completed" || state === "failed";

  return (
    <section className="agent-panel tracking-panel" aria-labelledby="tracking-title" aria-busy={controlsBusy}>
      <header className="agent-panel-head tracking-head">
        <div>
          <p className="section-label">LOCAL TASK HUB</p>
          <h3 id="tracking-title">{state === "completed" ? "本次行动已闭环" : state === "failed" ? "任务追踪已暂停" : "任务正在持续追踪"}</h3>
        </div>
        <button className="secondary-action" type="button" onClick={() => { if (!controlsBusy && !terminal) onRefresh(); }} disabled={controlsBusy || terminal}>
          <ArrowsClockwise className={controlsBusy ? "is-spinning" : ""} />
          {busy ? "刷新中" : statusUpdateInProgress ? "更新中" : "刷新状态"}
        </button>
      </header>
      {state === "failed" && <p className="error-message" role="alert">运行已失败，任务状态更新已停用；请查看执行记录确认原因。</p>}
      {tracking && (
        <div className="tracking-stats" aria-label="追踪统计">
          <div><strong>{tracking.total}</strong><span>全部</span></div>
          <div><strong>{tracking.todo}</strong><span>待开始</span></div>
          <div><strong>{tracking.in_progress}</strong><span>进行中</span></div>
          <div><strong>{tracking.done}</strong><span>已完成</span></div>
          <div className={tracking.overdue ? "has-overdue" : ""}><strong>{tracking.overdue}</strong><span>已逾期</span></div>
        </div>
      )}
      <div className="created-task-list">
        {tasks.map((task, index) => (
          <article className="created-task liquid-glass" key={task.external_id}>
            <span className="task-number" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
            <div className="created-task-body">
              <div className="created-task-title">
                <h4>{task.title}</h4>
                <div className="created-task-badges">
                  {task.reused && <span className="verification-badge is-reused">幂等复用</span>}
                  <span className={task.verified ? "verification-badge is-verified" : "verification-badge is-error"}>
                    {task.verified ? <CheckCircle weight="fill" /> : <WarningCircle weight="fill" />}
                    {task.verified ? "回读一致" : "验证异常"}
                  </span>
                </div>
              </div>
              <dl>
                <div><dt>外部 ID</dt><dd><code>{task.external_id}</code></dd></div>
                <div><dt>负责人</dt><dd>{task.owner || "待定"}</dd></div>
                <div><dt>截止日期</dt><dd>{task.due_date || "待定"}</dd></div>
                <div><dt>优先级</dt><dd>{priorityText[task.priority]}</dd></div>
              </dl>
              {task.description && <details className="created-task-description"><summary>任务说明</summary><p>{task.description}</p></details>}
              {task.issues.length > 0 && <ul className="verification-issues">{task.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
            </div>
            <div className="tracking-status">
              <span id={`tracking-status-${index}`}>任务状态</span>
              <SelectField
                value={task.status}
                options={Object.entries(statusText).map(([value, label]) => ({ value, label }))}
                labelledBy={`tracking-status-${index}`}
                disabled={terminal || controlsBusy}
                onValueChange={(value) => { if (!controlsBusy && !terminal) onStatusChange(task.external_id, value as TaskStatus); }}
              />
            </div>
          </article>
        ))}
      </div>
      {tracking && <p className="tracking-checked">最近刷新：<time dateTime={tracking.checked_at}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(tracking.checked_at))}</time></p>}
    </section>
  );
}

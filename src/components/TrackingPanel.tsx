import { ArrowSquareOut, ArrowsClockwise, CheckCircle, Copy, WarningCircle } from "@phosphor-icons/react";
import type { AgentState, CreatedTaskRecord, TaskStatus, TrackingSummary } from "../types";
import { SelectField } from "./SelectField";

type TrackingPanelProps = {
  state: AgentState;
  tasks: CreatedTaskRecord[];
  tracking: TrackingSummary | null;
  busy: boolean;
  refreshing: boolean;
  connectorName: string;
  supportsStatusUpdate: boolean;
  statusOptions: TaskStatus[];
  /** External task currently being updated. A non-null value locks every tracking mutation. */
  statusBusyId: string | null;
  onRefresh: () => void;
  onStatusChange: (externalId: string, status: TaskStatus) => void;
  onOpenPlatformConnection?: () => void;
  feishuPermissionUrl?: string;
};

const statusText: Record<TaskStatus, string> = { todo: "待开始", in_progress: "进行中", done: "已完成" };
const priorityText = { high: "高", medium: "中", low: "低" } as const;

function copyText(value: string) {
  void navigator.clipboard?.writeText(value);
}

function hasFeishuCommentPermissionIssue(task: CreatedTaskRecord) {
  return task.connector_id === "feishu" && task.issues.some((issue) => /飞书评论同步失败|task:comment:write|task:comment:read/i.test(issue));
}

export function TrackingPanel({ state, tasks, tracking, busy, refreshing, connectorName, supportsStatusUpdate, statusOptions, statusBusyId, onRefresh, onStatusChange, onOpenPlatformConnection, feishuPermissionUrl }: TrackingPanelProps) {
  const statusUpdateInProgress = statusBusyId !== null;
  const controlsBusy = busy || statusUpdateInProgress;
  const terminal = state === "completed" || state === "failed";
  const statusControlsDisabled = terminal || controlsBusy || !supportsStatusUpdate;

  return (
    <section className="agent-panel tracking-panel" aria-labelledby="tracking-title" aria-busy={controlsBusy}>
      <header className="agent-panel-head tracking-head">
        <div>
          <p className="section-label">{connectorName.toUpperCase()}</p>
          <h3 id="tracking-title">{state === "completed" ? "本次行动已闭环" : state === "failed" ? "任务追踪已暂停" : "任务正在持续追踪"}</h3>
        </div>
        <button className="secondary-action" type="button" onClick={() => { if (!controlsBusy && !terminal) onRefresh(); }} disabled={controlsBusy || terminal}>
          <ArrowsClockwise className={refreshing || statusUpdateInProgress ? "is-spinning" : ""} />
          {refreshing ? "刷新中" : statusUpdateInProgress ? "更新中" : "刷新状态"}
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
                <div><dt>目标平台</dt><dd>{task.connector_name}</dd></div>
                <div><dt>外部 ID</dt><dd><code>{task.external_id}</code></dd></div>
                <div><dt>负责人</dt><dd>{task.owner || "待定"}</dd></div>
                <div><dt>截止日期</dt><dd>{task.due_date || "待定"}</dd></div>
                <div><dt>优先级</dt><dd>{priorityText[task.priority]}</dd></div>
              </dl>
              <div className="created-task-actions" aria-label={`${task.title} 的平台定位操作`}>
                {task.external_url && (
                  <a className="task-link-action" href={task.external_url} target="_blank" rel="noreferrer">
                    <ArrowSquareOut aria-hidden="true" />
                    打开{task.connector_id === "feishu" ? "飞书" : "任务"}
                  </a>
                )}
                <button className="task-link-action" type="button" onClick={() => copyText(task.title)}>
                  <Copy aria-hidden="true" />
                  复制标题
                </button>
                <button className="task-link-action" type="button" onClick={() => copyText(task.external_id)}>
                  <Copy aria-hidden="true" />
                  复制 ID
                </button>
              </div>
              {task.description && <details className="created-task-description"><summary>任务说明</summary><p>{task.description}</p></details>}
              {task.issues.length > 0 && <ul className="verification-issues">{task.issues.map((issue) => <li key={issue}>{issue}</li>)}</ul>}
              {hasFeishuCommentPermissionIssue(task) && (
                <div className="task-permission-callout" role="alert">
                  <div>
                    <WarningCircle weight="fill" />
                    <div>
                      <strong>评论权限还没配好</strong>
                      <p>主任务创建、回读和状态同步已经保留；只有“操作记录写入飞书评论”失败。请在飞书开放平台给当前应用开通 <code>task:comment:write</code>，如需读取评论核验再开通 <code>task:comment:read</code>，发布后重新复测。</p>
                    </div>
                  </div>
                  <div className="task-permission-actions">
                    {feishuPermissionUrl && (
                      <a href={feishuPermissionUrl} target="_blank" rel="noreferrer">
                        <ArrowSquareOut aria-hidden="true" />
                        打开权限管理
                      </a>
                    )}
                    {onOpenPlatformConnection && <button type="button" onClick={onOpenPlatformConnection}>打开平台连接</button>}
                  </div>
                </div>
              )}
            </div>
            <div className="tracking-status">
              <span id={`tracking-status-${index}`}>任务状态</span>
              <SelectField
                value={task.status}
                options={[...new Set([...statusOptions, task.status])]
                  .map((value) => ({ value, label: statusText[value] }))}
                labelledBy={`tracking-status-${index}`}
                disabled={statusControlsDisabled}
                onValueChange={(value) => { if (!statusControlsDisabled) onStatusChange(task.external_id, value as TaskStatus); }}
              />
              {!supportsStatusUpdate && <small className="tracking-platform-note">{task.connector_name} 当前只验证创建和回读，状态同步待后续映射。</small>}
              {supportsStatusUpdate && task.connector_id === "feishu" && <small className="tracking-platform-note">飞书任务在本系统中显示为进行中 / 已完成；进行中对应飞书的未完成状态。</small>}
            </div>
          </article>
        ))}
      </div>
      {tracking && <p className="tracking-checked">最近刷新：<time dateTime={tracking.checked_at}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(tracking.checked_at))}</time></p>}
    </section>
  );
}

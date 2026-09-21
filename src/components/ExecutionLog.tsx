import { ChatCenteredText, CheckCircle, ClockCounterClockwise, WarningCircle, Wrench } from "@phosphor-icons/react";
import type { AgentEvent } from "../types";

type ExecutionLogProps = {
  events: AgentEvent[];
  live?: boolean;
};

function EventIcon({ type }: { type: AgentEvent["type"] }) {
  if (type === "error") return <WarningCircle weight="fill" />;
  if (type === "tool_call" || type === "tool_result") return <Wrench />;
  if (type === "verification" || type === "tracking" || type === "status_change") return <CheckCircle />;
  if (type === "question" || type === "answer") return <ChatCenteredText />;
  return <ClockCounterClockwise />;
}

const actorText = {
  user: "用户",
  agent: "Agent",
  system: "系统",
  tool: "工具",
} as const;

function eventActor(event: AgentEvent) {
  if (event.actor) return actorText[event.actor];
  if (event.type === "answer" || event.type === "approval" || event.type === "status_change") return "用户";
  if (event.type === "tool_call" || event.type === "tool_result") return "工具";
  if (event.type === "overdue" || event.type === "tracking") return "系统";
  return "Agent";
}

const statusText: Record<string, string> = {
  todo: "待开始",
  in_progress: "进行中",
  done: "已完成",
};

function ChangeSummary({ event }: { event: AgentEvent }) {
  const before = event.before?.status;
  const after = event.after?.status;
  if (typeof before !== "string" || typeof after !== "string") return null;
  return <span className="event-change"><b>{statusText[before] ?? before}</b><i>→</i><b>{statusText[after] ?? after}</b></span>;
}

export function ExecutionLog({ events, live = false }: ExecutionLogProps) {
  const items = [...events].reverse();
  const recent = items.slice(0, 6);
  const older = items.slice(6);
  if (!items.length && !live) return null;

  function renderItem(event: AgentEvent) {
    return (
      <li className={event.type === "error" ? "is-error" : ""} key={event.id}>
        <span className="event-icon" aria-hidden="true"><EventIcon type={event.type} /></span>
        <div>
          <span className="event-source">{eventActor(event)}{event.source ? ` · ${event.source}` : ""}</span>
          <p>{event.message}</p>
          <ChangeSummary event={event} />
          <time dateTime={event.at}>{new Intl.DateTimeFormat("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(event.at))}</time>
        </div>
      </li>
    );
  }

  return (
    <section className="execution-log" aria-labelledby="execution-log-title">
      <header>
        <div>
          <p className="section-label">ACTIVITY</p>
          <h3 id="execution-log-title">活动记录</h3>
        </div>
        {live && <span className="live-indicator"><i /> 正在执行</span>}
      </header>
      <ol role="log" aria-live={live ? "polite" : "off"}>
        {recent.map(renderItem)}
        {live && <li className="is-pending"><span className="event-icon" aria-hidden="true"><i className="loader" /></span><div><p>等待本地任务中心返回结果…</p></div></li>}
      </ol>
      {older.length > 0 && <details className="older-events"><summary>查看更早的 {older.length} 条记录</summary><ol>{older.map(renderItem)}</ol></details>}
    </section>
  );
}

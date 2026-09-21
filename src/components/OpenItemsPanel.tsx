import { CheckCircle, Circle, ClockCounterClockwise } from "@phosphor-icons/react";
import type { ActionTask, OpenItem } from "../types";

type OpenItemsPanelProps = {
  items: OpenItem[];
  tasks: ActionTask[];
};

function taskTitle(item: OpenItem, tasks: ActionTask[]) {
  if (!item.task_id) return null;
  return tasks.find((task) => task.id === item.task_id)?.title ?? null;
}

function displayAnswer(answer: string | null) {
  if (!answer) return null;
  return ({ yes: "是", no: "否", high: "高优先级", medium: "中优先级", low: "低优先级" } as Record<string, string>)[answer] ?? answer;
}

export function OpenItemsPanel({ items, tasks }: OpenItemsPanelProps) {
  const open = items.filter((item) => item.status === "open");
  const closed = items.filter((item) => item.status !== "open");

  return (
    <section className="open-items-panel" aria-labelledby="open-items-title">
      <header className="context-panel-head">
        <div>
          <p className="section-label">OPEN ITEMS</p>
          <h3 id="open-items-title">当前待处理</h3>
        </div>
        <strong aria-label={`${open.length} 项未解决`}>{String(open.length).padStart(2, "0")}</strong>
      </header>
      {open.length ? (
        <ol className="open-item-list">
          {open.map((item) => {
            const title = taskTitle(item, tasks);
            return (
              <li key={item.id}>
                <Circle aria-hidden="true" />
                <div>{title && <small>{title}</small>}<p>{item.prompt}</p></div>
              </li>
            );
          })}
        </ol>
      ) : (
        <div className="open-items-empty"><CheckCircle weight="fill" /><p>当前没有待确认事项。</p></div>
      )}
      {closed.length > 0 && (
        <details className="resolved-items">
          <summary><ClockCounterClockwise /> 已处理 {closed.length} 项</summary>
          <ol>
            {closed.map((item) => (
              <li key={item.id}>
                <p>{item.prompt}</p>
                <span>{displayAnswer(item.answer) || (item.status === "dismissed" ? "已关闭" : "已解决")}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

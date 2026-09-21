import { ChatCentered } from "@phosphor-icons/react";
import type { ClarificationHistoryEntry } from "../types";

type ClarificationHistoryProps = {
  entries: ClarificationHistoryEntry[];
};

export function ClarificationHistory({ entries }: ClarificationHistoryProps) {
  if (!entries.length) return null;

  return (
    <details className="clarification-history">
      <summary><ChatCentered aria-hidden="true" /> 查看已确认的 {entries.length} 项澄清</summary>
      <dl>
        {entries.map((entry) => (
          <div key={entry.id}>
            <dt>{entry.prompt}</dt>
            <dd>{entry.input_type === "confirm" ? (/^(yes|y|true|是|确认|是任务|保留)$/i.test(entry.answer) ? "是" : "否") : entry.answer}</dd>
            {entry.outcome === "rejected_task" && <span>该内容已确认不是任务</span>}
          </div>
        ))}
      </dl>
    </details>
  );
}

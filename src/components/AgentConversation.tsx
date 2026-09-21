import { ArrowRight, CheckCircle, PaperPlaneRight, Robot, UserCircle, Wrench } from "@phosphor-icons/react";
import { useState } from "react";
import type { AgentRun, ConversationTurn, PendingAgentAction, TaskFieldChanges } from "../types";

type AgentConversationProps = {
  run: AgentRun;
  busy: boolean;
  onSend: (content: string) => Promise<boolean>;
  onConfirm: (actionId: string, approved: boolean) => void;
};

const roleLabel: Record<ConversationTurn["role"], string> = {
  user: "你",
  assistant: "Agent",
  tool: "工具",
};

function TurnIcon({ role }: { role: ConversationTurn["role"] }) {
  if (role === "user") return <UserCircle weight="duotone" />;
  if (role === "tool") return <Wrench />;
  return <Robot weight="duotone" />;
}

function TurnContent({ turn }: { turn: ConversationTurn }) {
  if (turn.kind === "meeting_submission") {
    return (
      <details className="conversation-source">
        <summary>已提交会议纪要 <span>查看原文</span></summary>
        <p>{turn.content}</p>
      </details>
    );
  }

  if (turn.kind === "clarification") {
    const [prompt, ...answer] = turn.content.split("\n");
    const rawAnswer = answer.join("\n");
    const displayAnswer = ({ yes: "是", no: "否", high: "高优先级", medium: "中优先级", low: "低优先级" } as Record<string, string>)[rawAnswer] ?? rawAnswer;
    return (
      <div className="conversation-clarification">
        <p>{prompt}</p>
        <strong>{displayAnswer || "已确认"}</strong>
      </div>
    );
  }

  return <p>{turn.content}</p>;
}

function legacyTurns(run: AgentRun): ConversationTurn[] {
  const persisted = run.conversation ?? [];
  const knownClarifications = new Set(persisted.filter((turn) => turn.kind === "clarification").map((turn) => turn.open_item_id));
  const missingSource: ConversationTurn[] = persisted.some((turn) => turn.kind === "meeting_submission") ? [] : [{
    id: `${run.id}-legacy-submission`,
    role: "user",
    kind: "meeting_submission",
    content: run.original_notes,
    at: run.created_at,
  }];
  const missingClarifications: ConversationTurn[] = (run.clarification_history ?? [])
    .filter((entry) => !knownClarifications.has(entry.question_id))
    .map((entry) => ({
      id: `${entry.id}-legacy-turn`,
      role: "user",
      kind: "clarification",
      content: `${entry.prompt}\n${entry.answer}`,
      at: entry.at,
      open_item_id: entry.question_id,
      task_id: entry.task_id,
    }));
  const initialReport: ConversationTurn[] = persisted.length ? [] : [{
    id: `${run.id}-legacy-report`,
    role: "assistant",
    kind: "agent_report",
    content: run.questions.length
      ? `已识别 ${run.analysis.tasks.length} 个行动项，还有 ${run.questions.length} 项信息需要确认。`
      : `已识别 ${run.analysis.tasks.length} 个行动项，当前流程状态为“${run.state}”。`,
    at: run.created_at,
  }];
  return [...missingSource, ...initialReport, ...missingClarifications, ...persisted]
    .sort((a, b) => a.at.localeCompare(b.at));
}

function pendingActionDetails(run: AgentRun, pending: PendingAgentAction) {
  const statusLabels = { todo: "待开始", in_progress: "进行中", done: "已完成" } as const;
  if (pending.type === "set_task_status") {
    const task = run.created_tasks.find((item) => item.external_id === pending.external_task_id);
    return { title: task?.title || pending.external_task_id, changes: [{ label: "状态", before: statusLabels[pending.expected_status], after: statusLabels[pending.status] }] };
  }

  const task = run.analysis.tasks.find((item) => item.id === pending.task_id);
  const labels: Record<keyof TaskFieldChanges, string> = { title: "标题", description: "描述", owner: "负责人", due_date: "截止日期", priority: "优先级" };
  const fields = Object.keys(pending.changes) as Array<keyof TaskFieldChanges>;
  const display = (field: keyof TaskFieldChanges, value: string | null | undefined) => field === "priority" && value
    ? ({ high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value : value || "未填写";
  const changes = fields.map((field) => ({ label: labels[field], before: display(field, pending.expected[field]), after: display(field, pending.changes[field]) }));
  return { title: task?.title || pending.task_id, changes };
}

export function AgentConversation({ run, busy, onSend, onConfirm }: AgentConversationProps) {
  const turns = legacyTurns(run);
  const [draft, setDraft] = useState("");

  async function submit() {
    const content = draft.trim();
    if (!content || busy || run.pending_action) return;
    if (await onSend(content)) setDraft("");
  }

  const pending = run.pending_action;
  const pendingDetails = pending ? pendingActionDetails(run, pending) : null;

  return (
    <section className="agent-conversation" aria-labelledby="conversation-title">
      <header className="workspace-section-head">
        <div>
          <p className="section-label">CONVERSATION</p>
          <h3 id="conversation-title">与 Agent 的工作记录</h3>
        </div>
        <span className="conversation-state"><i /> 运行中上下文</span>
      </header>
      <div className="conversation-list" role="log" aria-live="polite">
        {turns.map((turn) => (
          <article className={`conversation-turn is-${turn.role}`} key={turn.id}>
            <span className="conversation-avatar" aria-hidden="true"><TurnIcon role={turn.role} /></span>
            <div className="conversation-turn-body">
              <header>
                <strong>{roleLabel[turn.role]}</strong>
                {turn.role === "assistant" && <span><CheckCircle weight="fill" /> 已记录</span>}
                <time dateTime={turn.at}>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(turn.at))}</time>
              </header>
              <TurnContent turn={turn} />
            </div>
          </article>
        ))}
      </div>
      {pending && (
        <div className="conversation-approval" role="group" aria-label="待确认的 Agent 操作">
          <div className="conversation-approval-copy">
            <span>待确认修改</span>
            <h4>{pendingDetails?.title}</h4>
            <dl>{pendingDetails?.changes.map((change) => (
              <div key={change.label}><dt>{change.label}</dt><dd><span>{change.before}</span><ArrowRight aria-hidden="true" /><strong>{change.after}</strong></dd></div>
            ))}</dl>
            <p>确认后执行并回读；取消不会修改任务。</p>
          </div>
          <div className="conversation-approval-actions">
            <button type="button" onClick={() => onConfirm(pending.id, false)} disabled={busy}>取消</button>
            <button type="button" className="confirm-action" onClick={() => onConfirm(pending.id, true)} disabled={busy}>确认执行</button>
          </div>
        </div>
      )}
      <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <label htmlFor="agent-message">给 Agent 发消息</label>
        <div>
          <textarea id="agent-message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} disabled={busy || !!pending} maxLength={2000} rows={2} placeholder={pending ? "请先确认或取消待执行操作" : "补充会议信息、询问进度或说明任务状态…"} />
          <button type="submit" disabled={busy || !!pending || !draft.trim()} aria-label="发送消息" title="发送消息"><PaperPlaneRight weight="fill" /></button>
        </div>
      </form>
    </section>
  );
}

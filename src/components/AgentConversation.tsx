import { ArrowDown, ArrowRight, CheckCircle, PaperPlaneRight, Robot, UserCircle, Wrench } from "@phosphor-icons/react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { AgentRun, ConversationTurn, PendingAgentAction, TaskFieldChanges } from "../types";

type AgentConversationProps = {
  run: AgentRun;
  busy: boolean;
  error?: string;
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

function turnSourceLabel(turn: ConversationTurn) {
  if (turn.role !== "assistant") return null;
  const source = turn.metadata?.agent_source;
  const modelCalled = turn.metadata?.model_called;
  if (source === "platform_tool_with_model") return "平台事实 + 模型回答";
  if (source === "model_understanding" && typeof turn.metadata?.tool === "string" && turn.metadata.tool.includes("Platform")) return "模型理解 + 平台配置确认";
  if (source === "system_config") return modelCalled ? "系统配置读取 + 模型回答" : "系统配置读取 · 未调用模型";
  if (source === "platform_setting_proposal") return "配置变更提案 · 未调用模型";
  if (source === "platform_tool") return modelCalled === false ? "平台工具执行 · 未调用模型" : "平台工具执行";
  if (source === "model_understanding") return modelCalled === false ? "模型规划结果" : "模型理解";
  return "已记录";
}

function formatModelDuration(milliseconds: number) {
  if (milliseconds < 1000) return `${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return `${(milliseconds / 1000).toFixed(1)}s`;
  return `${Math.round(milliseconds / 1000)}s`;
}

function turnModelStats(turn: ConversationTurn) {
  if (turn.role !== "assistant" || !turn.metadata?.model_called) return null;
  const count = typeof turn.metadata.model_call_count === "number" ? turn.metadata.model_call_count : null;
  const duration = typeof turn.metadata.model_duration_ms === "number" ? turn.metadata.model_duration_ms : null;
  if (!count && duration === null) return null;
  const countLabel = count ? `模型 ${count} 次` : "模型调用";
  return duration === null ? countLabel : `${countLabel} · ${formatModelDuration(duration)}`;
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

function formatReminderMinutes(values: number[] | undefined) {
  if (!values?.length) return "未启用";
  return values.map((value) => {
    if (value === 0) return "截止时提醒";
    if (value % 1440 === 0) return `提前 ${value / 1440} 天`;
    if (value % 60 === 0) return `提前 ${value / 60} 小时`;
    return `提前 ${value} 分钟`;
  }).join("、");
}

function pendingActionDetails(run: AgentRun, pending: PendingAgentAction) {
  const statusLabels = { todo: "待开始", in_progress: "进行中", done: "已完成" } as const;
  if (pending.type === "set_task_status") {
    const task = run.created_tasks.find((item) => item.external_id === pending.external_task_id);
    return { title: task?.title || pending.external_task_id, note: "确认后执行并回读；取消不会修改任务。", changes: [{ label: "状态", before: statusLabels[pending.expected_status], after: statusLabels[pending.status] }] };
  }

  if (pending.type === "update_feishu_settings") {
    const settingLabels = {
      syncComments: "操作记录写入评论",
      dueReminderMinutes: "新建任务提醒",
      tasklistGuid: "飞书清单",
      tasklistSectionGuid: "清单分组",
    } as const;
    const display = (field: keyof typeof settingLabels, value: boolean | number[] | string | null | undefined) => {
      if (field === "syncComments") return value ? "已启用" : "未启用";
      if (field === "dueReminderMinutes") return formatReminderMinutes(Array.isArray(value) ? value : []);
      return value || "未设置";
    };
    const fields = Object.keys(pending.changes) as Array<keyof typeof settingLabels>;
    const syncExistingTaskNote = "dueReminderMinutes" in pending.changes && run.connector_id === "feishu" && run.created_tasks.some((task) => task.verified)
      ? "确认后保存到本机平台连接配置，并尝试把本次运行已创建的飞书任务提醒同步为新规则；取消不会改变飞书写入设置。"
      : "确认后保存到本机平台连接配置；取消不会改变飞书写入设置。";
    return {
      title: "飞书任务写入设置",
      note: pending.queued_summary
        ? `${syncExistingTaskNote} 确认后我会继续处理：${pending.queued_summary}。`
        : syncExistingTaskNote,
      changes: fields.map((field) => ({
        label: settingLabels[field],
        before: display(field, pending.expected[field]),
        after: display(field, pending.changes[field]),
      })),
    };
  }

  if (pending.type === "sync_task_reminders") {
    const task = run.created_tasks.find((item) => item.external_id === pending.external_task_id)
      || run.created_tasks.find((item) => item.task_id === pending.task_id);
    return {
      title: task?.title || pending.external_task_id,
      note: "确认后只同步这个飞书任务的到期提醒；不会改变平台连接里的新建任务提醒规则。",
      changes: [{
        label: "到期提醒",
        before: "读取飞书当前提醒",
        after: formatReminderMinutes(pending.dueReminderMinutes),
      }],
    };
  }

  if (pending.type === "add_task_comment") {
    const task = run.created_tasks.find((item) => item.external_id === pending.external_task_id)
      || run.created_tasks.find((item) => item.task_id === pending.task_id);
    return {
      title: task?.title || pending.external_task_id,
      note: "确认后会把这条内容写入外部任务评论区；取消不会修改任务。",
      changes: [{
        label: "评论内容",
        before: "未写入",
        after: pending.comment,
      }],
    };
  }

  const task = run.analysis.tasks.find((item) => item.id === pending.task_id);
  const labels: Record<keyof TaskFieldChanges, string> = { title: "标题", description: "描述", owner: "负责人", due_date: "截止日期", priority: "优先级" };
  const fields = Object.keys(pending.changes) as Array<keyof TaskFieldChanges>;
  const display = (field: keyof TaskFieldChanges, value: string | null | undefined) => field === "priority" && value
    ? ({ high: "高", medium: "中", low: "低" } as Record<string, string>)[value] || value : value || "未填写";
  const changes = fields.map((field) => ({ label: labels[field], before: display(field, pending.expected[field]), after: display(field, pending.changes[field]) }));
  return { title: task?.title || pending.task_id, note: "确认后执行并回读；取消不会修改任务。", changes };
}

export function AgentConversation({ run, busy, error, onSend, onConfirm }: AgentConversationProps) {
  const turns = legacyTurns(run);
  const [draft, setDraft] = useState("");
  const [awayFromBottom, setAwayFromBottom] = useState(false);
  const [unreadReplies, setUnreadReplies] = useState(0);
  const [recentReply, setRecentReply] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  const nearBottomRef = useRef(true);
  const previousTurnsRef = useRef<{ runId: string; ids: Set<string> } | null>(null);
  const replyTimerRef = useRef<number | null>(null);

  useEffect(() => () => {
    if (replyTimerRef.current !== null) window.clearTimeout(replyTimerRef.current);
  }, []);

  useLayoutEffect(() => {
    const list = listRef.current;
    const previous = previousTurnsRef.current;
    previousTurnsRef.current = { runId: run.id, ids: new Set(turns.map((turn) => turn.id)) };
    if (!list) return;

    if (!previous || previous.runId !== run.id) {
      list.scrollTop = list.scrollHeight;
      nearBottomRef.current = true;
      setAwayFromBottom(false);
      setUnreadReplies(0);
      setRecentReply(false);
      if (replyTimerRef.current !== null) window.clearTimeout(replyTimerRef.current);
      return;
    }

    const newTurns = turns.filter((turn) => !previous.ids.has(turn.id));
    if (!newTurns.length) return;
    const replies = newTurns.filter((turn) => turn.role === "assistant").length;
    if (nearBottomRef.current) {
      list.scrollTop = list.scrollHeight;
    } else if (replies) {
      setUnreadReplies((count) => count + replies);
    }
    if (replies) {
      setRecentReply(true);
      if (replyTimerRef.current !== null) window.clearTimeout(replyTimerRef.current);
      replyTimerRef.current = window.setTimeout(() => setRecentReply(false), 5000);
    }
  }, [run.id, turns]);

  function handleScroll() {
    const list = listRef.current;
    if (!list) return;
    const nearBottom = list.scrollHeight - list.scrollTop - list.clientHeight <= 48;
    nearBottomRef.current = nearBottom;
    setAwayFromBottom(!nearBottom);
    if (nearBottom) setUnreadReplies(0);
  }

  function goToBottom() {
    const list = listRef.current;
    if (!list) return;
    list.scrollTo({
      top: list.scrollHeight,
      behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth",
    });
  }

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
        <span className={`conversation-state${recentReply ? " has-reply" : ""}`} role="status" aria-live="polite"><i /> {recentReply ? "Agent 已回复" : "运行中上下文"}</span>
      </header>
      <div className="conversation-scroll-region">
        <div className="conversation-list" ref={listRef} onScroll={handleScroll} role="log" aria-label="Agent 消息记录" aria-live="polite">
          {turns.map((turn) => (
            <article className={`conversation-turn is-${turn.role}`} key={turn.id}>
              <span className="conversation-avatar" aria-hidden="true"><TurnIcon role={turn.role} /></span>
              <div className="conversation-turn-body">
                <header>
                  <strong>{roleLabel[turn.role]}</strong>
                  {turn.role === "assistant" && <span className="turn-source" title={typeof turn.metadata?.source_detail === "string" ? turn.metadata.source_detail : undefined}><CheckCircle weight="fill" /> {turnSourceLabel(turn)}</span>}
                  {turnModelStats(turn) && <span className="turn-model-stats" title="本轮回复实际记录到的模型调用次数和总耗时">{turnModelStats(turn)}</span>}
                  <time dateTime={turn.at}>{new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(turn.at))}</time>
                </header>
                <TurnContent turn={turn} />
              </div>
            </article>
          ))}
        </div>
      </div>
      {pending && (
        <div className="conversation-approval" role="group" aria-label="待确认的 Agent 操作">
          <div className="conversation-approval-copy">
            <span>待确认修改</span>
            <h4>{pendingDetails?.title}</h4>
            <dl>{pendingDetails?.changes.map((change) => (
              <div key={change.label}><dt>{change.label}</dt><dd><span>{change.before}</span><ArrowRight aria-hidden="true" /><strong>{change.after}</strong></dd></div>
            ))}</dl>
            <p>{pendingDetails?.note}</p>
          </div>
          <div className="conversation-approval-actions">
            <button type="button" onClick={() => onConfirm(pending.id, false)} disabled={busy}>取消</button>
            <button type="button" className="confirm-action" onClick={() => onConfirm(pending.id, true)} disabled={busy}>确认执行</button>
          </div>
        </div>
      )}
      <form className="conversation-composer" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <div className="conversation-composer-head">
          <label htmlFor="agent-message">给 Agent 发消息</label>
          <button
            className={`conversation-jump${awayFromBottom ? " is-visible" : ""}${unreadReplies ? " has-unread" : ""}`}
            type="button"
            onClick={goToBottom}
            aria-label={unreadReplies ? `Agent 有 ${unreadReplies} 条新回复，回到底部` : "回到底部"}
            aria-hidden={!awayFromBottom}
            tabIndex={awayFromBottom ? 0 : -1}
          >
            {unreadReplies > 0 && <i className="conversation-jump-dot" aria-hidden="true" />}
            <span>{unreadReplies ? `${unreadReplies} 条新回复` : "回到底部"}</span>
            <ArrowDown aria-hidden="true" />
          </button>
        </div>
        <div>
          <textarea id="agent-message" value={draft} onChange={(event) => setDraft(event.target.value)} onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void submit(); } }} disabled={busy || !!pending} maxLength={2000} rows={2} placeholder={pending ? "请先确认或取消待执行操作" : "补充会议信息、询问进度或说明任务状态…"} />
          <button type="submit" disabled={busy || !!pending || !draft.trim()} aria-label="发送消息" title="发送消息"><PaperPlaneRight weight="fill" /></button>
        </div>
        {error && <p className="conversation-error" role="alert">{error}</p>}
      </form>
    </section>
  );
}

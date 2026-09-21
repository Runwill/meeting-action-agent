import { createHash, randomUUID } from "node:crypto";
import { z } from "zod";
import { analyzeMeeting, isValidDateOnly, TaskSchema, type AnalysisInput, type AnalysisResult } from "./analyze.ts";
import { localTaskConnector } from "./connectors/local-task.ts";
import { getPromptSkillVersions, promptSkillMetadata } from "./prompt-skills.ts";
import {
  getTeamContext,
  readAgentStore,
  updateAgentStore,
  type AgentAnalysis,
  type AgentEvent,
  type AgentQuestion,
  type AgentRun,
  type AgentTask,
  type ClarificationHistoryEntry,
  type ConversationTurn,
  type CreatedTaskRecord,
  type ExternalTask,
  type OpenItem,
  type TaskFieldChanges,
} from "./agent-store.ts";
import { legacyContextToSkill, listUserSkills } from "./user-skills.ts";

function rejectDuplicates(values: string[], context: z.RefinementCtx, path: (string | number)[], label: string) {
  if (new Set(values).size !== values.length) {
    context.addIssue({ code: z.ZodIssueCode.custom, message: `${label}不能重复。`, path });
  }
}

export const AgentTaskSchema = TaskSchema.extend({ id: z.string().uuid() }).strict();
export const ClarificationPayloadSchema = z.object({
  answers: z.array(z.object({
    questionId: z.string().uuid(),
    value: z.string().trim().min(1, "澄清答案不能为空。").max(500),
  }).strict()).min(1).max(100),
}).strict().superRefine((payload, context) => {
  rejectDuplicates(payload.answers.map((answer) => answer.questionId), context, ["answers"], "问题 ID");
});
export const ApprovalPayloadSchema = z.object({
  tasks: z.array(AgentTaskSchema).min(1).max(200),
  selectedTaskIds: z.array(z.string().uuid()).min(1).max(200),
}).strict().superRefine((payload, context) => {
  rejectDuplicates(payload.tasks.map((task) => task.id), context, ["tasks"], "任务 ID");
  rejectDuplicates(payload.selectedTaskIds, context, ["selectedTaskIds"], "已选任务 ID");
});
export const TaskStatusSchema = z.object({ status: z.enum(["todo", "in_progress", "done"]) }).strict();

export class AgentOperationError extends Error {
  constructor(message: string, public readonly status: 400 | 404 | 409 | 422 | 502 | 503 = 400) {
    super(message);
  }
}

type EventContext = Omit<Partial<AgentEvent>, "id" | "type" | "message" | "at" | "metadata">;

function event(type: AgentEvent["type"], message: string, metadata?: AgentEvent["metadata"], context: EventContext = {}): AgentEvent {
  return { id: randomUUID(), type, message, at: new Date().toISOString(), ...context, ...(metadata ? { metadata } : {}) };
}

function conversationTurn(
  role: ConversationTurn["role"],
  kind: ConversationTurn["kind"],
  content: string,
  details: Omit<Partial<ConversationTurn>, "id" | "role" | "kind" | "content" | "at"> = {},
): ConversationTurn {
  return { id: randomUUID(), role, kind, content, at: new Date().toISOString(), ...details };
}

function question(input: Omit<AgentQuestion, "id" | "answer" | "open_item_id">): AgentQuestion {
  const id = randomUUID();
  return { id, ...input, answer: null, open_item_id: id };
}

function generalQuestion(): AgentQuestion {
  return question({
    task_id: null,
    field: "general",
    prompt: "没有识别到明确行动项。请补充谁需要完成什么工作，以及期望时间。",
    input_type: "text",
  });
}

function buildQuestions(tasks: AgentTask[]): AgentQuestion[] {
  if (!tasks.length) return [generalQuestion()];
  const questions: AgentQuestion[] = [];
  for (const task of tasks) {
    if (!task.owner) questions.push(question({ task_id: task.id, field: "owner", prompt: `“${task.title}”由谁负责？`, input_type: "text" }));
    if (!task.due_date) questions.push(question({ task_id: task.id, field: "due_date", prompt: `“${task.title}”计划在什么日期前完成？`, input_type: "date" }));
    if (task.confidence < 0.7) questions.push(question({ task_id: task.id, field: "confirm", prompt: `请确认“${task.title}”是否应创建为正式任务。`, input_type: "confirm" }));
    if (task.priority_conflict) {
      questions.push(question({ task_id: task.id, field: "priority", prompt: `“${task.title}”命中了冲突的优先级规则，请选择最终优先级。`, input_type: "priority" }));
    } else if (task.priority === "high" && !task.priority_evidence) {
      questions.push(question({ task_id: task.id, field: "priority", prompt: `“${task.title}”缺少高优先级原文依据，是否仍保留高优先级？`, input_type: "confirm" }));
    }
  }
  return questions;
}

function openItemsFromQuestions(questions: AgentQuestion[], createdAt = new Date().toISOString()): OpenItem[] {
  return questions.map((item) => ({
    id: item.open_item_id || item.id,
    kind: "clarification",
    task_id: item.task_id,
    question_id: item.id,
    prompt: item.prompt,
    status: "open",
    answer: null,
    resolution: null,
    created_at: createdAt,
    resolved_at: null,
  }));
}

function syncOpenFollowUps(analysis: AgentAnalysis, openItems: OpenItem[]) {
  analysis.follow_ups = openItems.filter((item) => item.status === "open").map((item) => item.prompt);
}

function initialEvents(analysis: AgentAnalysis, questions: AgentQuestion[], skillVersions: AgentRun["skill_versions"]) {
  const events = [event(
    "analysis",
    `已识别 ${analysis.tasks.length} 个行动项，并使用版本化 Prompt Skill 完成字段完整性检查。`,
    { engine: analysis.engine, skill_versions: JSON.stringify(skillVersions) },
    { actor: "agent", source: "model", action: "analyze_meeting", entity_type: "run" },
  )];
  if (questions.length) events.push(event(
    "question",
    `发现 ${questions.length} 个需要确认的信息缺口。`,
    promptSkillMetadata("clarification"),
    { actor: "agent", source: "runtime", action: "request_clarification", entity_type: "run" },
  ));
  else events.push(event(
    "plan",
    "任务信息完整，已生成创建计划并等待批准。",
    promptSkillMetadata("task-planning"),
    { actor: "agent", source: "runtime", action: "prepare_plan", entity_type: "run" },
  ));
  return events;
}

type AgentDependencies = {
  analyze?: (input: AnalysisInput) => Promise<AnalysisResult>;
};

export async function createAgentRun(input: AnalysisInput, dependencies: AgentDependencies = {}) {
  const testContext = dependencies.analyze && !input.teamContext ? await getTeamContext() : input.teamContext;
  const userSkills = input.userSkills || (testContext ? legacyContextToSkill(testContext) : await listUserSkills());
  const analyzed = await (dependencies.analyze || analyzeMeeting)({ ...input, teamContext: testContext, userSkills });
  const analysisTrace = analyzed.trace;
  const { trace: _trace, ...analysisWithoutTrace } = analyzed;
  const analysis = analysisWithoutTrace as AgentAnalysis;
  const questions = buildQuestions(analysis.tasks);
  const skillVersions = getPromptSkillVersions();
  const now = new Date().toISOString();
  const openItems = openItemsFromQuestions(questions, now);
  syncOpenFollowUps(analysis, openItems);
  const agentSummary = questions.length
    ? `我已识别 ${analysis.tasks.length} 个行动项，还有 ${questions.length} 项关键信息需要确认。`
    : `我已识别 ${analysis.tasks.length} 个行动项，信息完整，可以进入审批。`;
  const run: AgentRun = {
    id: randomUUID(),
    state: questions.length ? "clarifying" : "awaiting_approval",
    analysis,
    questions,
    open_items: openItems,
    clarification_history: [],
    approved_task_ids: [],
    created_tasks: [],
    tracking: null,
    events: initialEvents(analysis, questions, skillVersions),
    conversation: [
      conversationTurn("user", "meeting_submission", input.notes, { action: "submit_meeting" }),
      conversationTurn("assistant", "agent_report", agentSummary, { action: questions.length ? "request_clarification" : "present_plan" }),
    ],
    model_interactions: [],
    pending_action: null,
    overdue_task_ids: [],
    skill_versions: skillVersions,
    user_skills: userSkills,
    ...(testContext && typeof testContext === "object" ? { team_context: testContext as any } : {}),
    original_notes: input.notes,
    meeting_date: input.meetingDate,
    instruction: input.instruction,
    ...(analysisTrace ? {
      analysis_trace: {
        ...analysisTrace,
        normalized_output: analysis,
      },
    } : {}),
    created_at: now,
    updated_at: now,
  };
  return updateAgentStore((store) => {
    store.runs[run.id] = run;
    return run;
  });
}

export async function getAgentRun(id: string) {
  return readAgentStore((store) => Object.hasOwn(store.runs, id) ? store.runs[id] : null);
}

const CONFIRM_YES = new Set(["yes", "y", "true", "是", "确认", "是任务", "保留"]);
const CONFIRM_NO = new Set(["no", "n", "false", "否", "不是", "不是任务", "移除", "不保留"]);

function parseConfirm(value: string) {
  const normalized = value.trim().toLocaleLowerCase();
  if (CONFIRM_YES.has(normalized)) return true;
  if (CONFIRM_NO.has(normalized)) return false;
  throw new AgentOperationError("确认题只能回答“是”或“否”。", 422);
}

function clarificationHistory(question: AgentQuestion, answer: string, outcome: ClarificationHistoryEntry["outcome"]): ClarificationHistoryEntry {
  return {
    id: randomUUID(),
    question_id: question.id,
    task_id: question.task_id,
    field: question.field,
    prompt: question.prompt,
    input_type: question.input_type,
    answer,
    outcome,
    at: new Date().toISOString(),
  };
}

export async function answerAgentQuestions(
  id: string,
  payload: z.infer<typeof ClarificationPayloadSchema>,
  dependencies: AgentDependencies = {},
  options: { recordQuestionTurns?: boolean; source?: "chat" | "quick_action" } = {},
) {
  const current = await getAgentRun(id);
  if (!current) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);
  if (current.state !== "clarifying") throw new AgentOperationError("当前状态不需要澄清。", 409);

  const questionById = new Map(current.questions.map((question) => [question.id, question]));
  for (const answer of payload.answers) {
    const question = questionById.get(answer.questionId);
    if (!question) throw new AgentOperationError(`问题 ${answer.questionId} 不属于当前待澄清列表。`, 422);
    if (question.field === "due_date" && !isValidDateOnly(answer.value)) {
      throw new AgentOperationError("截止日期必须是有效的 YYYY-MM-DD。", 422);
    }
    if (question.field === "confirm" || (question.field === "priority" && question.input_type === "confirm")) {
      parseConfirm(answer.value);
    }
    if (question.field === "priority" && question.input_type === "priority" && !["high", "medium", "low"].includes(answer.value)) {
      throw new AgentOperationError("优先级只能选择高、中或低。", 422);
    }
  }

  const answers = new Map(payload.answers.map((answer) => [answer.questionId, answer.value.trim()]));
  const general = current.questions.find((question) => question.field === "general" && answers.has(question.id));
  let analysis = structuredClone(current.analysis);
  let refreshedTrace = current.analysis_trace;
  const history: ClarificationHistoryEntry[] = [];
  const rejectedTaskIds = new Set<string>();

  if (general) {
    const supplement = answers.get(general.id)!;
    const reanalyzed = await (dependencies.analyze || analyzeMeeting)({
      notes: `${current.original_notes}\n\n用户补充：${supplement}`,
      meetingDate: current.meeting_date,
      instruction: current.instruction,
      userSkills: current.user_skills,
    });
    const { trace, ...reanalyzedWithoutTrace } = reanalyzed;
    analysis = reanalyzedWithoutTrace as AgentAnalysis;
    refreshedTrace = trace ? { ...trace, normalized_output: analysis } : refreshedTrace;
    history.push(clarificationHistory(general, supplement, "supplemented"));
  } else {
    for (const [questionId, value] of answers) {
      const question = questionById.get(questionId)!;
      if (!question.task_id) continue;
      const task = analysis.tasks.find((item) => item.id === question.task_id);
      if (!task) throw new AgentOperationError("澄清问题关联的任务已不存在，请刷新后重试。", 409);

      if (question.field === "owner") {
        task.owner = value.trim();
        history.push(clarificationHistory(question, value, "updated"));
      } else if (question.field === "due_date") {
        task.due_date = value;
        history.push(clarificationHistory(question, value, "updated"));
      } else if (question.field === "confirm") {
        const confirmed = parseConfirm(value);
        if (!confirmed) rejectedTaskIds.add(task.id);
        history.push(clarificationHistory(question, value, confirmed ? "confirmed" : "rejected_task"));
      } else if (question.field === "priority") {
        if (question.input_type === "priority") {
          const priority = value as AgentTask["priority"];
          task.priority = priority;
          task.priority_reason = `用户在澄清中将冲突规则的最终优先级确认为${priority === "high" ? "高" : priority === "low" ? "低" : "中"}优先级。`;
          task.priority_evidence = null;
          task.priority_conflict = false;
          history.push(clarificationHistory(question, value, "priority_adjusted"));
        } else {
          const keepHigh = parseConfirm(value);
          if (!keepHigh) {
            task.priority = "medium";
            task.priority_reason = "用户在澄清中将无原文依据的高优先级调整为中优先级。";
            task.priority_evidence = null;
          }
          history.push(clarificationHistory(question, value, keepHigh ? "confirmed" : "priority_adjusted"));
        }
      }
    }
    analysis.tasks = analysis.tasks.filter((task) => !rejectedTaskIds.has(task.id));
  }

  const answeredQuestionIds = new Set(answers.keys());
  let nextQuestions = general
    ? buildQuestions(analysis.tasks)
    : current.questions.filter((question) => !answeredQuestionIds.has(question.id) && (!question.task_id || !rejectedTaskIds.has(question.task_id)));
  if (!analysis.tasks.length) nextQuestions = [generalQuestion()];
  const nextState = nextQuestions.length ? "clarifying" : "awaiting_approval";
  const resolvedAt = new Date().toISOString();
  const historyByQuestion = new Map(history.map((item) => [item.question_id, item]));
  const nextQuestionIds = new Set(nextQuestions.map((item) => item.id));
  const nextOpenItems = current.open_items.map((item) => {
    const resolved = item.question_id ? historyByQuestion.get(item.question_id) : undefined;
    if (resolved) {
      return {
        ...item,
        status: resolved.outcome === "rejected_task" ? "dismissed" as const : "resolved" as const,
        answer: resolved.answer,
        resolution: resolved.outcome,
        resolved_at: resolvedAt,
      };
    }
    if (item.status === "open" && item.task_id && rejectedTaskIds.has(item.task_id)) {
      return { ...item, status: "dismissed" as const, resolution: "task_rejected", resolved_at: resolvedAt };
    }
    if (item.status === "open" && item.question_id && !nextQuestionIds.has(item.question_id)) {
      return { ...item, status: "dismissed" as const, resolution: "superseded", resolved_at: resolvedAt };
    }
    return item;
  });
  const knownOpenItemIds = new Set(nextOpenItems.map((item) => item.id));
  nextOpenItems.push(...openItemsFromQuestions(nextQuestions, resolvedAt).filter((item) => !knownOpenItemIds.has(item.id)));
  syncOpenFollowUps(analysis, nextOpenItems);

  return updateAgentStore((store) => {
    const run = store.runs[id];
    if (!run) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);
    if (run.state !== "clarifying" || run.updated_at !== current.updated_at) {
      throw new AgentOperationError("运行记录已被更新，请刷新后重新提交澄清答案。", 409);
    }
    run.analysis = analysis;
    run.analysis_trace = refreshedTrace;
    run.questions = nextQuestions;
    run.open_items = nextOpenItems;
    run.clarification_history.push(...history);
    run.state = nextState;
    run.updated_at = new Date().toISOString();
    for (const item of history) {
      const message = item.outcome === "rejected_task" ? "用户确认该候选项不是任务，已从计划中移除。" : `已处理“${item.prompt}”的澄清答案。`;
      run.events.push(event(
        "answer",
        message,
        { question_id: item.question_id, outcome: item.outcome },
        {
          actor: "user",
          source: options.source || "quick_action",
          action: "answer_clarification",
          entity_type: "open_item",
          entity_id: item.question_id,
          before: { status: "open" },
          after: { status: item.outcome === "rejected_task" ? "dismissed" : "resolved", answer: item.answer },
        },
      ));
      if (options.recordQuestionTurns !== false) {
        run.conversation.push(conversationTurn(
          "user",
          "clarification",
          `${item.prompt}\n${item.answer}`,
          { action: "answer_clarification", task_id: item.task_id, open_item_id: item.question_id },
        ));
      }
    }
    run.events.push(nextQuestions.length
      ? event("question", `仍有 ${nextQuestions.length} 项信息需要确认。`, promptSkillMetadata("clarification"), { actor: "agent", source: "runtime", action: "request_clarification", entity_type: "run", entity_id: id })
      : event("plan", `澄清完成，已规划创建 ${analysis.tasks.length} 个任务。`, promptSkillMetadata("task-planning"), { actor: "agent", source: "runtime", action: "prepare_plan", entity_type: "run", entity_id: id }));
    run.conversation.push(conversationTurn(
      "assistant",
      "agent_report",
      nextQuestions.length
        ? `已记录你的回答，还有 ${nextQuestions.length} 项信息需要确认。`
        : `澄清已完成，${analysis.tasks.length} 个行动项已更新并等待审批。`,
      { action: nextQuestions.length ? "request_clarification" : "present_plan" },
    ));
    return run;
  });
}

function verifyTask(runId: string, source: AgentTask, actual: ExternalTask | null) {
  if (!actual) return ["任务未能从目标系统回读。"];
  const issues: string[] = [];
  if (actual.source_run_id !== runId) issues.push("源运行 ID 不一致");
  if (actual.source_task_id !== source.id) issues.push("源任务 ID 不一致");
  if (actual.title !== source.title) issues.push("标题不一致");
  if (actual.description !== source.description) issues.push("描述不一致");
  if (actual.owner !== source.owner) issues.push("负责人不一致");
  if (actual.due_date !== source.due_date) issues.push("截止日期不一致");
  if (actual.priority !== source.priority) issues.push("优先级不一致");
  if (actual.priority_reason !== source.priority_reason) issues.push("优先级理由不一致");
  if (actual.priority_evidence !== source.priority_evidence) issues.push("优先级证据不一致");
  if (actual.status !== source.status) issues.push("状态不一致");
  if (actual.evidence !== source.evidence) issues.push("原文证据不一致");
  if (JSON.stringify(actual.dependencies) !== JSON.stringify(source.dependencies)) issues.push("依赖关系不一致");
  if (actual.risk !== source.risk) issues.push("风险字段不一致");
  return issues;
}

function approvalSignature(tasks: AgentTask[]) {
  return createHash("sha256").update(JSON.stringify([...tasks].sort((a, b) => a.id.localeCompare(b.id)))).digest("hex");
}

function recordCreatedTask(source: AgentTask, actual: ExternalTask, reused: boolean, issues: string[]): CreatedTaskRecord {
  return {
    task_id: source.id,
    external_id: actual.id,
    title: actual.title,
    description: actual.description,
    owner: actual.owner,
    due_date: actual.due_date,
    priority: actual.priority,
    priority_reason: actual.priority_reason,
    priority_evidence: actual.priority_evidence,
    status: actual.status,
    evidence: actual.evidence,
    dependencies: actual.dependencies,
    risk: actual.risk,
    reused,
    verified: issues.length === 0,
    issues,
  };
}

export async function approveAndExecute(id: string, payload: z.infer<typeof ApprovalPayloadSchema>) {
  const claim = await updateAgentStore((store) => {
    const run = Object.hasOwn(store.runs, id) ? store.runs[id] : null;
    if (!run) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);

    const plannedIds = new Set(run.analysis.tasks.map((task) => task.id));
    if (payload.tasks.length !== plannedIds.size || payload.tasks.some((task) => !plannedIds.has(task.id))) {
      throw new AgentOperationError("审批任务必须与当前运行已规划的任务一致，不能新增、遗漏或替换任务 ID。", 422);
    }
    const incoming = new Map(payload.tasks.map((task) => [task.id, {
      ...task,
      owner: task.owner?.trim() || null,
      // Approval may edit task content, but it cannot pre-complete a task before creation.
      status: "todo" as const,
    }]));
    if (payload.selectedTaskIds.some((taskId) => !plannedIds.has(taskId) || !incoming.has(taskId))) {
      throw new AgentOperationError("已选任务包含不属于当前运行的任务 ID。", 422);
    }
    const selected = new Set(payload.selectedTaskIds);
    const approvedTasks = run.analysis.tasks.map((task) => incoming.get(task.id)!).filter((task) => selected.has(task.id));
    if (approvedTasks.some((task) => !task.owner || !task.due_date)) {
      throw new AgentOperationError("已选任务必须填写负责人和截止日期。", 422);
    }
    const signature = approvalSignature(approvedTasks);

    if (["executing", "verifying", "tracking", "completed"].includes(run.state)) {
      if (run.approval_signature !== signature) throw new AgentOperationError("本次运行已经按另一份审批内容执行，不能重复改写。", 409);
      run.events.push(event("approval", "检测到重复审批请求，已复用现有任务记录，未再次创建。", { reused: true }, { actor: "agent", source: "runtime", action: "reuse_approval", entity_type: "run", entity_id: id }));
      run.conversation.push(conversationTurn("assistant", "agent_report", "这份审批已经执行过，我复用了现有任务，没有重复创建。", { action: "reuse_approval" }));
      run.updated_at = new Date().toISOString();
      return { execute: false as const, run, tasks: approvedTasks };
    }
    if (run.state === "failed") {
      const approvedIds = new Set(run.approved_task_ids);
      const sameApprovedTasks = approvedIds.size === approvedTasks.length
        && approvedTasks.every((task) => approvedIds.has(task.id));
      if (!run.approval_signature || run.approval_signature !== signature || !sameApprovedTasks) {
        throw new AgentOperationError("失败运行只能使用原审批内容和原任务 ID 重试。", 409);
      }
      const retryTasks = run.analysis.tasks.filter((task) => approvedIds.has(task.id));
      run.state = "executing";
      run.updated_at = new Date().toISOString();
      run.events.push(event("approval", `用户重试执行 ${retryTasks.length} 个原审批任务；已有目标任务将按幂等键复用。`, { retry: true }, { actor: "user", source: "quick_action", action: "retry_approval", entity_type: "run", entity_id: id }));
      run.conversation.push(conversationTurn("user", "approval", `重试执行原审批的 ${retryTasks.length} 个任务。`, { action: "retry_approval" }));
      return { execute: true as const, run, tasks: retryTasks };
    }
    if (run.state !== "awaiting_approval") throw new AgentOperationError("当前状态不能执行任务创建。", 409);
    if (run.questions.length) throw new AgentOperationError("仍有未解决的澄清问题，不能执行任务创建。", 409);

    run.analysis.tasks = run.analysis.tasks.map((task) => incoming.get(task.id)!);
    run.approved_task_ids = approvedTasks.map((task) => task.id);
    run.approval_signature = signature;
    run.state = "executing";
    run.updated_at = new Date().toISOString();
    run.events.push(event("approval", `用户批准创建 ${approvedTasks.length} 个任务。`, { reused: false }, { actor: "user", source: "quick_action", action: "approve_tasks", entity_type: "run", entity_id: id, before: { state: "awaiting_approval" }, after: { state: "executing" } }));
    run.conversation.push(conversationTurn("user", "approval", `批准创建 ${approvedTasks.length} 个任务。`, { action: "approve_tasks", metadata: { task_count: approvedTasks.length } }));
    return { execute: true as const, run, tasks: approvedTasks };
  });

  if (!claim.execute) return claim.run;

  try {
    for (const task of claim.tasks) {
      await updateAgentStore((store) => {
        store.runs[id].events.push(event("tool_call", `调用 ${localTaskConnector.name} 创建“${task.title}”。`, undefined, { actor: "agent", source: "runtime", action: "create_task", entity_type: "task", entity_id: task.id }));
        store.runs[id].updated_at = new Date().toISOString();
        return true;
      });
      const creation = await localTaskConnector.createTask(id, task);
      const actual = await localTaskConnector.getTask(creation.task.id);
      const issues = verifyTask(id, task, actual);
      const record = recordCreatedTask(task, actual || creation.task, creation.reused, issues);
      await updateAgentStore((store) => {
        const run = store.runs[id];
        run.created_tasks = [...run.created_tasks.filter((item) => item.task_id !== task.id), record];
        run.updated_at = new Date().toISOString();
        run.events.push(event(
          "tool_result",
          creation.reused ? `${creation.task.id} 已存在，复用记录并完成回读。` : `${creation.task.id} 已创建并回读。`,
          { external_id: creation.task.id, reused: creation.reused },
          { actor: "tool", source: "connector", action: creation.reused ? "reuse_task" : "create_task", entity_type: "task", entity_id: task.id },
        ));
        return true;
      });
    }
  } catch {
    return updateAgentStore((store) => {
      const run = store.runs[id];
      run.state = "failed";
      run.updated_at = new Date().toISOString();
      run.events.push(event("error", "任务创建失败；已保留成功步骤，可按幂等键安全恢复。", undefined, { actor: "agent", source: "runtime", action: "create_task_failed", entity_type: "run", entity_id: id }));
      run.conversation.push(conversationTurn("assistant", "agent_report", "任务创建没有全部完成。已保留成功步骤，可以安全重试，不会重复创建。", { action: "create_task_failed" }));
      return run;
    });
  }

  const created = await readAgentStore((store) => store.runs[id].created_tasks);
  const expectedTaskIds = new Set(claim.tasks.map((task) => task.id));
  const allVerified = created.length === expectedTaskIds.size
    && created.every((item) => expectedTaskIds.has(item.task_id) && item.verified);
  await updateAgentStore((store) => {
    const run = store.runs[id];
    run.state = "verifying";
    run.updated_at = new Date().toISOString();
    run.events.push(event(
      "verification",
      allVerified ? `已回读并验证 ${created.length} 个任务，字段全部一致。` : "任务已创建，但数量或部分字段验证失败。",
      promptSkillMetadata("verification"),
      { actor: "agent", source: "runtime", action: "verify_tasks", entity_type: "run", entity_id: id },
    ));
    return run;
  });
  if (!allVerified) {
    return updateAgentStore((store) => {
      const run = store.runs[id];
      run.state = "failed";
      run.updated_at = new Date().toISOString();
      run.events.push(event("error", "回读验证未通过，运行已停止。", undefined, { actor: "agent", source: "runtime", action: "verification_failed", entity_type: "run", entity_id: id }));
      run.conversation.push(conversationTurn("assistant", "agent_report", "任务已写入，但回读字段与批准内容不一致。我已暂停后续追踪，请先检查验证结果。", { action: "verification_failed" }));
      return run;
    });
  }
  return refreshTrackingInternal(id, true, "approval");
}

function currentDateInTimeZone(timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((item) => item.type === type)?.value || "";
  return `${part("year")}-${part("month")}-${part("day")}`;
}

type TrackingReason = "approval" | "manual" | "chat" | "status_change";

function taskStatusLabel(status: ExternalTask["status"]) {
  if (status === "in_progress") return "进行中";
  if (status === "done") return "已完成";
  return "待开始";
}

function overdueDays(dueDate: string, today: string) {
  return Math.max(1, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${dueDate}T00:00:00Z`)) / 86_400_000));
}

async function refreshTrackingInternal(id: string, allowVerification: boolean, reason: TrackingReason = "manual") {
  const current = await getAgentRun(id);
  if (!current) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);
  const allowedStates: AgentRun["state"][] = allowVerification ? ["verifying", "tracking", "completed"] : ["tracking", "completed"];
  if (!allowedStates.includes(current.state)) throw new AgentOperationError("当前状态不能刷新任务追踪。", 409);

  const tasks = await localTaskConnector.listTasks(id);
  const approvedIds = new Set(current.approved_task_ids);
  const createdIds = new Set(current.created_tasks.filter((record) => record.verified).map((record) => record.task_id));
  const taskIds = new Set(tasks.map((task) => task.source_task_id));
  const mismatch = !approvedIds.size
    || tasks.length !== approvedIds.size
    || createdIds.size !== approvedIds.size
    || [...approvedIds].some((taskId) => !taskIds.has(taskId) || !createdIds.has(taskId));
  if (mismatch) {
    if (!allowVerification) throw new AgentOperationError("目标系统任务数量与已批准任务不一致，已停止追踪刷新。", 409);
    return updateAgentStore((store) => {
      const run = store.runs[id];
      run.state = "failed";
      run.updated_at = new Date().toISOString();
      run.events.push(event("error", "目标系统任务数量与已批准任务不一致，验证失败。", undefined, { actor: "agent", source: "runtime", action: "tracking_validation_failed", entity_type: "run", entity_id: id }));
      run.conversation.push(conversationTurn("assistant", "agent_report", "目标系统中的任务数量与批准计划不一致，我已暂停追踪。", { action: "tracking_validation_failed" }));
      return run;
    });
  }

  const today = currentDateInTimeZone("Asia/Shanghai");
  const overdueTasks = tasks.filter((task) => task.status !== "done" && !!task.due_date && task.due_date < today);
  const tracking = {
    total: tasks.length,
    todo: tasks.filter((task) => task.status === "todo").length,
    in_progress: tasks.filter((task) => task.status === "in_progress").length,
    done: tasks.filter((task) => task.status === "done").length,
    overdue: overdueTasks.length,
    checked_at: new Date().toISOString(),
  };
  const nextState = tracking.done === approvedIds.size ? "completed" : "tracking";
  return updateAgentStore((store) => {
    const run = store.runs[id];
    if (!allowedStates.includes(run.state)) throw new AgentOperationError("运行状态已改变，请刷新后重试。", 409);
    const previous = run.tracking ? `${run.tracking.todo}:${run.tracking.in_progress}:${run.tracking.done}:${run.tracking.overdue}` : "";
    const next = `${tracking.todo}:${tracking.in_progress}:${tracking.done}:${tracking.overdue}`;
    const previousOverdue = new Set(run.overdue_task_ids);
    const overdueIds = new Set(overdueTasks.map((task) => task.id));
    const newlyOverdue = overdueTasks.filter((task) => !previousOverdue.has(task.id));
    const clearedOverdue = tasks.filter((task) => previousOverdue.has(task.id) && !overdueIds.has(task.id));
    run.state = nextState;
    run.tracking = tracking;
    run.created_tasks = run.created_tasks.map((record) => ({
      ...record,
      status: tasks.find((task) => task.id === record.external_id)?.status || record.status,
    }));
    run.overdue_task_ids = [...overdueIds];
    run.updated_at = new Date().toISOString();
    for (const task of newlyOverdue) {
      run.events.push(event(
        "overdue",
        `任务“${task.title}”已于 ${task.due_date} 到期，目前逾期 ${overdueDays(task.due_date!, today)} 天，状态为${taskStatusLabel(task.status)}。`,
        { external_id: task.id, due_date: task.due_date!, overdue_days: overdueDays(task.due_date!, today), status: task.status },
        { actor: "agent", source: "runtime", action: "mark_overdue", entity_type: "task", entity_id: task.id, before: { overdue: false }, after: { overdue: true } },
      ));
    }
    for (const task of clearedOverdue) {
      run.events.push(event(
        "tracking",
        task.status === "done" ? `任务“${task.title}”已完成，不再计入逾期。` : `任务“${task.title}”已不再处于逾期状态。`,
        { external_id: task.id, status: task.status },
        { actor: "agent", source: "runtime", action: "clear_overdue", entity_type: "task", entity_id: task.id, before: { overdue: true }, after: { overdue: false } },
      ));
    }
    if (previous !== next) {
      run.events.push(event(
        "tracking",
        nextState === "completed"
          ? "所有已批准任务均已完成，本次会议行动闭环。"
          : `追踪已更新：待开始 ${tracking.todo} 项，进行中 ${tracking.in_progress} 项，已完成 ${tracking.done} 项，逾期 ${tracking.overdue} 项。`,
        promptSkillMetadata("tracking"),
        { actor: "agent", source: "runtime", action: "refresh_tracking", entity_type: "run", entity_id: id },
      ));
    }
    if (reason === "manual" || reason === "chat") {
      if (reason === "manual") run.conversation.push(conversationTurn("user", "tracking", "检查当前任务进度。", { action: "refresh_tracking" }));
      run.conversation.push(conversationTurn(
        "assistant",
        "agent_report",
        nextState === "completed"
          ? "所有已批准任务都已完成，本次会议行动已闭环。"
          : `已检查任务中心：${tracking.in_progress} 项进行中，${tracking.todo} 项待开始，${tracking.done} 项已完成，${tracking.overdue} 项逾期。`,
        { action: "refresh_tracking" },
      ));
    } else if (reason === "approval") {
      run.conversation.push(conversationTurn(
        "assistant",
        "agent_report",
        `已创建并回读验证 ${tasks.length} 个任务，现在开始追踪执行状态${tracking.overdue ? `；其中 ${tracking.overdue} 项已经逾期` : ""}。`,
        { action: "start_tracking", metadata: { task_count: tasks.length, overdue: tracking.overdue } },
      ));
    }
    return run;
  });
}

export async function refreshTracking(id: string, source: "manual" | "chat" = "manual") {
  return refreshTrackingInternal(id, false, source);
}

export async function updateExternalTaskStatus(id: string, status: "todo" | "in_progress" | "done", source: "quick_action" | "chat" = "quick_action") {
  const existing = await localTaskConnector.getTask(id);
  if (!existing) throw new AgentOperationError("找不到目标任务。", 404);
  const run = await getAgentRun(existing.source_run_id);
  if (!run || run.state !== "tracking" || !run.created_tasks.some((record) => record.external_id === id && record.verified)) {
    throw new AgentOperationError("该任务不属于可追踪的已批准运行。", 409);
  }
  if (existing.status === status) return existing;
  const task = await localTaskConnector.updateStatus(id, status);
  if (!task) throw new AgentOperationError("找不到目标任务。", 404);
  await updateAgentStore((store) => {
    const current = store.runs[existing.source_run_id];
    if (!current || current.state !== "tracking") throw new AgentOperationError("运行状态已改变，请刷新后重试。", 409);
    current.events.push(event(
      "status_change",
      `用户将任务“${task.title}”从${taskStatusLabel(existing.status)}改为${taskStatusLabel(status)}。`,
      { external_id: id, previous_status: existing.status, status },
      { actor: "user", source, action: "set_task_status", entity_type: "task", entity_id: id, before: { status: existing.status }, after: { status } },
    ));
    current.conversation.push(conversationTurn(
      "user",
      "status_update",
      `将“${task.title}”标记为${taskStatusLabel(status)}。`,
      { action: "set_task_status", task_id: task.source_task_id, metadata: { external_id: id, previous_status: existing.status, status } },
    ));
    current.updated_at = new Date().toISOString();
    return true;
  });
  const refreshed = await refreshTrackingInternal(existing.source_run_id, false, "status_change");
  await updateAgentStore((store) => {
    const current = store.runs[existing.source_run_id];
    current.conversation.push(conversationTurn(
      "assistant",
      "agent_report",
      refreshed.state === "completed"
        ? `已将“${task.title}”标记为${taskStatusLabel(status)}。所有任务均已完成，本次行动闭环。`
        : `已将“${task.title}”标记为${taskStatusLabel(status)}，并同步更新了任务进度。`,
      { action: "set_task_status", task_id: task.source_task_id, metadata: { external_id: id, status } },
    ));
    current.updated_at = new Date().toISOString();
    return true;
  });
  return task;
}

export async function confirmTaskFieldEdit(runId: string, actionId: string) {
  const result = await updateAgentStore((store) => {
    const run = Object.hasOwn(store.runs, runId) ? store.runs[runId] : null;
    const pending = run?.pending_action;
    if (!run || !pending || pending.type !== "edit_task" || pending.id !== actionId) {
      throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
    }
    const tracking = pending.external_task_id !== null;
    if (run.state !== (tracking ? "tracking" : "awaiting_approval")) {
      throw new AgentOperationError("运行阶段已改变，请重新发起修改。", 409);
    }
    const index = run.analysis.tasks.findIndex((item) => item.id === pending.task_id);
    if (index < 0) throw new AgentOperationError("目标任务已经不存在，请重新发起。", 409);
    const task = run.analysis.tasks[index];
    const fields = Object.keys(pending.changes) as Array<keyof TaskFieldChanges>;
    if (!fields.length || fields.some((field) => task[field] !== pending.expected[field])) {
      throw new AgentOperationError("任务字段已经变化，请重新发起修改。", 409);
    }
    const changes = pending.changes;
    const updated = AgentTaskSchema.parse({
      ...task,
      ...changes,
      ...(changes.priority ? {
        priority_reason: `用户在 Agent 对话中将优先级确认为${changes.priority === "high" ? "高" : changes.priority === "low" ? "低" : "中"}优先级。`,
        priority_evidence: null,
        priority_conflict: false,
      } : {}),
    });
    let external: ExternalTask | null = null;
    if (tracking) {
      const record = run.created_tasks.find((item) => item.task_id === task.id && item.external_id === pending.external_task_id && item.verified);
      external = Object.hasOwn(store.tasks, pending.external_task_id!) ? store.tasks[pending.external_task_id!] : null;
      if (!record || !external || external.source_run_id !== runId || external.source_task_id !== task.id
        || external.status !== record.status
        || fields.some((field) => external![field] !== pending.expected[field])) {
        throw new AgentOperationError("目标任务已变化或未通过验证，请重新发起修改。", 409);
      }
      Object.assign(external, changes);
      if (changes.priority) {
        external.priority_reason = updated.priority_reason;
        external.priority_evidence = null;
      }
      external.updated_at = new Date().toISOString();
      Object.assign(record, changes);
      if (changes.priority) {
        record.priority_reason = updated.priority_reason;
        record.priority_evidence = null;
      }
    }
    run.analysis.tasks[index] = updated;
    run.pending_action = null;
    const before = Object.fromEntries(fields.map((field) => [field, pending.expected[field] ?? null]));
    const after = Object.fromEntries(fields.map((field) => [field, updated[field] ?? null]));
    const labels: Record<keyof TaskFieldChanges, string> = { title: "标题", description: "描述", owner: "负责人", due_date: "截止日期", priority: "优先级" };
    const fieldNames = fields.map((field) => labels[field]).join("、");
    run.events.push(event("task_edit", `用户修改了任务“${updated.title}”的${fieldNames}。`, {
      fields: fields.join(","), external_id: pending.external_task_id,
    }, { actor: "user", source: "chat", action: "edit_task", entity_type: "task", entity_id: pending.external_task_id || task.id, before, after }));
    run.conversation.push(conversationTurn("user", "message", "确认执行此任务字段修改。", { action: "confirm_action", task_id: task.id }));
    if (!tracking) run.conversation.push(conversationTurn("assistant", "agent_report", `已更新“${updated.title}”的${fieldNames}；创建任务仍须单独审批。`, { action: "edit_task", task_id: task.id }));
    run.updated_at = new Date().toISOString();
    return {
      tracking, run, externalId: pending.external_task_id, changes, fieldNames, title: updated.title, taskId: task.id,
      priorityReason: updated.priority_reason, priorityEvidence: updated.priority_evidence,
    };
  });
  if (!result.tracking) return result.run;
  // Local Task Hub shares this store; read back through the connector boundary before refreshing tracking.
  const readback = result.externalId ? await localTaskConnector.getTask(result.externalId) : null;
  if (!readback || readback.source_run_id !== runId || readback.source_task_id !== result.taskId
    || Object.entries(result.changes).some(([field, value]) => readback[field as keyof TaskFieldChanges] !== value)
    || (result.changes.priority && (readback.priority_reason !== result.priorityReason || readback.priority_evidence !== result.priorityEvidence))) {
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      run.state = "failed";
      const record = run.created_tasks.find((item) => item.external_id === result.externalId);
      if (record) {
        record.verified = false;
        record.issues.push("修改后的字段回读不一致");
      }
      run.events.push(event("error", "任务字段修改后的回读验证失败，已暂停追踪。", undefined, {
        actor: "agent", source: "runtime", action: "task_edit_verification_failed", entity_type: "task", entity_id: result.externalId || undefined,
      }));
      run.conversation.push(conversationTurn("assistant", "agent_report", "任务字段修改后的回读验证失败，已暂停追踪。", { action: "task_edit_verification_failed" }));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }
  await updateAgentStore((store) => {
    const run = store.runs[runId];
    run.events.push(event("verification", `任务“${result.title}”的字段修改已从 ${readback.id} 回读验证。`, {
      external_id: readback.id, fields: Object.keys(result.changes).join(","),
    }, { actor: "agent", source: "runtime", action: "verify_task_edit", entity_type: "task", entity_id: readback.id }));
    run.conversation.push(conversationTurn("assistant", "agent_report", `已更新“${result.title}”的${result.fieldNames}，本地任务回读一致。`, {
      action: "edit_task", task_id: result.taskId,
    }));
    run.updated_at = new Date().toISOString();
    return true;
  });
  return refreshTrackingInternal(runId, false, "status_change");
}

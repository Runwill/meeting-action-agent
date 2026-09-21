import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { isValidDateOnly } from "./analyze.ts";
import { AgentOperationError, answerAgentQuestions, confirmTaskFieldEdit, getAgentRun, refreshTracking, updateExternalTaskStatus } from "./agent.ts";
import { updateAgentStore, type AgentRun, type ConversationTurn, type TaskFieldChanges } from "./agent-store.ts";
import { localTaskConnector } from "./connectors/local-task.ts";
import { buildDialogueSystemPrompt } from "./prompt-skills.ts";
import { getModelConfig } from "./runtime-config.ts";

export const AgentMessageSchema = z.object({ content: z.string().trim().min(1).max(2000) }).strict();
export const ConfirmAgentActionSchema = z.object({ actionId: z.string().uuid(), approved: z.boolean() }).strict();

const FieldChangesSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
  description: z.string().trim().max(4000).optional(),
  owner: z.string().trim().min(1).max(100).optional(),
  due_date: z.string().refine(isValidDateOnly, "截止日期必须是有效的 YYYY-MM-DD。").optional(),
  priority: z.enum(["high", "medium", "low"]).optional(),
}).strict();

const PlannedIntentSchema = z.object({
  intent: z.enum(["answer_questions", "refresh_tracking", "propose_status", "propose_task_edit", "explain", "unsure"]),
  question_answers: z.array(z.object({ questionId: z.string().uuid(), value: z.string().trim().min(1).max(500) }).strict()).max(100),
  external_task_id: z.string().max(200).nullable(),
  status: z.enum(["todo", "in_progress", "done"]).nullable(),
  task_id: z.string().uuid().nullable().optional().default(null),
  field_changes: FieldChangesSchema.optional().default({}),
  reply: z.string().trim().min(1).max(1000),
}).strict();

type PlannedIntent = z.infer<typeof PlannedIntentSchema>;
type ChatDependencies = { plan?: (run: AgentRun, content: string) => Promise<z.input<typeof PlannedIntentSchema>> };
type ModelPlan = {
  plan: PlannedIntent;
  trace: {
    system_prompt: string;
    user_prompt: string;
    model_output: string;
  };
};

function turn(role: ConversationTurn["role"], kind: ConversationTurn["kind"], content: string, action: string): ConversationTurn {
  return { id: randomUUID(), role, kind, content, action, at: new Date().toISOString() };
}

function explicitlyNamesDate(message: string, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const dates = message.matchAll(/(?<!\d)(\d{4})(?:-|\/|\.|年)\s*(\d{1,2})(?:-|\/|\.|月)\s*(\d{1,2})(?:日|号)?(?!\d)/g);
  return [...dates].some((match) => Number(match[1]) === year && Number(match[2]) === month && Number(match[3]) === day);
}

async function planWithModel(run: AgentRun, content: string): Promise<ModelPlan> {
  const config = await getModelConfig();
  if (!config) throw new AgentOperationError("请先配置模型 API，再使用 Agent 对话。", 503);
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 0 });
  const context = {
    state: run.state,
    meeting_date: run.meeting_date || run.analysis.meeting_date,
    current_date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
    tasks: run.analysis.tasks.map((task, index) => ({ task_number: index + 1, id: task.id, title: task.title, description: task.description, owner: task.owner, due_date: task.due_date, priority: task.priority, status: task.status })),
    created_tasks: run.created_tasks.map((task, index) => ({ task_number: index + 1, task_id: task.task_id, external_id: task.external_id, title: task.title, description: task.description, owner: task.owner, priority: task.priority, status: task.status, due_date: task.due_date, verified: task.verified })),
    open_questions: run.questions.map((question) => ({ id: question.id, task_id: question.task_id, prompt: question.prompt, field: question.field })),
    tracking: run.tracking,
    pending_action: run.pending_action,
    user_skills: run.user_skills.filter((skill) => skill.enabled).map((skill) => ({ name: skill.name, markdown: skill.content })),
    recent_conversation: run.conversation.slice(-10).map((item) => ({ role: item.role, content: item.content.slice(0, 600) })),
    user_message: content,
  };
  const systemPrompt = buildDialogueSystemPrompt();
  const userPrompt = JSON.stringify(context);
  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    temperature: 0.1,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty model response");
  return {
    plan: PlannedIntentSchema.parse(JSON.parse(raw)),
    trace: { system_prompt: systemPrompt, user_prompt: userPrompt, model_output: raw },
  };
}

async function appendAssistant(runId: string, content: string, action: string) {
  return updateAgentStore((store) => {
    const run = store.runs[runId];
    run.conversation.push(turn("assistant", "agent_report", content, action));
    run.updated_at = new Date().toISOString();
    return run;
  });
}

export async function sendAgentMessage(runId: string, input: unknown, dependencies: ChatDependencies = {}) {
  const { content } = AgentMessageSchema.parse(input);
  const current = await getAgentRun(runId);
  if (!current) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);
  if (current.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);

  let planning: ModelPlan;
  try {
    planning = dependencies.plan
      ? { plan: PlannedIntentSchema.parse(await dependencies.plan(current, content)), trace: { system_prompt: "", user_prompt: "", model_output: "" } }
      : await planWithModel(current, content);
  } catch (error) {
    if (error instanceof AgentOperationError) throw error;
    throw new AgentOperationError("Agent 未能理解这条消息，请检查模型连接后重试。", 502);
  }

  await updateAgentStore((store) => {
    const run = store.runs[runId];
    if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
    run.conversation.push(turn("user", "message", content, "send_message"));
    if (planning.trace.model_output) run.model_interactions.push({
      id: randomUUID(),
      kind: "dialogue",
      at: new Date().toISOString(),
      ...planning.trace,
      normalized_intent: planning.plan.intent,
    });
    run.updated_at = new Date().toISOString();
    return true;
  });

  const { plan } = planning;

  if (plan.intent === "answer_questions") {
    if (!plan.question_answers.length || plan.question_answers.some((item) => !current.questions.some((question) => question.id === item.questionId))) {
      return appendAssistant(runId, "我没能把这条回答对应到当前待确认问题，请指出具体问题或使用澄清表单。", "clarification_needs_detail");
    }
    try {
      return await answerAgentQuestions(runId, { answers: plan.question_answers }, {}, { recordQuestionTurns: false, source: "chat" });
    } catch (error) {
      if (!(error instanceof AgentOperationError) && !(error instanceof z.ZodError)) throw error;
      return appendAssistant(runId, error instanceof AgentOperationError ? error.message : "回答格式无效，请重新说明。", "clarification_needs_detail");
    }
  }

  if (plan.intent === "refresh_tracking") {
    if (current.state !== "tracking" && current.state !== "completed") {
      return appendAssistant(runId, "当前尚未进入任务追踪；请先完成澄清和人工审批。", "tracking_unavailable");
    }
    await refreshTracking(runId, "chat");
    return (await getAgentRun(runId))!;
  }

  if (plan.intent === "propose_status") {
    const task = current.created_tasks.find((item) => item.external_id === plan.external_task_id && item.verified);
    if (current.state !== "tracking" || !task || !plan.status) {
      return appendAssistant(runId, "我无法唯一定位一个可追踪任务，请说明任务名称和目标状态。", "status_needs_detail");
    }
    if (task.status === plan.status) {
      return appendAssistant(runId, `“${task.title}”目前已经是该状态，无需重复修改。`, "status_unchanged");
    }
    const pending = {
      id: randomUUID(),
      type: "set_task_status" as const,
      external_task_id: task.external_id,
      status: plan.status,
      expected_status: task.status,
      created_at: new Date().toISOString(),
    };
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.state !== "tracking") throw new AgentOperationError("运行状态已改变，请刷新后重试。", 409);
      if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
      if (!run.created_tasks.some((item) => item.external_id === task.external_id && item.verified && item.status === task.status)) {
        throw new AgentOperationError("任务状态已改变，请重新发起。", 409);
      }
      run.pending_action = pending;
      const target = pending.status === "in_progress" ? "进行中" : pending.status === "done" ? "已完成" : "待开始";
      run.conversation.push(turn("assistant", "proposal", `准备将“${task.title}”改为${target}，请确认后执行。`, "propose_status"));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  if (plan.intent === "propose_task_edit") {
    const task = current.analysis.tasks.find((item) => item.id === plan.task_id);
    const changes = plan.field_changes;
    const fields = Object.keys(changes) as Array<keyof TaskFieldChanges>;
    const created = current.created_tasks.find((item) => item.task_id === task?.id && item.external_id === plan.external_task_id && item.verified);
    const canEdit = task && fields.length && (
      (current.state === "awaiting_approval" && plan.external_task_id === null)
      || (current.state === "tracking" && created)
    );
    if (!canEdit) {
      return appendAssistant(runId, "无法定位当前阶段可修改的唯一任务。请说明任务名称和要修改的字段。", "task_edit_needs_detail");
    }
    if (changes.due_date && !explicitlyNamesDate(content, changes.due_date)) {
      return appendAssistant(runId, "请提供完整的截止日期（年、月、日），我不会替你补全缺失的日期。", "task_edit_needs_date");
    }
    const expected = Object.fromEntries(fields.map((field) => [field, task[field]])) as TaskFieldChanges;
    if (fields.every((field) => changes[field] === expected[field])) {
      return appendAssistant(runId, `“${task.title}”的这些字段已经是目标值，无需重复修改。`, "task_edit_unchanged");
    }
    const labels: Record<keyof TaskFieldChanges, string> = { title: "标题", description: "描述", owner: "负责人", due_date: "截止日期", priority: "优先级" };
    const priorityLabels = { high: "高", medium: "中", low: "低" };
    const display = (field: keyof TaskFieldChanges, value: string | null | undefined) => field === "priority" && value
      ? priorityLabels[value as keyof typeof priorityLabels] : value || "未填写";
    const summary = fields.map((field) => `${labels[field]}：${display(field, expected[field])} → ${display(field, changes[field])}`).join("；");
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.state !== current.state) throw new AgentOperationError("运行状态已改变，请刷新后重试。", 409);
      if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
      const latest = run.analysis.tasks.find((item) => item.id === task.id);
      if (!latest || fields.some((field) => latest[field] !== expected[field])) {
        throw new AgentOperationError("任务字段已改变，请重新发起。", 409);
      }
      run.pending_action = {
        id: randomUUID(), type: "edit_task", task_id: task.id, external_task_id: plan.external_task_id,
        changes, expected, created_at: new Date().toISOString(),
      };
      run.conversation.push(turn("assistant", "proposal", `准备修改“${task.title}”：${summary}。请确认后执行。`, "propose_task_edit"));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  return appendAssistant(runId, plan.reply, plan.intent);
}

export async function confirmAgentAction(runId: string, input: unknown) {
  const { actionId, approved } = ConfirmAgentActionSchema.parse(input);
  const current = await getAgentRun(runId);
  if (!current) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);
  const pending = current.pending_action;
  if (!pending || pending.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);

  if (pending.type === "edit_task") {
    if (approved) return confirmTaskFieldEdit(runId, actionId);
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
      run.pending_action = null;
      run.conversation.push(turn("user", "message", "取消此任务字段修改。", "cancel_action"));
      run.conversation.push(turn("assistant", "agent_report", "已取消，任务字段没有改变。", "cancel_action"));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  const external = approved ? await localTaskConnector.getTask(pending.external_task_id) : null;
  if (approved && (!external || external.source_run_id !== runId || external.status !== pending.expected_status)) {
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action?.id === actionId) run.pending_action = null;
      run.conversation.push(turn("assistant", "agent_report", "任务状态已经变化，本次确认未执行。请刷新后重新发起。", "stale_action"));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  const claim = await updateAgentStore((store) => {
    const run = store.runs[runId];
    if (!run.pending_action || run.pending_action.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
    run.pending_action = null;
    run.conversation.push(turn("user", "message", approved ? "确认执行此状态变更。" : "取消此状态变更。", approved ? "confirm_action" : "cancel_action"));
    run.updated_at = new Date().toISOString();
    return true;
  });
  if (!claim || !approved) return appendAssistant(runId, "已取消，任务状态没有改变。", "cancel_action");
  const task = current.created_tasks.find((item) => item.external_id === pending.external_task_id);
  if (!task || task.status !== pending.expected_status) {
    return appendAssistant(runId, "任务状态已经变化，本次确认未执行。请刷新后重新发起。", "stale_action");
  }
  await updateExternalTaskStatus(pending.external_task_id, pending.status, "chat");
  return (await getAgentRun(runId))!;
}

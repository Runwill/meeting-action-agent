import { randomUUID } from "node:crypto";
import OpenAI from "openai";
import { z } from "zod";
import { isValidDateOnly } from "./analyze.ts";
import { AgentOperationError, answerAgentQuestions, confirmTaskFieldEdit, getAgentRun, refreshTracking, updateExternalTaskStatus } from "./agent.ts";
import { updateAgentStore, type AgentRun, type ConversationTurn, type FeishuSettingsChangeSet, type PendingAgentAction, type QueuedAgentPlan, type TaskFieldChanges } from "./agent-store.ts";
import { getTaskConnector } from "./connectors/index.ts";
import { getFeishuConfig } from "./feishu-config.ts";
import { updateFeishuAdvancedSettings } from "./feishu-oauth.ts";
import { buildPlatformAgentContext, formatReminderMinute, planPlatformAgentToolFromPlan, sameFeishuSettingValue, summarizeFeishuSettingsChanges, type PlatformAgentToolPlan, type PlatformToolIntent } from "./platform-agent-tools.ts";
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

const PlatformSettingScopeSchema = z.enum(["summary", "due_reminders", "comments", "tasklist", "capabilities", "unknown"]);
const PlatformChangesSchema = z.object({
  tasklistGuid: z.string().trim().min(1).max(500).nullable().optional(),
  tasklistSectionGuid: z.string().trim().min(1).max(500).nullable().optional(),
  dueReminderMinutes: z.array(z.number().int().min(0).max(43_200)).max(6).optional(),
  syncComments: z.boolean().optional(),
}).strict();

function nullToUndefined(value: unknown) {
  return value === null ? undefined : value;
}

function normalizeQuestionAnswers(value: unknown) {
  if (value === null || value === undefined) return undefined;
  if (Array.isArray(value)) return value;
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    if (!entries.length) return [];
    return entries.map(([questionId, answer]) => ({
      questionId,
      value: typeof answer === "string" ? answer : String(answer ?? ""),
    }));
  }
  return value;
}

const PlannedIntentSchema = z.object({
  intent: z.enum([
    "answer_questions",
    "refresh_tracking",
    "propose_status",
    "propose_task_edit",
    "propose_task_reminders",
    "propose_task_comment",
    "query_platform_settings",
    "query_platform_capabilities",
    "propose_platform_settings_change",
    "guide_platform_setting_change",
    "explain",
    "unsure",
  ]),
  question_answers: z.preprocess(
    normalizeQuestionAnswers,
    z.array(z.object({ questionId: z.string().uuid(), value: z.string().trim().min(1).max(500) }).strict()).max(100).optional().default([]),
  ),
  external_task_id: z.string().max(200).nullable().optional().default(null),
  status: z.enum(["todo", "in_progress", "done"]).nullable().optional().default(null),
  task_id: z.string().uuid().nullable().optional().default(null),
  field_changes: z.preprocess(nullToUndefined, FieldChangesSchema.optional().default({})),
  due_reminder_minutes: z.preprocess(
    nullToUndefined,
    z.array(z.number().int().min(0).max(43_200)).max(6).optional().default([]),
  ),
  comment: z.preprocess(nullToUndefined, z.string().trim().max(2000).optional().default("")),
  platform: z.enum(["feishu"]).nullable().optional().default(null),
  setting_scope: PlatformSettingScopeSchema.nullable().optional().default(null),
  platform_changes: z.preprocess(nullToUndefined, PlatformChangesSchema.optional().default({})),
  remaining_user_message: z.preprocess((value) => value === null ? "" : value, z.string().trim().max(1000).optional().default("")),
  reply: z.string().trim().min(1).max(1000),
}).strict();

const PlatformReplySchema = z.object({
  reply: z.string().trim().min(1).max(1000),
}).strict();

type PlannedIntent = z.infer<typeof PlannedIntentSchema>;
type PlatformFactsPlan = Extract<PlatformAgentToolPlan, { type: "facts" }>;
type ChatDependencies = {
  plan?: (run: AgentRun, content: string, context?: unknown) => Promise<z.input<typeof PlannedIntentSchema>>;
  platformReply?: (run: AgentRun, content: string, toolPlan: PlatformFactsPlan) => Promise<string>;
};
type ModelPlan = {
  plan: PlannedIntent;
  trace: ModelTrace;
};
type PlatformReply = {
  reply: string;
  trace: ModelTrace;
};
type ModelTrace = {
  system_prompt: string;
  user_prompt: string;
  model_output: string;
  duration_ms?: number;
};

function turn(role: ConversationTurn["role"], kind: ConversationTurn["kind"], content: string, action: string, metadata?: ConversationTurn["metadata"]): ConversationTurn {
  return { id: randomUUID(), role, kind, content, action, at: new Date().toISOString(), ...(metadata ? { metadata } : {}) };
}

function modelStatsMetadata(traces: Array<ModelTrace | null | undefined>): ConversationTurn["metadata"] {
  const actualTraces = traces.filter((trace): trace is ModelTrace => !!trace?.model_output);
  if (!actualTraces.length) return {};
  const knownDurations = actualTraces.map((trace) => trace.duration_ms).filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const totalDuration = knownDurations.reduce((sum, value) => sum + value, 0);
  return {
    model_call_count: actualTraces.length,
    ...(knownDurations.length ? { model_duration_ms: totalDuration } : {}),
  };
}

async function syncExistingFeishuTasksAfterSettingsChange(run: AgentRun, changes: FeishuSettingsChangeSet) {
  if (run.connector_id !== "feishu" || !("dueReminderMinutes" in changes)) {
    return { attempted: 0, applied: 0, failed: 0, skipped: 0, issueCount: 0, issues: [] as string[] };
  }
  const records = run.created_tasks.filter((task) => task.verified);
  if (!records.length) return { attempted: 0, applied: 0, failed: 0, skipped: 0, issueCount: 0, issues: [] as string[] };
  const connector = getTaskConnector(run.connector_id);
  if (!connector.syncTaskSettings) return { attempted: 0, applied: 0, failed: 0, skipped: records.length, issueCount: 0, issues: [] as string[] };

  let applied = 0;
  let failed = 0;
  let skipped = 0;
  let issueCount = 0;
  const issues = new Set<string>();
  for (const record of records) {
    try {
      const result = await connector.syncTaskSettings(record.external_id);
      if (result.applied.includes("reminders")) applied += 1;
      else skipped += 1;
      if (result.issues.length) {
        issueCount += 1;
        for (const issue of result.issues) {
          if (issues.size < 3) issues.add(issue);
        }
      }
    } catch {
      failed += 1;
    }
  }
  return { attempted: records.length, applied, failed, skipped, issueCount, issues: [...issues] };
}

function formatExistingFeishuSyncSummary(result: Awaited<ReturnType<typeof syncExistingFeishuTasksAfterSettingsChange>>) {
  if (!result.attempted) return "";
  const parts = [`本次运行已有 ${result.attempted} 个已创建飞书任务`];
  if (result.applied) parts.push(`已为 ${result.applied} 个同步提醒规则`);
  if (result.skipped) parts.push(`${result.skipped} 个无需同步或暂不满足条件`);
  if (result.issueCount) parts.push(`${result.issueCount} 个有同步边界提示：${result.issues.join("；")}`);
  if (result.failed) parts.push(`${result.failed} 个同步失败，可稍后重试`);
  return ` ${parts.join("，")}。`;
}

function explicitlyNamesDate(message: string, date: string) {
  const [year, month, day] = date.split("-").map(Number);
  const dates = message.matchAll(/(?<!\d)(\d{4})(?:-|\/|\.|年)\s*(\d{1,2})(?:-|\/|\.|月)\s*(\d{1,2})(?:日|号)?(?!\d)/g);
  return [...dates].some((match) => Number(match[1]) === year && Number(match[2]) === month && Number(match[3]) === day);
}

function formatReminderMinutes(values: number[]) {
  return values.length ? values.map(formatReminderMinute).join("、") : "未启用";
}

function taskStatusLabel(status: "todo" | "in_progress" | "done") {
  return status === "done" ? "已完成" : status === "in_progress" ? "进行中" : "待开始";
}

function supportedStatusLabels(statusValues: Array<"todo" | "in_progress" | "done"> | undefined) {
  return statusValues?.length ? statusValues.map(taskStatusLabel).join("或") : "该平台支持的状态";
}

function buildTaskStatusPendingFromPlan(run: AgentRun, plan: Pick<PlannedIntent, "external_task_id" | "status">) {
  if (!plan.external_task_id || !plan.status) return null;
  const task = run.created_tasks.find((item) => item.external_id === plan.external_task_id && item.verified);
  if (!task) return { kind: "reply" as const, content: "我无法唯一定位一个可追踪任务，请说明任务名称和目标状态。" };
  const connector = getTaskConnector(run.connector_id);
  if (run.state !== "tracking") {
    return { kind: "reply" as const, content: "当前还没有进入任务追踪阶段，不能修改外部任务状态。" };
  }
  if (!connector.capabilities.updateStatus) {
    return { kind: "reply" as const, content: `${connector.name} 当前不支持在系统内同步任务状态。` };
  }
  if (connector.capabilities.statusValues?.length && !connector.capabilities.statusValues.includes(plan.status)) {
    return { kind: "reply" as const, content: `${connector.name} 不能同步为“${taskStatusLabel(plan.status)}”；这个平台当前只支持同步为${supportedStatusLabels(connector.capabilities.statusValues)}。` };
  }
  if (task.status === plan.status) {
    return { kind: "reply" as const, content: `“${task.title}”目前已经是${taskStatusLabel(plan.status)}，无需重复修改。` };
  }
  return {
    kind: "proposal" as const,
    pending: {
      id: randomUUID(),
      type: "set_task_status" as const,
      external_task_id: task.external_id,
      status: plan.status,
      expected_status: task.status,
      created_at: new Date().toISOString(),
    },
    content: `准备将“${task.title}”改为${taskStatusLabel(plan.status)}，请确认后执行。`,
  };
}

function buildTaskReminderPendingFromPlan(run: AgentRun, plan: Pick<PlannedIntent, "task_id" | "external_task_id" | "due_reminder_minutes">) {
  if (run.connector_id !== "feishu") return null;
  if (!plan.external_task_id || !plan.task_id) return { kind: "reply" as const, content: "我无法唯一定位一个已创建的飞书任务，请说明任务名称或任务编号。" };
  const task = run.created_tasks.find((item) => item.external_id === plan.external_task_id && item.task_id === plan.task_id && item.verified);
  if (!task) return { kind: "reply" as const, content: "我还不能定位到这个已创建并验证过的飞书任务。请说明任务名称，或先完成审批创建后再修改单个任务提醒。" };
  const dueReminderMinutes = [...new Set(plan.due_reminder_minutes || [])];
  if (!task.due_date && dueReminderMinutes.length) {
    return { kind: "reply" as const, content: `“${task.title}”没有截止日期，飞书不能设置到期提醒。请先给任务补充截止日期。` };
  }
  return {
    kind: "proposal" as const,
    task,
    dueReminderMinutes,
    content: `准备把“${task.title}”的到期提醒同步为${formatReminderMinutes(dueReminderMinutes)}。这只修改这个飞书任务，不会改变平台连接里的新建任务提醒规则。请确认后执行。`,
  };
}

function buildTaskCommentPendingFromPlan(run: AgentRun, plan: Pick<PlannedIntent, "task_id" | "external_task_id" | "comment">) {
  if (!plan.external_task_id || !plan.task_id) return { kind: "reply" as const, content: "我无法唯一定位一个已创建的任务，请说明任务名称或任务编号。" };
  const task = run.created_tasks.find((item) => item.external_id === plan.external_task_id && item.task_id === plan.task_id && item.verified);
  if (!task) return { kind: "reply" as const, content: "我还不能定位到这个已创建并验证过的任务。请说明任务名称，或先完成审批创建后再评论。" };
  const connector = getTaskConnector(run.connector_id);
  if (run.state !== "tracking" && run.state !== "completed") {
    return { kind: "reply" as const, content: "当前还没有进入任务追踪阶段，不能给外部任务追加评论。" };
  }
  if (!connector.addComment) {
    return { kind: "reply" as const, content: `${connector.name} 当前不支持从系统内给单个任务追加评论。` };
  }
  const comment = plan.comment.trim();
  if (!comment) return { kind: "reply" as const, content: "请说明要写入任务评论区的具体内容。" };
  return {
    kind: "proposal" as const,
    task,
    comment,
    content: `准备在“${task.title}”下追加评论：${comment}。请确认后执行。`,
  };
}

function isCommentPermissionIssue(issue: string) {
  return /飞书评论同步失败|task:comment:write|task:comment:read/i.test(issue);
}

function queueablePlan(plan: PlannedIntent): QueuedAgentPlan | null {
  if (plan.intent !== "propose_status" && plan.intent !== "propose_task_edit" && plan.intent !== "propose_task_reminders" && plan.intent !== "propose_task_comment" && plan.intent !== "explain" && plan.intent !== "unsure") {
    return null;
  }
  return {
    intent: plan.intent,
    external_task_id: plan.external_task_id,
    status: plan.status,
    task_id: plan.task_id ?? null,
    field_changes: plan.field_changes,
    due_reminder_minutes: plan.due_reminder_minutes,
    comment: plan.comment,
    reply: plan.reply,
  };
}

function queuedPlanMetadata(queuedPlan: QueuedAgentPlan): ConversationTurn["metadata"] {
  return {
    agent_source: "model_understanding",
    source_detail: "平台配置确认后的模型规划动作",
    tool: "dialogue-orchestration",
    model_called: true,
    queued_intent: queuedPlan.intent,
  };
}

function platformToolIntentFromPlan(plan: PlannedIntent): PlatformToolIntent | null {
  if (
    plan.intent !== "query_platform_settings"
    && plan.intent !== "query_platform_capabilities"
    && plan.intent !== "propose_platform_settings_change"
    && plan.intent !== "guide_platform_setting_change"
  ) {
    return null;
  }
  return {
    intent: plan.intent,
    platform: plan.platform,
    setting_scope: plan.setting_scope,
    changes: plan.platform_changes,
    remaining_user_message: plan.remaining_user_message,
    reply: plan.reply,
  };
}

function buildDialogueContext(run: AgentRun, content: string) {
  const sourceTaskNumberById = new Map(run.analysis.tasks.map((task, index) => [task.id, index + 1]));
  return {
    state: run.state,
    connector: {
      id: run.connector_id,
      capabilities: getTaskConnector(run.connector_id).capabilities,
    },
    meeting_date: run.meeting_date || run.analysis.meeting_date,
    current_date: new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date()),
    tasks: run.analysis.tasks.map((task, index) => ({ task_number: index + 1, id: task.id, title: task.title, description: task.description, owner: task.owner, due_date: task.due_date, priority: task.priority, status: task.status })),
    created_tasks: run.created_tasks.map((task, index) => {
      const sourceTaskNumber = sourceTaskNumberById.get(task.task_id) ?? null;
      return {
        task_number: sourceTaskNumber ?? index + 1,
        source_task_number: sourceTaskNumber,
        created_task_number: index + 1,
        task_id: task.task_id,
        external_id: task.external_id,
        title: task.title,
        description: task.description,
        owner: task.owner,
        priority: task.priority,
        status: task.status,
        due_date: task.due_date,
        verified: task.verified,
      };
    }),
    open_questions: run.questions.map((question) => ({ id: question.id, task_id: question.task_id, prompt: question.prompt, field: question.field })),
    tracking: run.tracking,
    pending_action: run.pending_action,
    platform_context: buildPlatformAgentContext(run),
    user_skills: run.user_skills.filter((skill) => skill.enabled).map((skill) => ({ name: skill.name, markdown: skill.content })),
    recent_conversation: run.conversation.slice(-10).map((item) => ({ role: item.role, content: item.content.slice(0, 600) })),
    user_message: content,
  };
}

async function planWithModel(run: AgentRun, content: string): Promise<ModelPlan> {
  const config = await getModelConfig();
  if (!config) throw new AgentOperationError("请先配置模型 API，再使用 Agent 对话。", 503);
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 0 });
  const context = buildDialogueContext(run, content);
  const systemPrompt = buildDialogueSystemPrompt();
  const userPrompt = JSON.stringify(context);
  const startedAt = Date.now();
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
    trace: { system_prompt: systemPrompt, user_prompt: userPrompt, model_output: raw, duration_ms: Date.now() - startedAt },
  };
}

async function answerPlatformFactsWithModel(run: AgentRun, content: string, toolPlan: PlatformFactsPlan, injectedReply?: ChatDependencies["platformReply"]): Promise<PlatformReply> {
  if (injectedReply) {
    const reply = PlatformReplySchema.parse({ reply: await injectedReply(run, content, toolPlan) }).reply;
    return { reply, trace: { system_prompt: "", user_prompt: "", model_output: "" } };
  }
  const config = await getModelConfig();
  if (!config) throw new AgentOperationError("请先配置模型 API，再使用 Agent 对话。", 503);
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 0 });
  const systemPrompt = [
    "你是会议任务 Agent 的平台工具回复生成器。",
    "你必须只基于调用方提供的 platform_tool_facts 回答用户问题，不得编造当前配置、外部平台状态或未接入能力。",
    "如果 facts 表示不能执行写入或缺少信息，只说明原因和一个最合适的下一步。",
    "面向普通用户表达，不要暴露 tasklistGuid、tasklistConfigured、dueReminderMinutes、syncComments 等内部字段名；除非用户明确要求查看原始字段或 ID。",
    "不要声称已经保存、创建、同步或修改任何内容；写入动作必须由后端确认卡另行执行。",
    "输出合法 JSON：{\"reply\":\"...\"}，不要输出 Markdown。",
  ].join("\n");
  const userPrompt = JSON.stringify({
    user_message: content,
    run_context: buildDialogueContext(run, content),
    platform_context: buildPlatformAgentContext(run),
    platform_tool: {
      action: toolPlan.action,
      metadata: toolPlan.metadata,
      facts: toolPlan.facts,
    },
  });
  const startedAt = Date.now();
  const response = await client.chat.completions.create({
    model: config.model,
    response_format: { type: "json_object" },
    temperature: 0.2,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt },
    ],
  });
  const raw = response.choices[0]?.message?.content;
  if (!raw) throw new Error("Empty model response");
  return {
    reply: PlatformReplySchema.parse(JSON.parse(raw)).reply,
    trace: { system_prompt: systemPrompt, user_prompt: userPrompt, model_output: raw, duration_ms: Date.now() - startedAt },
  };
}

async function appendAssistant(runId: string, content: string, action: string, metadata?: ConversationTurn["metadata"]) {
  return updateAgentStore((store) => {
    const run = store.runs[runId];
    run.conversation.push(turn("assistant", "agent_report", content, action, metadata));
    run.updated_at = new Date().toISOString();
    return run;
  });
}

async function appendUserAndAssistant(runId: string, userContent: string, assistantContent: string, action: string, metadata?: ConversationTurn["metadata"]) {
  return updateAgentStore((store) => {
    const run = store.runs[runId];
    run.conversation.push(turn("user", "message", userContent, "send_message"));
    run.conversation.push(turn("assistant", "agent_report", assistantContent, action, metadata));
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
      ? { plan: PlannedIntentSchema.parse(await dependencies.plan(current, content, buildDialogueContext(current, content))), trace: { system_prompt: "", user_prompt: "", model_output: "" } }
      : await planWithModel(current, content);
  } catch (error) {
    if (error instanceof AgentOperationError) throw error;
    throw new AgentOperationError("Agent 未能理解这条消息，请检查模型连接后重试。", 502);
  }

  const { plan } = planning;
  const modelMetadata: ConversationTurn["metadata"] = {
    agent_source: "model_understanding",
    source_detail: "对话模型规划",
    tool: "dialogue-orchestration",
    model_called: !!planning.trace.model_output,
    ...modelStatsMetadata([planning.trace]),
  };

  const platformToolIntent = platformToolIntentFromPlan(plan);
  const resolvedPlatformToolPlan = platformToolIntent
    ? planPlatformAgentToolFromPlan(current, content, platformToolIntent)
    : { type: "none" as const };

  if (resolvedPlatformToolPlan.type === "facts") {
    let platformReply: PlatformReply;
    try {
      platformReply = await answerPlatformFactsWithModel(current, content, resolvedPlatformToolPlan, dependencies.platformReply);
    } catch (error) {
      if (error instanceof AgentOperationError) throw error;
      throw new AgentOperationError("Agent 未能根据平台信息生成回复，请检查模型连接后重试。", 502);
    }
    const queuedTaskMessage = plan.remaining_user_message.trim();
    let queuedPlanning: ModelPlan | null = null;
    if (queuedTaskMessage) {
      try {
        queuedPlanning = dependencies.plan
          ? { plan: PlannedIntentSchema.parse(await dependencies.plan(current, queuedTaskMessage, buildDialogueContext(current, queuedTaskMessage))), trace: { system_prompt: "", user_prompt: "", model_output: "" } }
          : await planWithModel(current, queuedTaskMessage);
      } catch {
        queuedPlanning = null;
      }
    }
    const queuedPlan = queuedPlanning ? queueablePlan(queuedPlanning.plan) : null;
    const queuedTaskStatusPlan = queuedPlan?.intent === "propose_status"
      ? buildTaskStatusPendingFromPlan(current, queuedPlan)
      : null;
    const queuedTaskReminderPlan = queuedPlan?.intent === "propose_task_reminders"
      ? buildTaskReminderPendingFromPlan(current, queuedPlan)
      : null;
    const queuedTaskCommentPlan = queuedPlan?.intent === "propose_task_comment"
      ? buildTaskCommentPendingFromPlan(current, queuedPlan)
      : null;
    const queuedMetadata = queuedPlan ? queuedPlanMetadata(queuedPlan) : null;
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
      const metadata: ConversationTurn["metadata"] = {
        ...resolvedPlatformToolPlan.metadata,
        agent_source: "platform_tool_with_model",
        source_detail: `${resolvedPlatformToolPlan.metadata?.source_detail || "平台工具事实"} + LLM 回复`,
        model_called: true,
        ...modelStatsMetadata([planning.trace, platformReply.trace, queuedPlanning?.trace]),
      };
      run.conversation.push(turn("user", "message", content, "send_message"));
      run.conversation.push(turn("assistant", "agent_report", platformReply.reply, resolvedPlatformToolPlan.action, metadata));
      if (queuedTaskStatusPlan?.kind === "proposal") {
        run.pending_action = queuedTaskStatusPlan.pending;
        run.conversation.push(turn("assistant", "proposal", queuedTaskStatusPlan.content, "propose_status", queuedMetadata || undefined));
      } else if (queuedTaskStatusPlan?.kind === "reply") {
        run.conversation.push(turn("assistant", "agent_report", `还有一个任务操作没有执行：${queuedTaskStatusPlan.content}`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      } else if (queuedTaskReminderPlan?.kind === "proposal") {
        run.pending_action = {
          id: randomUUID(),
          type: "sync_task_reminders",
          task_id: queuedTaskReminderPlan.task.task_id,
          external_task_id: queuedTaskReminderPlan.task.external_id,
          dueReminderMinutes: queuedTaskReminderPlan.dueReminderMinutes,
          created_at: new Date().toISOString(),
        };
        run.conversation.push(turn("assistant", "proposal", queuedTaskReminderPlan.content, "propose_task_reminders", queuedMetadata || undefined));
      } else if (queuedTaskReminderPlan?.kind === "reply") {
        run.conversation.push(turn("assistant", "agent_report", `还有一个任务操作没有执行：${queuedTaskReminderPlan.content}`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      } else if (queuedTaskCommentPlan?.kind === "proposal") {
        run.pending_action = {
          id: randomUUID(),
          type: "add_task_comment",
          task_id: queuedTaskCommentPlan.task.task_id,
          external_task_id: queuedTaskCommentPlan.task.external_id,
          comment: queuedTaskCommentPlan.comment,
          created_at: new Date().toISOString(),
        };
        run.conversation.push(turn("assistant", "proposal", queuedTaskCommentPlan.content, "propose_task_comment", queuedMetadata || undefined));
      } else if (queuedTaskCommentPlan?.kind === "reply") {
        run.conversation.push(turn("assistant", "agent_report", `还有一个任务操作没有执行：${queuedTaskCommentPlan.content}`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      } else if (queuedPlan?.reply) {
        run.conversation.push(turn("assistant", "agent_report", `还有一个操作没有执行：${queuedPlan.reply}`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      } else if (queuedTaskMessage) {
        run.conversation.push(turn("assistant", "agent_report", `还有一个操作没有执行：我没能把“${queuedTaskMessage}”转换成可确认的任务操作，请重新说明。`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      }
      if (planning.trace.model_output) run.model_interactions.push({
        id: randomUUID(),
        kind: "dialogue",
        at: new Date().toISOString(),
        ...planning.trace,
        normalized_intent: planning.plan.intent,
      });
      if (platformReply.trace.model_output) run.model_interactions.push({
        id: randomUUID(),
        kind: "dialogue",
        at: new Date().toISOString(),
        ...platformReply.trace,
        normalized_intent: `${resolvedPlatformToolPlan.action}:platform_tool_reply`,
      });
      if (queuedPlanning?.trace.model_output) run.model_interactions.push({
        id: randomUUID(),
        kind: "dialogue",
        at: new Date().toISOString(),
        ...queuedPlanning.trace,
        normalized_intent: `${queuedPlanning.plan.intent}:queued_after_platform_fact`,
      });
      run.updated_at = new Date().toISOString();
      return run;
    });
  }
  if (resolvedPlatformToolPlan.type === "proposal") {
    const queuedTaskMessage = plan.remaining_user_message.trim();
    let queuedPlanning: ModelPlan | null = null;
    if (queuedTaskMessage) {
      try {
        queuedPlanning = dependencies.plan
          ? { plan: PlannedIntentSchema.parse(await dependencies.plan(current, queuedTaskMessage, buildDialogueContext(current, queuedTaskMessage))), trace: { system_prompt: "", user_prompt: "", model_output: "" } }
          : await planWithModel(current, queuedTaskMessage);
      } catch {
        queuedPlanning = null;
      }
    }
    const queuedPlan = queuedPlanning ? queueablePlan(queuedPlanning.plan) : null;
    const proposalContent = queuedTaskMessage
      ? `${resolvedPlatformToolPlan.content} 另外我识别到“${queuedTaskMessage}”是第二个操作；确认或取消当前配置后，我会继续处理它，不会直接执行。`
      : resolvedPlatformToolPlan.content;
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
      run.conversation.push(turn("user", "message", content, "send_message"));
      run.pending_action = {
        id: randomUUID(),
        type: "update_feishu_settings",
        changes: resolvedPlatformToolPlan.changes,
        expected: resolvedPlatformToolPlan.expected,
        ...(queuedTaskMessage ? { queued_message: queuedTaskMessage, queued_summary: queuedTaskMessage } : {}),
        ...(queuedPlan ? { queued_plan: queuedPlan } : {}),
        created_at: new Date().toISOString(),
      };
      run.conversation.push(turn("assistant", "proposal", proposalContent, resolvedPlatformToolPlan.action, {
        ...resolvedPlatformToolPlan.metadata,
        ...modelStatsMetadata([planning.trace, queuedPlanning?.trace]),
      }));
      if (planning.trace.model_output) run.model_interactions.push({
        id: randomUUID(),
        kind: "dialogue",
        at: new Date().toISOString(),
        ...planning.trace,
        normalized_intent: planning.plan.intent,
      });
      if (queuedPlanning?.trace.model_output) run.model_interactions.push({
        id: randomUUID(),
        kind: "dialogue",
        at: new Date().toISOString(),
        ...queuedPlanning.trace,
        normalized_intent: `${queuedPlanning.plan.intent}:queued_after_platform`,
      });
      run.updated_at = new Date().toISOString();
      return run;
    });
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

  if (plan.intent === "answer_questions") {
    if (!plan.question_answers.length || plan.question_answers.some((item) => !current.questions.some((question) => question.id === item.questionId))) {
      return appendAssistant(runId, "我没能把这条回答对应到当前待确认问题，请指出具体问题或使用澄清表单。", "clarification_needs_detail", modelMetadata);
    }
    try {
      return await answerAgentQuestions(runId, { answers: plan.question_answers }, {}, { recordQuestionTurns: false, source: "chat" });
    } catch (error) {
      if (!(error instanceof AgentOperationError) && !(error instanceof z.ZodError)) throw error;
      return appendAssistant(runId, error instanceof AgentOperationError ? error.message : "回答格式无效，请重新说明。", "clarification_needs_detail", modelMetadata);
    }
  }

  if (plan.intent === "refresh_tracking") {
    if (current.state !== "tracking" && current.state !== "completed") {
      return appendAssistant(runId, "当前尚未进入任务追踪；请先完成澄清和人工审批。", "tracking_unavailable", modelMetadata);
    }
    await refreshTracking(runId, "chat");
    return (await getAgentRun(runId))!;
  }

  if (plan.intent === "propose_status") {
    const task = current.created_tasks.find((item) => item.external_id === plan.external_task_id && item.verified);
    if (current.state !== "tracking" || !task || !plan.status) {
      return appendAssistant(runId, "我无法唯一定位一个可追踪任务，请说明任务名称和目标状态。", "status_needs_detail", modelMetadata);
    }
    if (task.status === plan.status) {
      return appendAssistant(runId, `“${task.title}”目前已经是该状态，无需重复修改。`, "status_unchanged", modelMetadata);
    }
    const connector = getTaskConnector(current.connector_id);
    if (!connector.capabilities.updateStatus) {
      return appendAssistant(runId, `${connector.name} 当前不支持在系统内同步任务状态。`, "status_unsupported", modelMetadata);
    }
    if (connector.capabilities.statusValues?.length && !connector.capabilities.statusValues.includes(plan.status)) {
      const target = plan.status === "in_progress" ? "进行中" : plan.status === "done" ? "已完成" : "待开始";
      return appendAssistant(runId, `${connector.name} 不能同步为“${target}”；这个平台当前只支持同步为${supportedStatusLabels(connector.capabilities.statusValues)}。`, "status_unsupported", modelMetadata);
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
      run.conversation.push(turn("assistant", "proposal", `准备将“${task.title}”改为${target}，请确认后执行。`, "propose_status", modelMetadata));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  if (plan.intent === "propose_task_reminders") {
    const reminderPlan = buildTaskReminderPendingFromPlan(current, plan);
    if (!reminderPlan) {
      return appendAssistant(runId, "当前任务平台不支持在系统内同步单个任务提醒。", "task_reminder_unsupported", modelMetadata);
    }
    if (reminderPlan.kind === "reply") {
      return appendAssistant(runId, reminderPlan.content, "task_reminder_needs_detail", modelMetadata);
    }
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
      run.pending_action = {
        id: randomUUID(),
        type: "sync_task_reminders",
        task_id: reminderPlan.task.task_id,
        external_task_id: reminderPlan.task.external_id,
        dueReminderMinutes: reminderPlan.dueReminderMinutes,
        created_at: new Date().toISOString(),
      };
      run.conversation.push(turn("assistant", "proposal", reminderPlan.content, "propose_task_reminders", modelMetadata));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  if (plan.intent === "propose_task_comment") {
    const commentPlan = buildTaskCommentPendingFromPlan(current, plan);
    if (commentPlan.kind === "reply") {
      return appendAssistant(runId, commentPlan.content, "task_comment_needs_detail", modelMetadata);
    }
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action) throw new AgentOperationError("请先确认或取消当前待执行操作。", 409);
      run.pending_action = {
        id: randomUUID(),
        type: "add_task_comment",
        task_id: commentPlan.task.task_id,
        external_task_id: commentPlan.task.external_id,
        comment: commentPlan.comment,
        created_at: new Date().toISOString(),
      };
      run.conversation.push(turn("assistant", "proposal", commentPlan.content, "propose_task_comment", modelMetadata));
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
      return appendAssistant(runId, "无法定位当前阶段可修改的唯一任务。请说明任务名称和要修改的字段。", "task_edit_needs_detail", modelMetadata);
    }
    if (changes.due_date && !explicitlyNamesDate(content, changes.due_date)) {
      return appendAssistant(runId, "请提供完整的截止日期（年、月、日），我不会替你补全缺失的日期。", "task_edit_needs_date", modelMetadata);
    }
    if (current.state === "tracking" && current.connector_id === "feishu" && fields.includes("owner")) {
      return appendAssistant(runId, "飞书任务负责人需要通过成员增删接口调整，本阶段暂不支持从系统内修改负责人。可以先修改标题、描述、截止日期或优先级。", "task_edit_unsupported", modelMetadata);
    }
    const expected = Object.fromEntries(fields.map((field) => [field, task[field]])) as TaskFieldChanges;
    if (fields.every((field) => changes[field] === expected[field])) {
      return appendAssistant(runId, `“${task.title}”的这些字段已经是目标值，无需重复修改。`, "task_edit_unchanged", modelMetadata);
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
      run.conversation.push(turn("assistant", "proposal", `准备修改“${task.title}”：${summary}。请确认后执行。`, "propose_task_edit", modelMetadata));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  return appendAssistant(runId, plan.reply, plan.intent, modelMetadata);
}

export async function confirmAgentAction(runId: string, input: unknown) {
  const { actionId, approved } = ConfirmAgentActionSchema.parse(input);
  const current = await getAgentRun(runId);
  if (!current) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);
  const pending = current.pending_action;
  if (!pending || pending.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);

  if (pending.type === "update_feishu_settings") {
    const platformMetadata: ConversationTurn["metadata"] = {
      agent_source: "platform_tool",
      source_detail: "平台配置写入",
      platform: "feishu",
      tool: "updatePlatformSettings",
      model_called: false,
    };
    if (!approved) {
      return updateAgentStore((store) => {
        const run = store.runs[runId];
        if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
        run.pending_action = null;
        run.conversation.push(turn("user", "message", "取消此平台配置修改。", "cancel_action"));
        run.conversation.push(turn("assistant", "agent_report", "已取消，飞书写入设置没有改变。", "cancel_action", platformMetadata));
        run.updated_at = new Date().toISOString();
        return run;
      });
    }
    const config = getFeishuConfig();
    if (!config) throw new AgentOperationError("飞书应用尚未配置，暂时不能修改飞书写入设置。", 409);
    const latest = {
      tasklistGuid: config.tasklistGuid,
      tasklistSectionGuid: config.tasklistSectionGuid,
      dueReminderMinutes: config.dueReminderMinutes,
      syncComments: config.syncComments,
    };
    if ((Object.keys(pending.expected) as Array<keyof FeishuSettingsChangeSet>)
      .some((field) => !sameFeishuSettingValue(field, latest[field], pending.expected[field]))) {
      return updateAgentStore((store) => {
        const run = store.runs[runId];
        if (run.pending_action?.id === actionId) run.pending_action = null;
        run.conversation.push(turn("assistant", "agent_report", "飞书写入设置已经变化，本次确认未执行。请重新发起。", "stale_action", platformMetadata));
        run.updated_at = new Date().toISOString();
        return run;
      });
    }
    const nextTasklistGuid = "tasklistGuid" in pending.changes ? pending.changes.tasklistGuid ?? null : config.tasklistGuid;
    await updateFeishuAdvancedSettings({
      tasklistGuid: nextTasklistGuid,
      tasklistSectionGuid: nextTasklistGuid
        ? ("tasklistSectionGuid" in pending.changes ? pending.changes.tasklistSectionGuid ?? null : config.tasklistSectionGuid)
        : null,
      dueReminderMinutes: "dueReminderMinutes" in pending.changes ? pending.changes.dueReminderMinutes || [] : config.dueReminderMinutes,
      syncComments: "syncComments" in pending.changes ? pending.changes.syncComments === true : config.syncComments,
    });
    const existingSync = await syncExistingFeishuTasksAfterSettingsChange(current, pending.changes);
    const queuedTaskStatusPlan = pending.queued_plan?.intent === "propose_status"
      ? buildTaskStatusPendingFromPlan(current, pending.queued_plan)
      : null;
    const queuedTaskReminderPlan = pending.queued_plan?.intent === "propose_task_reminders"
      ? buildTaskReminderPendingFromPlan(current, pending.queued_plan)
      : null;
    const queuedTaskCommentPlan = pending.queued_plan?.intent === "propose_task_comment"
      ? buildTaskCommentPendingFromPlan(current, pending.queued_plan)
      : null;
    const queuedMetadata = pending.queued_plan ? queuedPlanMetadata(pending.queued_plan) : null;
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
      run.pending_action = null;
      run.conversation.push(turn("user", "message", "确认保存此平台配置。", "confirm_action"));
      const reminderBoundary = "dueReminderMinutes" in pending.changes
        ? " 这不会修改飞书客户端里的任务默认提醒时间；只影响本系统之后创建或同步的飞书任务。"
        : "";
      run.conversation.push(turn("assistant", "agent_report", `已更新飞书写入设置：${summarizeFeishuSettingsChanges(pending.changes)}。之后本系统新创建、状态同步和字段修改会按这个设置执行。${formatExistingFeishuSyncSummary(existingSync)}${reminderBoundary}`, "update_platform_setting", platformMetadata));
      if (queuedTaskStatusPlan?.kind === "proposal") {
        run.pending_action = queuedTaskStatusPlan.pending;
        run.conversation.push(turn("assistant", "proposal", queuedTaskStatusPlan.content, "propose_status", queuedMetadata || undefined));
      } else if (queuedTaskStatusPlan?.kind === "reply") {
        run.conversation.push(turn("assistant", "agent_report", `还有一个任务操作没有执行：${queuedTaskStatusPlan.content}`, "queued_task_operation_unavailable", {
          ...(queuedMetadata || {}),
        }));
      } else if (queuedTaskReminderPlan?.kind === "proposal") {
        run.pending_action = {
          id: randomUUID(),
          type: "sync_task_reminders",
          task_id: queuedTaskReminderPlan.task.task_id,
          external_task_id: queuedTaskReminderPlan.task.external_id,
          dueReminderMinutes: queuedTaskReminderPlan.dueReminderMinutes,
          created_at: new Date().toISOString(),
        };
        run.conversation.push(turn("assistant", "proposal", queuedTaskReminderPlan.content, "propose_task_reminders", queuedMetadata || undefined));
      } else if (queuedTaskReminderPlan?.kind === "reply") {
        run.conversation.push(turn("assistant", "agent_report", `还有一个任务操作没有执行：${queuedTaskReminderPlan.content}`, "queued_task_operation_unavailable", {
          ...(queuedMetadata || {}),
        }));
      } else if (queuedTaskCommentPlan?.kind === "proposal") {
        run.pending_action = {
          id: randomUUID(),
          type: "add_task_comment",
          task_id: queuedTaskCommentPlan.task.task_id,
          external_task_id: queuedTaskCommentPlan.task.external_id,
          comment: queuedTaskCommentPlan.comment,
          created_at: new Date().toISOString(),
        };
        run.conversation.push(turn("assistant", "proposal", queuedTaskCommentPlan.content, "propose_task_comment", queuedMetadata || undefined));
      } else if (queuedTaskCommentPlan?.kind === "reply") {
        run.conversation.push(turn("assistant", "agent_report", `还有一个任务操作没有执行：${queuedTaskCommentPlan.content}`, "queued_task_operation_unavailable", {
          ...(queuedMetadata || {}),
        }));
      } else if (pending.queued_plan?.reply) {
        run.conversation.push(turn("assistant", "agent_report", `还有一个操作没有执行：${pending.queued_plan.reply}`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      } else if (pending.queued_message) {
        run.conversation.push(turn("assistant", "agent_report", `还有一个操作没有执行：我没能把“${pending.queued_message}”转换成可确认的任务操作，请重新说明。`, "queued_task_operation_unavailable", queuedMetadata || undefined));
      }
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  if (pending.type === "sync_task_reminders") {
    const platformMetadata: ConversationTurn["metadata"] = {
      agent_source: "platform_tool",
      source_detail: "任务级飞书提醒同步",
      platform: "feishu",
      tool: "syncTaskReminders",
      model_called: false,
    };
    if (!approved) {
      return updateAgentStore((store) => {
        const run = store.runs[runId];
        if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
        run.pending_action = null;
        run.conversation.push(turn("user", "message", "取消此任务提醒修改。", "cancel_action"));
        run.conversation.push(turn("assistant", "agent_report", "已取消，这个飞书任务的提醒没有改变。", "cancel_action", platformMetadata));
        run.updated_at = new Date().toISOString();
        return run;
      });
    }
    if (current.connector_id !== "feishu") throw new AgentOperationError("当前运行不是飞书任务，不能同步飞书提醒。", 409);
    const taskRecord = current.created_tasks.find((task) => task.external_id === pending.external_task_id && task.verified);
    if (!taskRecord) throw new AgentOperationError("找不到这个已创建并验证过的飞书任务。", 409);
    const connector = getTaskConnector(current.connector_id);
    if (!connector.syncTaskSettings) throw new AgentOperationError(`${connector.name} 当前不支持同步任务提醒。`, 409);
    const result = await connector.syncTaskSettings(pending.external_task_id, { dueReminderMinutes: pending.dueReminderMinutes });
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
      run.pending_action = null;
      const latestRecord = run.created_tasks.find((task) => task.external_id === pending.external_task_id);
      if (latestRecord && result.task) {
        latestRecord.title = result.task.title;
        latestRecord.description = result.task.description;
        latestRecord.owner = result.task.owner;
        latestRecord.due_date = result.task.due_date;
        latestRecord.priority = result.task.priority;
        latestRecord.priority_reason = result.task.priority_reason;
        latestRecord.priority_evidence = result.task.priority_evidence;
        latestRecord.status = result.task.status;
        latestRecord.external_url = result.task.external_url ?? latestRecord.external_url;
        latestRecord.issues = result.issues;
      }
      run.conversation.push(turn("user", "message", "确认同步此任务提醒。", "confirm_action"));
      const issueText = result.issues.length ? ` 同步边界提示：${result.issues.join("；")}` : "";
      const actionText = result.applied.includes("reminders") ? "已同步" : "已检查";
      run.conversation.push(turn("assistant", "agent_report", `${actionText}“${taskRecord.title}”的到期提醒：${formatReminderMinutes(pending.dueReminderMinutes)}。这只影响这个飞书任务，不改变平台连接里的新建任务提醒规则。${issueText}`, "sync_task_reminders", platformMetadata));
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

  if (pending.type === "add_task_comment") {
    const platformMetadata: ConversationTurn["metadata"] = {
      agent_source: "platform_tool",
      source_detail: "任务级评论写入",
      platform: current.connector_id,
      tool: "addTaskComment",
      model_called: false,
    };
    if (!approved) {
      return updateAgentStore((store) => {
        const run = store.runs[runId];
        if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
        run.pending_action = null;
        run.conversation.push(turn("user", "message", "取消此任务评论。", "cancel_action"));
        run.conversation.push(turn("assistant", "agent_report", "已取消，没有向外部任务写入评论。", "cancel_action", platformMetadata));
        run.updated_at = new Date().toISOString();
        return run;
      });
    }
    const taskRecord = current.created_tasks.find((task) => task.external_id === pending.external_task_id && task.task_id === pending.task_id && task.verified);
    if (!taskRecord) throw new AgentOperationError("找不到这个已创建并验证过的任务。", 409);
    const connector = getTaskConnector(current.connector_id);
    if (!connector.addComment) throw new AgentOperationError(`${connector.name} 当前不支持从系统内给单个任务追加评论。`, 409);
    const result = await connector.addComment(pending.external_task_id, pending.comment);
    return updateAgentStore((store) => {
      const run = store.runs[runId];
      if (run.pending_action?.id !== actionId) throw new AgentOperationError("待确认操作已失效，请重新发起。", 409);
      run.pending_action = null;
      const latestRecord = run.created_tasks.find((task) => task.external_id === pending.external_task_id && task.task_id === pending.task_id);
      if (latestRecord) {
        if (result.task) {
          latestRecord.title = result.task.title;
          latestRecord.description = result.task.description;
          latestRecord.owner = result.task.owner;
          latestRecord.due_date = result.task.due_date;
          latestRecord.priority = result.task.priority;
          latestRecord.priority_reason = result.task.priority_reason;
          latestRecord.priority_evidence = result.task.priority_evidence;
          latestRecord.status = result.task.status;
          latestRecord.external_url = result.task.external_url ?? latestRecord.external_url;
        }
        const existingNonCommentIssues = latestRecord.issues.filter((issue) => !isCommentPermissionIssue(issue));
        latestRecord.issues = [...new Set([...existingNonCommentIssues, ...result.issues])];
      }
      run.conversation.push(turn("user", "message", "确认发送此任务评论。", "confirm_action"));
      if (result.issues.length) {
        run.conversation.push(turn("assistant", "agent_report", `评论没有写入“${taskRecord.title}”：${result.issues.join("；")} 请按平台连接里的权限提示配置后再重试。`, "add_task_comment_failed", platformMetadata));
      } else {
        run.conversation.push(turn("assistant", "agent_report", `已在“${taskRecord.title}”下追加评论：${pending.comment}`, "add_task_comment", platformMetadata));
        run.events.push({
          id: randomUUID(),
          type: "tool_result",
          message: `已向“${taskRecord.title}”追加一条评论。`,
          at: new Date().toISOString(),
          actor: "tool",
          source: "connector",
          action: "add_task_comment",
          entity_type: "task",
          entity_id: pending.task_id,
          metadata: { external_id: pending.external_task_id },
        });
      }
      run.updated_at = new Date().toISOString();
      return run;
    });
  }

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

  const connector = getTaskConnector(current.connector_id);
  const external = approved ? await connector.getTask(pending.external_task_id) : null;
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

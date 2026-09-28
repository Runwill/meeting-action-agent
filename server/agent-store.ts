import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { getPromptSkillVersions, type PromptSkillVersions } from "./prompt-skills.ts";
import { UserSkillSchema, legacyContextToSkill, listUserSkills, saveUserSkills, type UserSkill } from "./user-skills.ts";
import { TeamContextSchema, type TeamContext } from "./team-context.ts";

export type AgentState = "analyzing" | "clarifying" | "awaiting_approval" | "executing" | "verifying" | "tracking" | "completed" | "failed";
export type AgentQuestionField = "owner" | "due_date" | "confirm" | "general" | "priority";
export type ConnectorId = "local-task" | "feishu";

export type AgentEvent = {
  id: string;
  type: "analysis" | "question" | "answer" | "plan" | "approval" | "tool_call" | "tool_result" | "verification" | "tracking" | "status_change" | "task_edit" | "overdue" | "error";
  message: string;
  at: string;
  metadata?: Record<string, string | number | boolean | null>;
  actor?: "user" | "agent" | "system" | "tool";
  source?: "runtime" | "chat" | "quick_action" | "model" | "connector";
  action?: string;
  entity_type?: "run" | "task" | "open_item";
  entity_id?: string;
  before?: Record<string, string | number | boolean | null>;
  after?: Record<string, string | number | boolean | null>;
};

export type AgentQuestion = {
  id: string;
  task_id: string | null;
  field: AgentQuestionField;
  prompt: string;
  input_type: "text" | "date" | "confirm" | "priority";
  answer: string | null;
  open_item_id?: string;
};

export type OpenItem = {
  id: string;
  kind: "clarification" | "follow_up";
  task_id: string | null;
  question_id: string | null;
  prompt: string;
  status: "open" | "resolved" | "dismissed";
  answer: string | null;
  resolution: string | null;
  created_at: string;
  resolved_at: string | null;
};

export type ConversationTurn = {
  id: string;
  role: "user" | "assistant" | "tool";
  kind: "meeting_submission" | "clarification" | "approval" | "status_update" | "tracking" | "agent_report" | "message" | "proposal";
  content: string;
  at: string;
  action?: string;
  task_id?: string | null;
  open_item_id?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
};

export type TaskFieldChanges = Partial<Pick<AgentTask, "title" | "description" | "owner" | "due_date" | "priority">>;
export type FeishuSettingsChangeSet = Partial<{
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  dueReminderMinutes: number[];
  syncComments: boolean;
}>;

export type QueuedAgentPlan = {
  intent: "propose_status" | "propose_task_edit" | "propose_task_reminders" | "propose_task_comment" | "explain" | "unsure";
  external_task_id: string | null;
  status: "todo" | "in_progress" | "done" | null;
  task_id: string | null;
  field_changes: TaskFieldChanges;
  due_reminder_minutes: number[];
  comment: string;
  reply: string;
};

export type PendingAgentAction = {
  id: string;
  type: "set_task_status";
  external_task_id: string;
  status: "todo" | "in_progress" | "done";
  expected_status: "todo" | "in_progress" | "done";
  created_at: string;
} | {
  id: string;
  type: "edit_task";
  task_id: string;
  external_task_id: string | null;
  changes: TaskFieldChanges;
  expected: TaskFieldChanges;
  created_at: string;
} | {
  id: string;
  type: "update_feishu_settings";
  changes: FeishuSettingsChangeSet;
  expected: FeishuSettingsChangeSet;
  queued_message?: string;
  queued_summary?: string;
  queued_plan?: QueuedAgentPlan;
  created_at: string;
} | {
  id: string;
  type: "sync_task_reminders";
  task_id: string;
  external_task_id: string;
  dueReminderMinutes: number[];
  created_at: string;
} | {
  id: string;
  type: "add_task_comment";
  task_id: string;
  external_task_id: string;
  comment: string;
  created_at: string;
};

export type ModelInteraction = {
  id: string;
  kind: "dialogue";
  at: string;
  system_prompt: string;
  user_prompt: string;
  model_output: string;
  normalized_intent: string;
  duration_ms?: number;
};

export type ClarificationHistoryEntry = {
  id: string;
  question_id: string;
  task_id: string | null;
  field: AgentQuestionField;
  prompt: string;
  input_type: AgentQuestion["input_type"];
  answer: string;
  outcome: "updated" | "confirmed" | "rejected_task" | "supplemented" | "priority_adjusted";
  at: string;
};

export type AgentTask = {
  id: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  priority_reason: string;
  priority_evidence: string | null;
  priority_conflict: boolean;
  status: "todo" | "in_progress" | "done";
  evidence: string;
  dependencies: string[];
  risk: string | null;
  confidence: number;
};

export type AgentAnalysis = {
  meeting_title: string;
  meeting_date: string | null;
  summary: string;
  attendees: string[];
  decisions: string[];
  tasks: AgentTask[];
  follow_ups: string[];
  engine: "ai" | "local";
  fallback_reason?: "model_failed";
};

export type AnalysisTrace = {
  system_prompt: string;
  user_prompt: string;
  model_output: string;
  prompt_modules: Array<{ name: string; version: string; purpose: string }>;
  normalized_output?: AgentAnalysis;
};

export type CreatedTaskRecord = {
  task_id: string;
  external_id: string;
  external_url?: string | null;
  connector_id: ConnectorId;
  connector_name: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  priority_reason: string;
  priority_evidence: string | null;
  status: "todo" | "in_progress" | "done";
  evidence: string;
  dependencies: string[];
  risk: string | null;
  reused: boolean;
  verified: boolean;
  issues: string[];
};

export type TrackingSummary = {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  overdue: number;
  checked_at: string;
};

export type AgentRun = {
  id: string;
  connector_id: ConnectorId;
  state: AgentState;
  analysis: AgentAnalysis;
  questions: AgentQuestion[];
  open_items: OpenItem[];
  clarification_history: ClarificationHistoryEntry[];
  approved_task_ids: string[];
  approval_signature?: string;
  created_tasks: CreatedTaskRecord[];
  tracking: TrackingSummary | null;
  events: AgentEvent[];
  conversation: ConversationTurn[];
  model_interactions: ModelInteraction[];
  pending_action: PendingAgentAction | null;
  overdue_task_ids: string[];
  skill_versions: PromptSkillVersions;
  user_skills: UserSkill[];
  /** @deprecated test/migration compatibility; user-facing analysis uses user_skills. */
  team_context?: TeamContext;
  original_notes: string;
  meeting_date?: string;
  instruction?: string;
  analysis_trace?: AnalysisTrace;
  created_at: string;
  updated_at: string;
};

export type ExternalTask = {
  id: string;
  external_url?: string | null;
  connector_id: ConnectorId;
  idempotency_key: string;
  source_run_id: string;
  source_task_id: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  priority_reason: string;
  priority_evidence: string | null;
  status: "todo" | "in_progress" | "done";
  evidence: string;
  dependencies: string[];
  risk: string | null;
  created_at: string;
  updated_at: string;
};

export type StoreData = {
  schema_version: 5;
  /** @deprecated legacy compatibility only. */
  legacy_team_context?: TeamContext;
  runs: Record<string, AgentRun>;
  tasks: Record<string, ExternalTask>;
};

const defaultStorePath = process.env.AGENT_STORE_PATH?.trim() || path.resolve(process.cwd(), "data/agent-store.json");
let activeStorePath = defaultStorePath;
let data: StoreData | null = null;
let loadPromise: Promise<StoreData> | null = null;
let writeQueue: Promise<void> = Promise.resolve();

function emptyStore(): StoreData {
  return {
    schema_version: 5,
    legacy_team_context: undefined,
    runs: {},
    tasks: {},
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function legacyPriorityReason(priority: unknown) {
  if (priority === "high") return "由旧版记录迁移：原任务标记为高优先级。";
  if (priority === "low") return "由旧版记录迁移：原任务标记为低优先级。";
  return "由旧版记录迁移：原任务使用默认中优先级。";
}

function migrateTask(value: unknown): AgentTask {
  if (!isRecord(value)) throw new Error("任务存储格式无效。");
  return {
    ...(value as Omit<AgentTask, "priority_reason" | "priority_evidence" | "priority_conflict">),
    priority_reason: typeof value.priority_reason === "string" && value.priority_reason ? value.priority_reason : legacyPriorityReason(value.priority),
    priority_evidence: typeof value.priority_evidence === "string" ? value.priority_evidence : null,
    priority_conflict: value.priority_conflict === true,
  };
}

function migrateExternalTask(value: unknown): ExternalTask {
  if (!isRecord(value)) throw new Error("外部任务存储格式无效。");
  const connectorId = value.connector_id === "feishu" ? "feishu" : "local-task";
  const status = connectorId === "feishu" && value.status === "todo" ? "in_progress" : value.status;
  return {
    ...(value as Omit<ExternalTask, "connector_id" | "priority_reason" | "priority_evidence" | "dependencies" | "risk">),
    external_url: typeof value.external_url === "string" ? value.external_url : null,
    connector_id: connectorId,
    status: status === "done" || status === "in_progress" ? status : "todo",
    priority_reason: typeof value.priority_reason === "string" && value.priority_reason ? value.priority_reason : legacyPriorityReason(value.priority),
    priority_evidence: typeof value.priority_evidence === "string" ? value.priority_evidence : null,
    dependencies: Array.isArray(value.dependencies) ? value.dependencies.filter((item): item is string => typeof item === "string") : [],
    risk: typeof value.risk === "string" ? value.risk : null,
  };
}

function migrateCreatedTask(value: unknown, source: AgentTask | undefined, connectorId: ConnectorId): CreatedTaskRecord {
  if (!isRecord(value)) throw new Error("创建结果存储格式无效。");
  const recordConnectorId = value.connector_id === "feishu" ? "feishu" : connectorId;
  const status = recordConnectorId === "feishu" && value.status === "todo" ? "in_progress" : value.status;
  return {
    ...(value as Pick<CreatedTaskRecord, "task_id" | "external_id" | "title" | "owner" | "due_date" | "status" | "verified" | "issues">),
    external_url: typeof value.external_url === "string" ? value.external_url : null,
    connector_id: recordConnectorId,
    connector_name: typeof value.connector_name === "string" && value.connector_name
      ? value.connector_name
      : recordConnectorId === "feishu" ? "飞书任务" : "Local Task Hub",
    status: status === "done" || status === "in_progress" ? status : "todo",
    description: typeof value.description === "string" ? value.description : source?.description || "",
    priority: value.priority === "high" || value.priority === "low" ? value.priority : source?.priority || "medium",
    priority_reason: typeof value.priority_reason === "string" ? value.priority_reason : source?.priority_reason || legacyPriorityReason(value.priority),
    priority_evidence: typeof value.priority_evidence === "string" ? value.priority_evidence : source?.priority_evidence || null,
    evidence: typeof value.evidence === "string" ? value.evidence : source?.evidence || "",
    dependencies: Array.isArray(value.dependencies) ? value.dependencies.filter((item): item is string => typeof item === "string") : source?.dependencies || [],
    risk: typeof value.risk === "string" ? value.risk : source?.risk || null,
    reused: value.reused === true,
  };
}

function migrateRun(value: unknown): AgentRun {
  if (!isRecord(value) || !isRecord(value.analysis)) throw new Error("Agent 运行记录格式无效。");
  const tasks = Array.isArray(value.analysis.tasks) ? value.analysis.tasks.map(migrateTask) : [];
  const userSkills = Array.isArray(value.user_skills)
    ? value.user_skills.map((skill) => UserSkillSchema.parse(skill))
    : legacyContextToSkill(value.team_context);
  const skillVersions = { ...getPromptSkillVersions(), ...(isRecord(value.skill_versions) ? value.skill_versions : {}) } as PromptSkillVersions;
  const clarificationHistory = Array.isArray(value.clarification_history) ? value.clarification_history as ClarificationHistoryEntry[] : [];
  const questions = Array.isArray(value.questions)
    ? value.questions.filter(isRecord).map((question) => ({ ...question, answer: typeof question.answer === "string" ? question.answer : null })) as AgentQuestion[]
    : [];
  const now = typeof value.created_at === "string" ? value.created_at : new Date().toISOString();
  const openItems = Array.isArray(value.open_items)
    ? value.open_items.filter(isRecord).map((item) => ({
      ...item,
      answer: typeof item.answer === "string" ? item.answer : null,
      resolution: typeof item.resolution === "string" ? item.resolution : null,
      resolved_at: typeof item.resolved_at === "string" ? item.resolved_at : null,
    })) as OpenItem[]
    : [
      ...clarificationHistory.map((item) => ({
        id: item.question_id,
        kind: "clarification" as const,
        task_id: item.task_id,
        question_id: item.question_id,
        prompt: item.prompt,
        status: item.outcome === "rejected_task" ? "dismissed" as const : "resolved" as const,
        answer: item.answer,
        resolution: item.outcome,
        created_at: now,
        resolved_at: item.at,
      })),
      ...questions
        .filter((question) => !clarificationHistory.some((item) => item.question_id === question.id))
        .map((question) => ({
          id: question.open_item_id || question.id,
          kind: "clarification" as const,
          task_id: question.task_id,
          question_id: question.id,
          prompt: question.prompt,
          status: "open" as const,
          answer: null,
          resolution: null,
          created_at: now,
          resolved_at: null,
        })),
    ];
  const connectorId: ConnectorId = value.connector_id === "feishu" ? "feishu" : "local-task";
  const createdTasks = Array.isArray(value.created_tasks)
    ? value.created_tasks.map((record) => migrateCreatedTask(record, tasks.find((task) => isRecord(record) && task.id === record.task_id), connectorId))
    : [];
  const trace = isRecord(value.analysis_trace)
    && typeof value.analysis_trace.system_prompt === "string"
    && typeof value.analysis_trace.user_prompt === "string"
    && typeof value.analysis_trace.model_output === "string"
    && Array.isArray(value.analysis_trace.prompt_modules)
    ? value.analysis_trace as unknown as AnalysisTrace
    : undefined;

  return {
    ...(value as unknown as AgentRun),
    connector_id: connectorId,
    analysis: {
      ...(value.analysis as unknown as AgentAnalysis),
      tasks,
      follow_ups: openItems.filter((item) => item.status === "open").map((item) => item.prompt),
    },
    questions: questions.map((question) => ({ ...question, open_item_id: question.open_item_id || question.id })),
    open_items: openItems,
    clarification_history: clarificationHistory,
    approved_task_ids: Array.isArray(value.approved_task_ids) ? value.approved_task_ids.filter((item): item is string => typeof item === "string") : [],
    created_tasks: createdTasks,
    tracking: isRecord(value.tracking) ? value.tracking as unknown as TrackingSummary : null,
    events: Array.isArray(value.events) ? value.events as AgentEvent[] : [],
    conversation: Array.isArray(value.conversation) ? value.conversation as ConversationTurn[] : [],
    model_interactions: Array.isArray(value.model_interactions) ? value.model_interactions as ModelInteraction[] : [],
    pending_action: isRecord(value.pending_action) && (value.pending_action.type === "set_task_status" || value.pending_action.type === "edit_task" || value.pending_action.type === "update_feishu_settings" || value.pending_action.type === "sync_task_reminders" || value.pending_action.type === "add_task_comment")
      ? value.pending_action as PendingAgentAction : null,
    overdue_task_ids: Array.isArray(value.overdue_task_ids) ? value.overdue_task_ids.filter((item): item is string => typeof item === "string") : [],
    skill_versions: skillVersions,
    user_skills: userSkills,
    ...(value.team_context && typeof value.team_context === "object" ? { team_context: value.team_context as TeamContext } : {}),
    ...(trace ? { analysis_trace: trace } : {}),
  };
}

function migrateStore(value: unknown): StoreData {
  if (!isRecord(value)) throw new Error("Agent 存储文件格式无效。");
  const rawRuns = isRecord(value.runs) ? value.runs : {};
  const rawTasks = isRecord(value.tasks) ? value.tasks : {};
  return {
    schema_version: 5,
    ...(value.legacy_team_context && typeof value.legacy_team_context === "object" ? { legacy_team_context: value.legacy_team_context as TeamContext } : {}),
    runs: Object.fromEntries(Object.entries(rawRuns).map(([id, run]) => [id, migrateRun(run)])),
    tasks: Object.fromEntries(Object.entries(rawTasks).map(([id, task]) => [id, migrateExternalTask(task)])),
  };
}

async function loadStore() {
  if (data) return data;
  if (!loadPromise) {
    loadPromise = (async () => {
      try {
        data = migrateStore(JSON.parse(await readFile(activeStorePath, "utf8")));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        data = emptyStore();
      }
      return data;
    })();
  }
  try {
    return await loadPromise;
  } finally {
    loadPromise = null;
  }
}

async function persistStore() {
  const snapshot = JSON.stringify(data, null, 2);
  const targetPath = activeStorePath;
  const temporaryPath = `${targetPath}.tmp`;
  const operation = writeQueue.catch(() => undefined).then(async () => {
    await mkdir(path.dirname(targetPath), { recursive: true });
    await writeFile(temporaryPath, snapshot, "utf8");
    await rename(temporaryPath, targetPath);
  });
  writeQueue = operation;
  await operation;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export async function readAgentStore<T>(reader: (store: StoreData) => T) {
  return clone(reader(await loadStore()));
}

export async function updateAgentStore<T>(updater: (store: StoreData) => T) {
  const result = updater(await loadStore());
  await persistStore();
  return clone(result);
}

export async function resetAgentStoreForTests(storeFilePath: string) {
  await loadPromise?.catch(() => undefined);
  await writeQueue.catch(() => undefined);
  activeStorePath = path.resolve(storeFilePath);
  data = emptyStore();
  loadPromise = null;
  writeQueue = Promise.resolve();
  await persistStore();
}

export async function reloadAgentStoreForTests() {
  await loadPromise?.catch(() => undefined);
  await writeQueue.catch(() => undefined);
  data = null;
  loadPromise = null;
}

// Deprecated compatibility surface for deterministic tests and old local records.
// User-facing APIs use /api/user-skills and Markdown files instead.
export async function getTeamContext() {
  return readAgentStore((store) => store.legacy_team_context ?? TeamContextSchema.parse({ members: [], terminology: [], defaults: { timezone: "Asia/Shanghai" }, customGuidance: "" }));
}

export async function saveTeamContext(input: unknown) {
  const context = TeamContextSchema.parse(input);
  await saveUserSkills({ skills: legacyContextToSkill(context) });
  return updateAgentStore((store) => { store.legacy_team_context = context; return context; });
}

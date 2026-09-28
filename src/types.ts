export type Priority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in_progress" | "done";
export type AgentState =
  | "analyzing"
  | "clarifying"
  | "awaiting_approval"
  | "executing"
  | "verifying"
  | "tracking"
  | "completed"
  | "failed";

export interface ActionTask {
  id: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: Priority;
  status: TaskStatus;
  evidence: string;
  dependencies: string[];
  risk: string | null;
  confidence: number;
  priority_reason: string;
  priority_evidence: string | null;
  priority_conflict: boolean;
}

export interface MeetingResult {
  meeting_title: string;
  meeting_date: string | null;
  summary: string;
  attendees: string[];
  decisions: string[];
  tasks: ActionTask[];
  follow_ups: string[];
  engine: "ai" | "local";
  fallback_reason?: "model_failed";
}

export interface ModelConfigStatus {
  configured: boolean;
  provider: string;
  model: string | null;
  baseURL: string | null;
  source: "runtime" | "persistent" | "environment" | null;
  apiKeyPreview: string | null;
}

export interface FeishuLinkedUser {
  id: string;
  name: string;
  aliases: string[];
  hasOpenId: boolean;
  emailPreview: string | null;
  linkedAt: string;
  updatedAt: string;
}

export interface FeishuIntegrationStatus {
  configured: boolean;
  enabled: boolean;
  oauthEnabled: boolean;
  redirectUri: string | null;
  appConsoleUrl: string | null;
  appPermissionUrl: string | null;
  appConfigSource: "persistent" | "environment" | "test" | "none";
  appIdPreview: string | null;
  mappedOwnerNames: string[];
  advancedSettingsSource: "persistent" | "environment" | "none";
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  tasklistConfigured: boolean;
  tasklistSectionConfigured: boolean;
  dueReminderMinutes: number[];
  dueReminderCount: number;
  originUrlConfigured: boolean;
  syncComments: boolean;
  tasklistDiscoveryReady: boolean;
  linkedUsers: FeishuLinkedUser[];
}

export interface FeishuTasklistSectionOption {
  id: string;
  name: string;
}

export interface FeishuTasklistOption {
  id: string;
  name: string;
  url: string | null;
  sections: FeishuTasklistSectionOption[];
}

export interface FeishuTasklistSearchResult {
  query: string;
  tokenUserName: string;
  items: FeishuTasklistOption[];
}

export interface TaskConnectorCapabilities {
  create: boolean;
  read: boolean;
  updateStatus: boolean;
  updateFields: boolean;
  statusValues?: TaskStatus[];
  tasklists?: boolean;
  reminders?: boolean;
  comments?: boolean;
  origin?: boolean;
}

export interface TaskConnectorInfo {
  id: "local-task" | "feishu";
  name: string;
  capabilities: TaskConnectorCapabilities;
}

export interface ConnectorsStatus {
  connectors: TaskConnectorInfo[];
  feishu: {
    configured: boolean;
    enabled: boolean;
    baseURL: string | null;
    userIdType: "open_id" | "union_id" | "user_id" | null;
    ownerCount: number;
    appConfigSource: "persistent" | "environment" | "test" | "none";
    appIdPreview: string | null;
    advancedSettingsSource: "persistent" | "environment" | "none";
    tasklistGuid: string | null;
    tasklistSectionGuid: string | null;
    tasklistConfigured: boolean;
    tasklistSectionConfigured: boolean;
    dueReminderMinutes: number[];
    dueReminderCount: number;
    originUrlConfigured: boolean;
    syncComments: boolean;
  };
}

export type AgentQuestionField = "owner" | "due_date" | "confirm" | "general" | "priority";
export type AgentQuestionInputType = "text" | "date" | "confirm" | "priority" | "select";

export interface AgentQuestion {
  id: string;
  task_id: string | null;
  field: AgentQuestionField;
  prompt: string;
  input_type: AgentQuestionInputType;
  answer: string | null;
  options?: string[];
  open_item_id?: string;
}

export type AgentEventType =
  | "analysis"
  | "question"
  | "answer"
  | "plan"
  | "approval"
  | "tool_call"
  | "tool_result"
  | "verification"
  | "tracking"
  | "status_change"
  | "overdue"
  | "error";

export interface AgentEvent {
  id: string;
  type: AgentEventType;
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
}

export interface OpenItem {
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
}

export interface ConversationTurn {
  id: string;
  role: "user" | "assistant" | "tool";
  kind: "meeting_submission" | "clarification" | "approval" | "status_update" | "tracking" | "agent_report" | "message" | "proposal";
  content: string;
  at: string;
  action?: string;
  task_id?: string | null;
  open_item_id?: string | null;
  metadata?: Record<string, string | number | boolean | null>;
}

export type TaskFieldChanges = Partial<Pick<ActionTask, "title" | "description" | "owner" | "due_date" | "priority">>;
export type FeishuSettingsChangeSet = Partial<{
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  dueReminderMinutes: number[];
  syncComments: boolean;
}>;

export type QueuedAgentPlan = {
  intent: "propose_status" | "propose_task_edit" | "propose_task_reminders" | "propose_task_comment" | "explain" | "unsure";
  external_task_id: string | null;
  status: TaskStatus | null;
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
  status: TaskStatus;
  expected_status: TaskStatus;
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

export interface ModelInteraction {
  id: string;
  kind: "dialogue";
  at: string;
  system_prompt: string;
  user_prompt: string;
  model_output: string;
  normalized_intent: string;
  duration_ms?: number;
}

export type ClarificationOutcome =
  | "updated"
  | "confirmed"
  | "rejected_task"
  | "supplemented"
  | "priority_adjusted";

export interface ClarificationHistoryEntry {
  id: string;
  question_id: string;
  task_id: string | null;
  field: AgentQuestionField;
  prompt: string;
  input_type: AgentQuestionInputType;
  answer: string;
  outcome: ClarificationOutcome;
  at: string;
}

export interface CreatedTaskRecord {
  task_id: string;
  external_id: string;
  external_url?: string | null;
  connector_id: "local-task" | "feishu";
  connector_name: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: Priority;
  priority_reason: string;
  priority_evidence: string | null;
  status: TaskStatus;
  evidence: string;
  dependencies: string[];
  risk: string | null;
  reused: boolean;
  verified: boolean;
  issues: string[];
}

export interface TrackingSummary {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  overdue: number;
  checked_at: string;
}

export type PromptSkillName =
  | "meeting-extraction"
  | "completeness-check"
  | "clarification"
  | "task-planning"
  | "priority-reasoning"
  | "verification"
  | "tracking"
  | "dialogue-orchestration"
  | "task-editing";

export interface AgentRun {
  id: string;
  connector_id: "local-task" | "feishu";
  state: AgentState;
  analysis: MeetingResult;
  questions: AgentQuestion[];
  open_items: OpenItem[];
  clarification_history: ClarificationHistoryEntry[];
  approved_task_ids: string[];
  approval_signature?: string;
  created_tasks: CreatedTaskRecord[];
  tracking: TrackingSummary | null;
  events: AgentEvent[];
  conversation: ConversationTurn[];
  pending_action: PendingAgentAction | null;
  model_interactions: ModelInteraction[];
  overdue_task_ids: string[];
  skill_versions: Record<PromptSkillName, string>;
  user_skills: UserSkill[];
  original_notes: string;
  meeting_date?: string;
  instruction?: string;
  analysis_trace?: AnalysisTrace;
  created_at: string;
  updated_at: string;
}

export interface UserSkill {
  id: string;
  name: string;
  enabled: boolean;
  content: string;
}

export interface AnalysisTrace {
  system_prompt: string;
  user_prompt: string;
  model_output: string;
  prompt_modules: Array<{ name: string; version: string; purpose: string }>;
  normalized_output?: MeetingResult;
}

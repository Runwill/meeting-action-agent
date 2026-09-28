import type { AgentTask, ConnectorId, ExternalTask, TaskFieldChanges } from "../agent-store.ts";

export type TaskConnectorId = ConnectorId;

export type TaskConnectorCapabilities = {
  create: boolean;
  read: boolean;
  updateStatus: boolean;
  updateFields: boolean;
  statusValues?: Array<ExternalTask["status"]>;
  tasklists?: boolean;
  reminders?: boolean;
  comments?: boolean;
  origin?: boolean;
};

export type TaskCreationResult = {
  task: ExternalTask;
  reused: boolean;
  issues?: string[];
};

export type ExternalTaskFieldChanges = TaskFieldChanges & Partial<Pick<ExternalTask, "priority_reason" | "priority_evidence">>;
export type ExternalTaskOperationResult = ExternalTask & { issues?: string[] };

export type TaskSettingsSyncResult = {
  task: ExternalTask | null;
  applied: string[];
  issues: string[];
};

export type TaskCommentResult = {
  task: ExternalTask | null;
  issues: string[];
};

export type TaskSettingsSyncInput = {
  dueReminderMinutes?: number[];
};

export interface TaskConnector {
  id: TaskConnectorId;
  name: string;
  capabilities: TaskConnectorCapabilities;
  createTask(runId: string, task: AgentTask): Promise<TaskCreationResult>;
  getTask(id: string): Promise<ExternalTask | null>;
  updateStatus(id: string, status: ExternalTask["status"]): Promise<ExternalTaskOperationResult | null>;
  updateTask?(id: string, changes: ExternalTaskFieldChanges): Promise<ExternalTaskOperationResult | null>;
  syncTaskSettings?(id: string, input?: TaskSettingsSyncInput): Promise<TaskSettingsSyncResult>;
  addComment?(id: string, content: string): Promise<TaskCommentResult>;
}

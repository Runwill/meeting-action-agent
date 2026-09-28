import type { ActionTask, AgentRun, ConnectorsStatus, FeishuIntegrationStatus, FeishuTasklistSearchResult, TaskStatus, UserSkill } from "./types";

type JsonRecord = Record<string, unknown>;

export interface CreateAgentRunInput {
  notes: string;
  meetingDate?: string;
  instruction?: string;
}

export interface ClarificationAnswer {
  questionId: string;
  value: string;
}

export interface ApproveAgentRunInput {
  tasks: ActionTask[];
  selectedTaskIds: string[];
}

export class ApiError extends Error {
  readonly status: number;
  readonly data: unknown;

  constructor(message: string, status: number, data: unknown = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.data = data;
  }
}

function isJsonRecord(value: unknown): value is JsonRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorMessage(data: unknown, fallback: string) {
  if (!isJsonRecord(data)) return fallback;
  if (typeof data.error === "string" && data.error.trim()) return data.error;
  if (typeof data.message === "string" && data.message.trim()) return data.message;
  return fallback;
}

async function parseResponse(response: Response): Promise<unknown> {
  const body = await response.text();
  if (!body) return null;

  try {
    return JSON.parse(body) as unknown;
  } catch {
    if (!response.ok) return body;
    throw new ApiError("服务器返回了无法解析的数据。", response.status, body);
  }
}

export async function requestJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  if (init.body !== undefined && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }

  let response: Response;
  try {
    response = await fetch(path, { ...init, headers });
  } catch (error) {
    const message = error instanceof Error && error.message
      ? `无法连接服务：${error.message}`
      : "无法连接服务，请确认本地 API 已启动。";
    throw new ApiError(message, 0, error);
  }

  const data = await parseResponse(response);
  if (!response.ok) {
    throw new ApiError(errorMessage(data, `请求失败（HTTP ${response.status}）。`), response.status, data);
  }
  return data as T;
}

function jsonBody(value: unknown): Pick<RequestInit, "body" | "headers"> {
  return {
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  };
}

function runPath(runId: string, action?: "clarify" | "approve" | "track") {
  const base = `/api/agent/runs/${encodeURIComponent(runId)}`;
  return action ? `${base}/${action}` : base;
}

export type AgentCommand =
  | { type: "answer_questions"; payload: { answers: ClarificationAnswer[] } }
  | { type: "approve_tasks"; payload: ApproveAgentRunInput }
  | { type: "refresh_tracking"; payload?: Record<string, never> }
  | { type: "set_task_status"; payload: { externalTaskId: string; status: TaskStatus } };

export function sendAgentCommand(runId: string, command: AgentCommand) {
  return requestJson<{ run: AgentRun }>(`${runPath(runId)}/commands`, {
    method: "POST",
    ...jsonBody(command),
  });
}

export function sendAgentMessage(runId: string, content: string) {
  return requestJson<AgentRun>(`${runPath(runId)}/messages`, {
    method: "POST",
    ...jsonBody({ content }),
  });
}

export function confirmAgentAction(runId: string, actionId: string, approved: boolean) {
  return requestJson<AgentRun>(`${runPath(runId)}/confirm-action`, {
    method: "POST",
    ...jsonBody({ actionId, approved }),
  });
}

export function createAgentRun(input: CreateAgentRunInput) {
  return requestJson<AgentRun>("/api/agent/runs", {
    method: "POST",
    ...jsonBody(input),
  });
}

export function getAgentRun(runId: string) {
  return requestJson<AgentRun>(runPath(runId));
}

export function clarifyAgentRun(runId: string, answers: ClarificationAnswer[]) {
  return requestJson<AgentRun>(runPath(runId, "clarify"), {
    method: "POST",
    ...jsonBody({ answers }),
  });
}

export function approveAgentRun(runId: string, input: ApproveAgentRunInput) {
  return requestJson<AgentRun>(runPath(runId, "approve"), {
    method: "POST",
    ...jsonBody(input),
  });
}

export function trackAgentRun(runId: string) {
  return requestJson<AgentRun>(runPath(runId, "track"), { method: "POST" });
}

export function updateTaskStatus(taskId: string, status: TaskStatus) {
  return requestJson<CreatedTaskStatusResponse>(`/api/agent/tasks/${encodeURIComponent(taskId)}`, {
    method: "PATCH",
    ...jsonBody({ status }),
  });
}

export interface CreatedTaskStatusResponse {
  id: string;
  status: TaskStatus;
  [key: string]: unknown;
}

export function getUserSkills() {
  return requestJson<{ skills: UserSkill[] }>("/api/user-skills");
}

export function saveUserSkills(input: { skills: UserSkill[] }) {
  return requestJson<{ skills: UserSkill[] }>("/api/user-skills", {
    method: "PUT",
    ...jsonBody(input),
  });
}

export function getFeishuIntegrationStatus() {
  return requestJson<FeishuIntegrationStatus>("/api/integrations/feishu/status");
}

export function getConnectors() {
  return requestJson<ConnectorsStatus>("/api/connectors");
}

export function startFeishuOAuth(alias?: string) {
  const returnUrl = typeof window === "undefined" ? undefined : `${window.location.origin}/#workflow`;
  return requestJson<{ authorizeUrl: string; redirectUri: string; returnUrl: string }>("/api/integrations/feishu/oauth/start", {
    method: "POST",
    ...jsonBody({ alias, returnUrl }),
  });
}

export function markFeishuRedirectVerified() {
  return requestJson<FeishuIntegrationStatus>("/api/integrations/feishu/oauth/redirect-verified", {
    method: "POST",
  });
}

export function saveFeishuSettings(input: {
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  dueReminderMinutes: string | number[];
  syncComments: boolean;
}) {
  return requestJson<FeishuIntegrationStatus>("/api/integrations/feishu/settings", {
    method: "PUT",
    ...jsonBody(input),
  });
}

export function searchFeishuTasklists(query: string) {
  return requestJson<FeishuTasklistSearchResult>("/api/integrations/feishu/tasklists/search", {
    method: "POST",
    ...jsonBody({ query }),
  });
}

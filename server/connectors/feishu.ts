import { createHash } from "node:crypto";
import type { AgentTask, ExternalTask } from "../agent-store.ts";
import { getFeishuConfig, type FeishuConfig } from "../feishu-config.ts";
import type { ExternalTaskFieldChanges, TaskConnector, TaskCreationResult, TaskSettingsSyncResult } from "./task-connector.ts";

type FetchLike = typeof fetch;

type FeishuResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type FeishuTask = {
  guid?: string;
  summary?: string;
  description?: string;
  due?: { timestamp?: string; is_all_day?: boolean } | null;
  completed_at?: string;
  status?: "todo" | "done" | string;
  members?: Array<{ id?: string; role?: string; name?: string }>;
  reminders?: FeishuReminder[];
  extra?: string;
  url?: string;
};

type TenantTokenResponse = {
  code?: number;
  msg?: string;
  tenant_access_token?: string;
  expire?: number;
};

type CreateTaskResponse = {
  task?: FeishuTask;
};

type UpdateTaskResponse = {
  task?: FeishuTask;
};

type CommentCreateResponse = {
  comment?: { comment_id?: string };
};

export type FeishuErrorCode =
  | "not_configured"
  | "invalid_config"
  | "owner_mapping_missing"
  | "auth_failed"
  | "permission_denied"
  | "rate_limited"
  | "not_found"
  | "provider_error"
  | "unsupported";

export class FeishuConnectorError extends Error {
  constructor(
    public readonly code: FeishuErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "FeishuConnectorError";
  }
}

type StoredExtra = {
  source_run_id: string;
  source_task_id: string;
  idempotency_key: string;
  source_owner: string | null;
  priority: AgentTask["priority"];
  priority_reason: string;
  priority_evidence: string | null;
  evidence: string;
  dependencies: string[];
  risk: string | null;
};

type FeishuTaskPatch = {
  summary?: string;
  description?: string;
  due?: { timestamp?: string; is_all_day?: boolean } | null;
  completed_at?: string;
  extra?: string;
};

type FeishuTaskPatchEnvelope = {
  update_fields: string[];
  task: FeishuTaskPatch;
};

type FeishuTasklistPlacement = {
  tasklist_guid: string;
  section_guid?: string;
};

type FeishuReminder = {
  id?: string;
  reminder_id?: string;
  guid?: string;
  relative_fire_minute: number;
};

type AddReminderResponse = {
  reminders?: FeishuReminder[];
};

type RemoveReminderResponse = {
  task?: FeishuTask;
};

type TokenCache = {
  token: string;
  expiresAt: number;
};

function safeMessage(value: unknown) {
  return typeof value === "string" ? value.slice(0, 300) : "";
}

function operationLabel(operation: "create" | "read" | "update") {
  return operation === "create" ? "创建" : operation === "read" ? "读取" : "更新";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function parseResponse<T>(value: unknown): FeishuResponse<T> {
  return isRecord(value) ? value as FeishuResponse<T> : {};
}

function dateToTimestamp(date: string) {
  const milliseconds = Date.parse(`${date}T00:00:00+08:00`);
  if (!Number.isFinite(milliseconds)) {
    throw new FeishuConnectorError("invalid_config", "飞书任务截止日期无法转换。");
  }
  return String(milliseconds);
}

function timestampToDate(value: unknown, allDay: unknown) {
  if (typeof value !== "string" || !value || allDay !== true) return null;
  const date = new Date(Number(value));
  if (!Number.isFinite(date.getTime())) return null;
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(date);
  const part = (type: string) => parts.find((item) => item.type === type)?.value || "";
  const result = `${part("year")}-${part("month")}-${part("day")}`;
  return /^\d{4}-\d{2}-\d{2}$/.test(result) ? result : null;
}

function hashClientToken(runId: string, taskId: string) {
  return createHash("sha256").update(`meeting-agent:${runId}:${taskId}`).digest("hex");
}

function parseExtra(value: unknown): Partial<StoredExtra> {
  if (typeof value !== "string" || !value.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!isRecord(parsed)) return {};
    return {
      source_run_id: typeof parsed.source_run_id === "string" ? parsed.source_run_id : undefined,
      source_task_id: typeof parsed.source_task_id === "string" ? parsed.source_task_id : undefined,
      idempotency_key: typeof parsed.idempotency_key === "string" ? parsed.idempotency_key : undefined,
      source_owner: typeof parsed.source_owner === "string" ? parsed.source_owner : parsed.source_owner === null ? null : undefined,
      priority: parsed.priority === "high" || parsed.priority === "low" ? parsed.priority : parsed.priority === "medium" ? "medium" : undefined,
      priority_reason: typeof parsed.priority_reason === "string" ? parsed.priority_reason : undefined,
      priority_evidence: typeof parsed.priority_evidence === "string" ? parsed.priority_evidence : parsed.priority_evidence === null ? null : undefined,
      evidence: typeof parsed.evidence === "string" ? parsed.evidence : undefined,
      dependencies: Array.isArray(parsed.dependencies) ? parsed.dependencies.filter((item): item is string => typeof item === "string") : undefined,
      risk: typeof parsed.risk === "string" ? parsed.risk : parsed.risk === null ? null : undefined,
    };
  } catch {
    return {};
  }
}

function looksLikeGeneratedFeishuName(value: string | undefined) {
  return !!value && /^用户\d+$/.test(value.trim());
}

function safeExternalUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.toString() : null;
  } catch {
    return null;
  }
}

function resolveOwnerName(assignee: NonNullable<FeishuTask["members"]>[number] | undefined, extra: Partial<StoredExtra>, config: FeishuConfig) {
  const assigneeId = assignee?.id;
  if (!assigneeId) return assignee?.name || null;
  if (extra.source_owner && config.ownerMap[extra.source_owner] === assigneeId) return extra.source_owner;

  const candidates = Object.entries(config.ownerMap)
    .filter(([, externalId]) => externalId === assigneeId)
    .map(([name]) => name);
  if (!candidates.length) return assignee?.name || null;

  const displayName = assignee?.name?.trim();
  if (displayName && candidates.includes(displayName) && !looksLikeGeneratedFeishuName(displayName)) return displayName;
  return candidates.find((name) => name !== displayName) || candidates[0] || displayName || null;
}

function mapTask(task: FeishuTask, config: FeishuConfig): ExternalTask {
  const id = typeof task.guid === "string" ? task.guid : "";
  if (!id) throw new FeishuConnectorError("provider_error", "飞书返回的任务缺少任务 ID。");
  const extra = parseExtra(task.extra);
  const assignee = task.members?.find((member) => member.role === "assignee") || task.members?.[0];
  const owner = resolveOwnerName(assignee, extra, config);
  const priority = extra.priority || "medium";
  const completed = task.status === "done" || (typeof task.completed_at === "string" && task.completed_at !== "" && task.completed_at !== "0");
  return {
    id,
    external_url: safeExternalUrl(task.url),
    connector_id: "feishu",
    idempotency_key: extra.idempotency_key || `feishu:${id}`,
    source_run_id: extra.source_run_id || "",
    source_task_id: extra.source_task_id || "",
    title: typeof task.summary === "string" ? task.summary : "",
    description: typeof task.description === "string" ? task.description : "",
    owner,
    due_date: timestampToDate(task.due?.timestamp, task.due?.is_all_day),
    priority,
    priority_reason: extra.priority_reason || "飞书任务未附带本系统的优先级理由。",
    priority_evidence: extra.priority_evidence ?? null,
    status: completed ? "done" : "in_progress",
    evidence: extra.evidence || "",
    dependencies: extra.dependencies || [],
    risk: extra.risk ?? null,
    created_at: "",
    updated_at: "",
  };
}

function buildExtra(runId: string, task: AgentTask, idempotencyKey: string): string {
  return JSON.stringify({
    source_run_id: runId,
    source_task_id: task.id,
    idempotency_key: idempotencyKey,
    source_owner: task.owner,
    priority: task.priority,
    priority_reason: task.priority_reason,
    priority_evidence: task.priority_evidence,
    evidence: task.evidence,
    dependencies: task.dependencies,
    risk: task.risk,
  } satisfies StoredExtra);
}

function buildUpdatedExtra(current: ExternalTask, changes: ExternalTaskFieldChanges): string {
  return JSON.stringify({
    source_run_id: current.source_run_id,
    source_task_id: current.source_task_id,
    idempotency_key: current.idempotency_key,
    source_owner: Object.hasOwn(changes, "owner") ? changes.owner ?? null : current.owner,
    priority: changes.priority || current.priority,
    priority_reason: changes.priority_reason ?? current.priority_reason,
    priority_evidence: Object.hasOwn(changes, "priority_evidence") ? changes.priority_evidence ?? null : current.priority_evidence,
    evidence: current.evidence,
    dependencies: current.dependencies,
    risk: current.risk,
  } satisfies StoredExtra);
}

function priorityLabel(priority: AgentTask["priority"]) {
  if (priority === "high") return "高";
  if (priority === "low") return "低";
  return "中";
}

function statusLabel(status: ExternalTask["status"]) {
  if (status === "done") return "已完成";
  if (status === "in_progress") return "进行中";
  return "待开始";
}

function clipped(value: string | null | undefined, max = 180) {
  const cleaned = value?.trim();
  if (!cleaned) return "";
  return cleaned.length > max ? `${cleaned.slice(0, max)}…` : cleaned;
}

function buildOrigin(config: FeishuConfig, runId: string) {
  const origin: {
    platform_i18n_name: { zh_cn: string; en_us: string };
    href?: { url: string; title: string };
  } = {
    platform_i18n_name: {
      zh_cn: "会议行动智能体",
      en_us: "Meeting Action Agent",
    },
  };
  if (config.originUrl) {
    origin.href = {
      url: config.originUrl,
      title: `查看会议行动来源 ${runId.slice(0, 8)}`,
    };
  }
  return origin;
}

function buildTasklists(config: FeishuConfig): FeishuTasklistPlacement[] {
  if (!config.tasklistGuid) return [];
  return [{
    tasklist_guid: config.tasklistGuid,
    ...(config.tasklistSectionGuid ? { section_guid: config.tasklistSectionGuid } : {}),
  }];
}

function buildDueReminders(config: FeishuConfig, task: AgentTask): FeishuReminder[] {
  if (!task.due_date || !config.dueReminderMinutes.length) return [];
  return config.dueReminderMinutes.map((minute) => ({ relative_fire_minute: minute }));
}

function reminderLabel(minutes: number[]) {
  if (!minutes.length) return "未启用";
  return minutes.map((value) => {
    if (value === 0) return "截止时";
    if (value % 1440 === 0) return `提前 ${value / 1440} 天`;
    if (value % 60 === 0) return `提前 ${value / 60} 小时`;
    return `提前 ${value} 分钟`;
  }).join("、");
}

function reminderId(reminder: FeishuReminder) {
  return reminder.id || reminder.reminder_id || reminder.guid || "";
}

function creationComment(task: AgentTask) {
  const lines = [
    "会议行动智能体已根据会议纪要创建此任务。",
    `优先级：${priorityLabel(task.priority)}。${clipped(task.priority_reason, 220)}`,
    task.evidence ? `原文依据：${clipped(task.evidence, 260)}` : "",
    task.dependencies.length ? `依赖：${task.dependencies.map((item) => clipped(item, 80)).filter(Boolean).join("；")}` : "",
    task.risk ? `风险：${clipped(task.risk, 160)}` : "",
  ].filter(Boolean);
  return lines.join("\n");
}

function statusComment(status: ExternalTask["status"]) {
  return `会议行动智能体已在系统内将任务状态同步为：${statusLabel(status)}。`;
}

function editComment(changes: ExternalTaskFieldChanges) {
  const labels: Record<keyof ExternalTaskFieldChanges, string> = {
    title: "标题",
    description: "描述",
    owner: "负责人",
    due_date: "截止日期",
    priority: "优先级",
    priority_reason: "优先级理由",
    priority_evidence: "优先级证据",
  };
  const fields = (Object.keys(changes) as Array<keyof ExternalTaskFieldChanges>)
    .filter((field) => field !== "priority_reason" && field !== "priority_evidence")
    .map((field) => labels[field])
    .join("、");
  return fields ? `会议行动智能体已在系统内同步更新任务字段：${fields}。` : "";
}

export function createFeishuTaskConnector(
  input: {
    config?: FeishuConfig | null;
    fetchImpl?: FetchLike;
  } = {},
): TaskConnector {
  const config = input.config ?? getFeishuConfig();
  const fetchImpl = input.fetchImpl ?? fetch;
  let tokenCache: TokenCache | null = null;

  const requireConfig = () => {
    if (!config) throw new FeishuConnectorError("not_configured", "飞书连接尚未配置 App ID 和 App Secret。");
    if (!config.appId || !config.appSecret) throw new FeishuConnectorError("invalid_config", "飞书连接配置不完整。");
    return config;
  };

  const getToken = async (forceRefresh = false) => {
    const currentConfig = requireConfig();
    if (!forceRefresh && tokenCache && tokenCache.expiresAt > Date.now() + 60_000) return tokenCache.token;
    let response: Response;
    try {
      response = await fetchImpl(`${currentConfig.baseURL}/open-apis/auth/v3/tenant_access_token/internal`, {
        method: "POST",
        headers: { "Content-Type": "application/json; charset=utf-8" },
        body: JSON.stringify({ app_id: currentConfig.appId, app_secret: currentConfig.appSecret }),
      });
    } catch {
      throw new FeishuConnectorError("auth_failed", "飞书鉴权请求失败，请检查网络和应用配置。");
    }
    const payload = await response.json().catch(() => null) as TenantTokenResponse | null;
    if (!response.ok || !payload || payload.code !== undefined && payload.code !== 0 || !payload.tenant_access_token) {
      throw new FeishuConnectorError("auth_failed", "飞书鉴权失败，请检查 App ID、App Secret 和应用状态。");
    }
    const expiresIn = typeof payload.expire === "number" ? payload.expire : 7200;
    tokenCache = {
      token: payload.tenant_access_token,
      expiresAt: Date.now() + Math.max(60, expiresIn - 60) * 1000,
    };
    return tokenCache.token;
  };

  const request = async <T>(
    pathname: string,
    init: RequestInit,
    operation: "create" | "read" | "update",
    retry = true,
    options: { toleratedApiCodes?: number[] } = {},
  ): Promise<T> => {
    const currentConfig = requireConfig();
    const token = await getToken();
    let response: Response;
    try {
      response = await fetchImpl(`${currentConfig.baseURL}${pathname}`, {
        ...init,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          ...(init.headers || {}),
          Authorization: `Bearer ${token}`,
        },
      });
    } catch {
      throw new FeishuConnectorError("provider_error", `飞书任务${operationLabel(operation)}请求失败，请检查网络连接。`);
    }
    const payload = parseResponse<T>(await response.json().catch(() => null));
    const apiCode = typeof payload.code === "number" ? payload.code : 0;
    if ((response.status === 401 || response.status === 403) && retry) {
      tokenCache = null;
      return request(pathname, init, operation, false, options);
    }
    if (apiCode !== 0 && options.toleratedApiCodes?.includes(apiCode)) return (payload.data || {}) as T;
    if (!response.ok || apiCode !== 0) {
      if (response.status === 429) throw new FeishuConnectorError("rate_limited", "飞书接口触发频率限制，请稍后重试。");
      if (response.status === 401 || response.status === 403 || [1470403, 99991672].includes(apiCode)) {
        throw new FeishuConnectorError("permission_denied", "飞书应用没有完成任务读写权限配置。");
      }
      if (response.status === 404 || apiCode === 1470404) {
        throw new FeishuConnectorError("not_found", "飞书任务不存在或已被删除。");
      }
      const providerHint = safeMessage(payload.msg);
      throw new FeishuConnectorError("provider_error", providerHint ? `飞书任务${operationLabel(operation)}失败：${providerHint}` : `飞书任务${operationLabel(operation)}失败，请检查接口权限和参数。`);
    }
    return (payload.data || {}) as T;
  };

  const commentSyncIssue = (error: unknown) => {
    if (error instanceof FeishuConnectorError && error.code === "permission_denied") {
      return "飞书评论同步失败：应用缺少 task:comment:write 权限。";
    }
    return "飞书评论同步失败：评论接口未成功响应。";
  };

  const withIssues = (task: ExternalTask | null, issues: string[]) => task ? { ...task, issues } : task;

  const postTaskComment = async (taskId: string, content: string, options: { requireSyncEnabled?: boolean } = {}): Promise<string[]> => {
    const currentConfig = requireConfig();
    if (options.requireSyncEnabled !== false && !currentConfig.syncComments) return [];
    if (!content.trim()) return [];
    try {
      await request<CommentCreateResponse>(`/open-apis/task/v2/comments?user_id_type=${currentConfig.userIdType}`, {
        method: "POST",
        body: JSON.stringify({
          content: clipped(content, 3000),
          resource_type: "task",
          resource_id: taskId,
        }),
      }, "update");
      return [];
    } catch (error) {
      // Activity comments are a visible enhancement, not the source of truth.
      // If a Feishu app lacks comment permission, keep the approved task write
      // and readback path working instead of failing a partially completed write.
      return [commentSyncIssue(error)];
    }
  };

  const readRawTask = async (id: string): Promise<FeishuTask | null> => {
    const currentConfig = requireConfig();
    try {
      const result = await request<{ task?: FeishuTask }>(`/open-apis/task/v2/tasks/${encodeURIComponent(id)}?user_id_type=${currentConfig.userIdType}`, {
        method: "GET",
      }, "read");
      return result.task || null;
    } catch (error) {
      if (error instanceof FeishuConnectorError && error.code === "not_found") return null;
      throw error;
    }
  };

  const readTask = async (id: string): Promise<ExternalTask | null> => {
    const currentConfig = requireConfig();
    const task = await readRawTask(id);
    return task ? mapTask(task, currentConfig) : null;
  };

  const addDueReminders = async (taskId: string, minutes: number[]) => {
    const currentConfig = requireConfig();
    const unique = [...new Set(minutes)];
    for (const minute of unique) {
      await request<AddReminderResponse>(
        `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}/add_reminders?user_id_type=${currentConfig.userIdType}`,
        {
          method: "POST",
          body: JSON.stringify({ reminders: [{ relative_fire_minute: minute }] }),
        },
        "update",
        true,
        // Feishu may reject a duplicate reminder time on idempotent retries. In
        // that case the desired state already exists, so the retry should still
        // be treated as safe.
        { toleratedApiCodes: [1470420] },
      );
    }
  };

  const removeDueReminders = async (taskId: string, reminderIds: string[]) => {
    const currentConfig = requireConfig();
    const unique = [...new Set(reminderIds.filter((id) => id.trim()))];
    if (!unique.length) return;
    await request<RemoveReminderResponse>(
      `/open-apis/task/v2/tasks/${encodeURIComponent(taskId)}/remove_reminders?user_id_type=${currentConfig.userIdType}`,
      {
        method: "POST",
        body: JSON.stringify({ reminder_ids: unique }),
      },
      "update",
    );
  };

  const syncConfiguredReminders = async (id: string, input?: { dueReminderMinutes?: number[] }): Promise<TaskSettingsSyncResult> => {
    const currentConfig = requireConfig();
    const raw = await readRawTask(id);
    if (!raw) return { task: null, applied: [], issues: ["飞书任务不存在或已被删除。"] };
    const existingReminders = (raw.reminders || [])
      .filter((reminder) => Number.isInteger(reminder.relative_fire_minute));
    const existingMinutes = new Set(existingReminders.map((reminder) => reminder.relative_fire_minute));
    const hasDue = !!timestampToDate(raw.due?.timestamp, raw.due?.is_all_day);
    const targetReminderMinutes = input?.dueReminderMinutes
      ? [...new Set(input.dueReminderMinutes.filter((minute) => Number.isInteger(minute) && minute >= 0 && minute <= 43_200))]
      : currentConfig.dueReminderMinutes;
    if (!hasDue && targetReminderMinutes.length) {
      return {
        task: mapTask(raw, currentConfig),
        applied: [],
        issues: ["任务没有截止日期，无法同步到期提醒。"],
      };
    }
    const desired = hasDue ? targetReminderMinutes : [];
    const desiredMinutes = new Set(desired);
    const missing = desired.filter((minute) => !existingMinutes.has(minute));
    const extra = existingReminders.filter((reminder) => !desiredMinutes.has(reminder.relative_fire_minute));
    const removableIds = extra.map(reminderId).filter(Boolean);
    const missingIds = extra.length - removableIds.length;
    const issues = missingIds ? [`有 ${missingIds} 条旧提醒缺少飞书 reminder id，无法自动移除。`] : [];
    if (!missing.length && !removableIds.length) return { task: mapTask(raw, currentConfig), applied: [], issues };
    await removeDueReminders(id, removableIds);
    await addDueReminders(id, missing);
    issues.push(...await postTaskComment(id, `会议行动智能体已同步此任务的提醒规则：${reminderLabel(desired)}。`));
    const updated = await readTask(id);
    return { task: updated, applied: ["reminders"], issues };
  };

  return {
    id: "feishu",
    name: "飞书任务",
    capabilities: {
      create: true,
      read: true,
      updateStatus: true,
      updateFields: true,
      statusValues: ["in_progress", "done"],
      tasklists: !!config?.tasklistGuid,
      reminders: !!config?.dueReminderMinutes.length,
      comments: config?.syncComments === true,
      origin: true,
    },

    async createTask(runId: string, task: AgentTask): Promise<TaskCreationResult> {
      const currentConfig = requireConfig();
      const ownerId = task.owner ? currentConfig.ownerMap[task.owner] : undefined;
      if (task.owner && !ownerId) {
        throw new FeishuConnectorError("owner_mapping_missing", `飞书中找不到负责人“${task.owner}”的用户 ID 映射。`);
      }
      const idempotencyKey = hashClientToken(runId, task.id);
      const body: Record<string, unknown> = {
        summary: task.title,
        description: task.description,
        client_token: idempotencyKey,
        extra: buildExtra(runId, task, idempotencyKey),
        origin: buildOrigin(currentConfig, runId),
      };
      if (task.due_date) body.due = { timestamp: dateToTimestamp(task.due_date), is_all_day: true };
      if (ownerId) body.members = [{ id: ownerId, type: "user", role: "assignee", name: task.owner }];
      const tasklists = buildTasklists(currentConfig);
      if (tasklists.length) body.tasklists = tasklists;
      const result = await request<CreateTaskResponse>(`/open-apis/task/v2/tasks?user_id_type=${currentConfig.userIdType}`, {
        method: "POST",
        body: JSON.stringify(body),
      }, "create");
      if (!result.task) throw new FeishuConnectorError("provider_error", "飞书创建接口没有返回任务对象。");
      const created = mapTask(result.task, currentConfig);
      const reminders = buildDueReminders(currentConfig, task);
      if (reminders.length) {
        await addDueReminders(created.id, reminders.map((reminder) => reminder.relative_fire_minute));
      }
      const issues = await postTaskComment(created.id, creationComment(task));
      return { task: created, reused: false, issues };
    },

    getTask: readTask,

    async updateStatus(id: string, status: ExternalTask["status"]) {
      const currentConfig = requireConfig();
      const body: FeishuTaskPatch = status === "done"
        ? { completed_at: String(Date.now()) }
        : { completed_at: "0" };
      const payload: FeishuTaskPatchEnvelope = { update_fields: ["completed_at"], task: body };
      const result = await request<UpdateTaskResponse>(
        `/open-apis/task/v2/tasks/${encodeURIComponent(id)}?user_id_type=${currentConfig.userIdType}`,
        { method: "PATCH", body: JSON.stringify(payload) },
        "update",
      );
      const updated = result.task ? mapTask(result.task, currentConfig) : await readTask(id);
      const issues = updated ? await postTaskComment(updated.id, statusComment(status)) : [];
      return withIssues(updated, issues);
    },

    async updateTask(id: string, changes: ExternalTaskFieldChanges) {
      const currentConfig = requireConfig();
      const current = await readTask(id);
      if (!current) return null;

      const body: FeishuTaskPatch = {};
      const updateFields: string[] = [];
      if (Object.hasOwn(changes, "title")) {
        body.summary = changes.title ?? "";
        updateFields.push("summary");
      }
      if (Object.hasOwn(changes, "description")) {
        body.description = changes.description ?? "";
        updateFields.push("description");
      }
      if (Object.hasOwn(changes, "due_date")) {
        body.due = changes.due_date ? { timestamp: dateToTimestamp(changes.due_date), is_all_day: true } : null;
        updateFields.push("due");
      }
      if (Object.hasOwn(changes, "owner")) {
        const owner = changes.owner?.trim() || null;
        if (owner !== current.owner) {
          throw new FeishuConnectorError("unsupported", "飞书任务负责人需要通过成员增删接口调整，本阶段暂不支持从系统内修改负责人。");
        }
      }
      if (Object.keys(changes).some((field) => ["priority", "priority_reason", "priority_evidence"].includes(field))) {
        body.extra = buildUpdatedExtra(current, changes);
        updateFields.push("extra");
      }

      if (!updateFields.length) return current;
      const payload: FeishuTaskPatchEnvelope = { update_fields: [...new Set(updateFields)], task: body };
      const result = await request<UpdateTaskResponse>(
        `/open-apis/task/v2/tasks/${encodeURIComponent(id)}?user_id_type=${currentConfig.userIdType}`,
        { method: "PATCH", body: JSON.stringify(payload) },
        "update",
      );
      const updated = result.task ? mapTask(result.task, currentConfig) : await readTask(id);
      const issues: string[] = [];
      if (updated && Object.hasOwn(changes, "due_date") && updated.due_date) {
        const reminderSync = await syncConfiguredReminders(id);
        issues.push(...reminderSync.issues);
      }
      if (updated) issues.push(...await postTaskComment(updated.id, editComment(changes)));
      return withIssues(updated, issues);
    },

    syncTaskSettings: syncConfiguredReminders,

    async addComment(id: string, content: string) {
      const current = await readTask(id);
      if (!current) return { task: null, issues: ["飞书任务不存在或已被删除。"] };
      const issues = await postTaskComment(id, content, { requireSyncEnabled: false });
      const updated = await readTask(id);
      return { task: updated || current, issues };
    },
  };
}

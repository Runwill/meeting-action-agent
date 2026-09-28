import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AgentTask } from "./agent-store";
import { clearFeishuConfigForTests, savePersistentFeishuAppConfig, setFeishuAppConfigPathForTests, setFeishuConfigForTests, type FeishuConfig } from "./feishu-config";
import { createFeishuTaskConnector, FeishuConnectorError } from "./connectors/feishu";
import { clearFeishuUserTokenCacheForTests, completeFeishuOAuth, createFeishuOAuthStart, getFeishuIntegrationStatus, markFeishuRedirectVerified, normalizeFeishuOAuthReturnUrl, searchFeishuTasklists, updateFeishuAdvancedSettings } from "./feishu-oauth";
import { setFeishuIdentityStorePathForTests } from "./feishu-auth-store";

type TestFetch = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

const config: FeishuConfig = {
  appId: "cli_test",
  appSecret: "secret-test",
  baseURL: "https://open.feishu.cn",
  userIdType: "open_id",
  ownerMap: { 张三: "ou_zhangsan" },
  tasklistGuid: null,
  tasklistSectionGuid: null,
  dueReminderMinutes: [],
  originUrl: null,
  syncComments: false,
};

let temporaryDirectory = "";

function taskInput(): AgentTask {
  return {
    id: "b9d4c9dc-7ee0-4c4c-a1b9-3ae8d8c87b5a",
    title: "确认扩容报价",
    description: "在发布准备会上确认服务器扩容报价。",
    owner: "张三",
    due_date: "2026-09-28",
    priority: "high",
    priority_reason: "原文出现“上线前必须完成”。",
    priority_evidence: "上线前必须完成",
    priority_conflict: false,
    status: "todo",
    evidence: "张三：上线前必须完成扩容报价确认。",
    dependencies: ["等待供应商回复"],
    risk: "供应商回复可能延迟。",
    confidence: 0.96,
  };
}

function jsonResponse(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function feishuStoredTask(overrides: Record<string, unknown> = {}) {
  const input = taskInput();
  return {
    guid: "feishu-guid-001",
    summary: input.title,
    description: input.description,
    due: { timestamp: String(Date.parse(`${input.due_date}T00:00:00+08:00`)), is_all_day: true },
    members: [{ id: "ou_zhangsan", type: "user", role: "assignee", name: "用户380273" }],
    extra: JSON.stringify({
      source_run_id: "run-001",
      source_task_id: input.id,
      idempotency_key: "idem-001",
      source_owner: input.owner,
      priority: input.priority,
      priority_reason: input.priority_reason,
      priority_evidence: input.priority_evidence,
      evidence: input.evidence,
      dependencies: input.dependencies,
      risk: input.risk,
    }),
    status: "todo",
    completed_at: "0",
    url: "https://applink.feishu.cn/client/todo/detail/feishu-guid-001",
    ...overrides,
  };
}

beforeEach(async () => {
  temporaryDirectory = await mkdtemp(path.join(os.tmpdir(), "feishu-oauth-test-"));
  setFeishuIdentityStorePathForTests(path.join(temporaryDirectory, "feishu-identities.json"));
  setFeishuAppConfigPathForTests(path.join(temporaryDirectory, "feishu-app-config.env"));
  setFeishuConfigForTests(config);
  delete process.env.FEISHU_OAUTH_REDIRECT_VERIFIED;
  delete process.env.FEISHU_OAUTH_RETURN_URL;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.FRONTEND_PORT;
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.FEISHU_TASKLIST_GUID;
  delete process.env.FEISHU_TASKLIST_SECTION_GUID;
  delete process.env.FEISHU_DUE_REMINDER_MINUTES;
  delete process.env.FEISHU_SYNC_COMMENTS;
});

afterEach(async () => {
  clearFeishuConfigForTests();
  setFeishuIdentityStorePathForTests(null);
  setFeishuAppConfigPathForTests(null);
  delete process.env.FEISHU_OAUTH_REDIRECT_VERIFIED;
  delete process.env.FEISHU_OAUTH_RETURN_URL;
  delete process.env.APP_PUBLIC_URL;
  delete process.env.FRONTEND_PORT;
  delete process.env.FEISHU_APP_ID;
  delete process.env.FEISHU_APP_SECRET;
  delete process.env.FEISHU_TASKLIST_GUID;
  delete process.env.FEISHU_TASKLIST_SECTION_GUID;
  delete process.env.FEISHU_DUE_REMINDER_MINUTES;
  delete process.env.FEISHU_SYNC_COMMENTS;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  clearFeishuUserTokenCacheForTests();
  if (temporaryDirectory) await rm(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = "";
});

describe("feishu task connector", () => {
  it("caches the tenant token and maps create/read fields back to the Agent task", async () => {
    const stored = new Map<string, Record<string, unknown>>();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const task = {
          guid: "feishu-guid-001",
          summary: body.summary,
          description: body.description,
          due: body.due,
          members: Array.isArray(body.members)
            ? body.members.map((member) => ({ ...(member as Record<string, unknown>), name: "用户380273" }))
            : body.members,
          extra: body.extra,
          url: "https://applink.feishu.cn/client/todo/detail/feishu-guid-001",
          status: "todo",
          completed_at: "0",
        };
        stored.set("feishu-guid-001", task);
        return jsonResponse({ code: 0, msg: "success", data: { task } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001")) {
        return jsonResponse({ code: 0, msg: "success", data: { task: stored.get("feishu-guid-001") } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });

    const connector = createFeishuTaskConnector({ config, fetchImpl });
    const created = await connector.createTask("run-001", taskInput());
    const readback = await connector.getTask(created.task.id);

    expect(created).toMatchObject({ reused: false, task: {
      id: "feishu-guid-001",
      title: "确认扩容报价",
      owner: "张三",
      due_date: "2026-09-28",
      priority: "high",
      status: "in_progress",
      external_url: "https://applink.feishu.cn/client/todo/detail/feishu-guid-001",
    } });
    expect(readback).toMatchObject({
      id: "feishu-guid-001",
      source_run_id: "run-001",
      source_task_id: taskInput().id,
      owner: "张三",
      evidence: "张三：上线前必须完成扩容报价确认。",
      dependencies: ["等待供应商回复"],
    });
    expect(fetchImpl).toHaveBeenCalledTimes(3);
    expect(fetchImpl.mock.calls[0][0]).toContain("/tenant_access_token/internal");
    expect(JSON.stringify(fetchImpl.mock.calls[0][1]?.headers)).not.toContain("authorization");
    expect(JSON.stringify(fetchImpl.mock.calls[1][1]?.headers)).toContain("t-test");
  });

  it("creates Feishu tasks with source origin, configured tasklist, due reminders and optional activity comment", async () => {
    let createBody: Record<string, unknown> | null = null;
    const commentBodies: Record<string, unknown>[] = [];
    const reminderBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-rich/add_reminders") && init?.method === "POST") {
        reminderBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ code: 0, msg: "success", data: { reminders: [] } });
      }
      if (url.includes("/open-apis/task/v2/tasks") && init?.method === "POST") {
        createBody = JSON.parse(String(init.body)) as Record<string, unknown>;
        return jsonResponse({ code: 0, msg: "success", data: { task: {
          guid: "feishu-guid-rich",
          summary: createBody.summary,
          description: createBody.description,
          due: createBody.due,
          members: [{ id: "ou_zhangsan", type: "user", role: "assignee", name: "用户380273" }],
          extra: createBody.extra,
          status: "todo",
          completed_at: "0",
        } } });
      }
      if (url.includes("/open-apis/task/v2/comments") && init?.method === "POST") {
        commentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ code: 0, msg: "success", data: { comment: { comment_id: "comment-001" } } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({
      config: {
        ...config,
        tasklistGuid: "tasklist-001",
        tasklistSectionGuid: "section-001",
        dueReminderMinutes: [1440, 30],
        originUrl: "http://localhost:5174/#workflow",
        syncComments: true,
      },
      fetchImpl,
    });

    await expect(connector.createTask("run-rich-001", taskInput())).resolves.toMatchObject({
      task: { id: "feishu-guid-rich", owner: "张三", due_date: "2026-09-28" },
    });

    expect(createBody).toMatchObject({
      origin: {
        platform_i18n_name: { zh_cn: "会议行动智能体", en_us: "Meeting Action Agent" },
        href: { url: "http://localhost:5174/#workflow", title: "查看会议行动来源 run-rich" },
      },
      tasklists: [{ tasklist_guid: "tasklist-001", section_guid: "section-001" }],
    });
    expect(reminderBodies).toEqual([
      { reminders: [{ relative_fire_minute: 1440 }] },
      { reminders: [{ relative_fire_minute: 30 }] },
    ]);
    expect(commentBodies[0]).toMatchObject({
      resource_type: "task",
      resource_id: "feishu-guid-rich",
    });
    expect(String(commentBodies[0]?.content)).toContain("会议行动智能体已根据会议纪要创建此任务");
    expect(String(commentBodies[0]?.content)).toContain("原文依据");
    expect(connector.capabilities).toMatchObject({
      tasklists: true,
      reminders: true,
      comments: true,
      origin: true,
    });
  });

  it("syncs configured reminders to an existing Feishu task without recreating it", async () => {
    const reminderBodies: Record<string, unknown>[] = [];
    const commentBodies: Record<string, unknown>[] = [];
    let task: Record<string, unknown> = feishuStoredTask({ reminders: [] });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001/add_reminders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        reminderBodies.push(body);
        const reminders = body.reminders as Array<{ relative_fire_minute: number }>;
        task = { ...task, reminders: [...(task.reminders as unknown[] || []), ...reminders] };
        return jsonResponse({ code: 0, msg: "success", data: { reminders } });
      }
      if (url.includes("/open-apis/task/v2/comments") && init?.method === "POST") {
        commentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ code: 0, msg: "success", data: { comment: { comment_id: "comment-reminder" } } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({
      config: { ...config, dueReminderMinutes: [15], syncComments: true },
      fetchImpl,
    });

    await expect(connector.syncTaskSettings!("feishu-guid-001")).resolves.toMatchObject({
      task: { id: "feishu-guid-001", due_date: "2026-09-28" },
      applied: ["reminders"],
      issues: [],
    });

    expect(reminderBodies).toEqual([{ reminders: [{ relative_fire_minute: 15 }] }]);
    expect(commentBodies).toHaveLength(1);
    expect(String(commentBodies[0].content)).toContain("同步此任务的提醒规则");
  });

  it("replaces old Feishu reminders when syncing configured reminders", async () => {
    const addBodies: Record<string, unknown>[] = [];
    const removeBodies: Record<string, unknown>[] = [];
    const commentBodies: Record<string, unknown>[] = [];
    let task: Record<string, unknown> = feishuStoredTask({
      reminders: [{ id: "reminder-old-15", relative_fire_minute: 15 }],
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001/remove_reminders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        removeBodies.push(body);
        const reminderIds = new Set(body.reminder_ids as string[]);
        task = {
          ...task,
          reminders: (task.reminders as Array<{ id?: string; relative_fire_minute: number }>).filter((reminder) => !reminderIds.has(reminder.id || "")),
        };
        return jsonResponse({ code: 0, msg: "success", data: { task } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001/add_reminders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        addBodies.push(body);
        const reminders = (body.reminders as Array<{ relative_fire_minute: number }>).map((reminder) => ({
          id: `reminder-new-${reminder.relative_fire_minute}`,
          ...reminder,
        }));
        task = { ...task, reminders: [...(task.reminders as unknown[] || []), ...reminders] };
        return jsonResponse({ code: 0, msg: "success", data: { reminders } });
      }
      if (url.includes("/open-apis/task/v2/comments") && init?.method === "POST") {
        commentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ code: 0, msg: "success", data: { comment: { comment_id: "comment-reminder" } } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({
      config: { ...config, dueReminderMinutes: [60], syncComments: true },
      fetchImpl,
    });

    await expect(connector.syncTaskSettings!("feishu-guid-001")).resolves.toMatchObject({
      applied: ["reminders"],
      issues: [],
    });

    expect(removeBodies).toEqual([{ reminder_ids: ["reminder-old-15"] }]);
    expect(addBodies).toEqual([{ reminders: [{ relative_fire_minute: 60 }] }]);
    expect(task.reminders).toEqual([{ id: "reminder-new-60", relative_fire_minute: 60 }]);
    expect(String(commentBodies[0].content)).toContain("提前 1 小时");
  });

  it("reports a sync boundary when an old Feishu reminder lacks a removable id", async () => {
    const addBodies: Record<string, unknown>[] = [];
    const removeBodies: Record<string, unknown>[] = [];
    let task: Record<string, unknown> = feishuStoredTask({
      reminders: [{ relative_fire_minute: 15 }],
    });
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, msg: "ok", tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001/remove_reminders") && init?.method === "POST") {
        removeBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ code: 0, msg: "success", data: { task } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001/add_reminders") && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        addBodies.push(body);
        task = { ...task, reminders: [...(task.reminders as unknown[] || []), ...(body.reminders as unknown[])] };
        return jsonResponse({ code: 0, msg: "success", data: { reminders: body.reminders } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({
      config: { ...config, dueReminderMinutes: [60] },
      fetchImpl,
    });

    await expect(connector.syncTaskSettings!("feishu-guid-001")).resolves.toMatchObject({
      applied: ["reminders"],
      issues: ["有 1 条旧提醒缺少飞书 reminder id，无法自动移除。"],
    });

    expect(removeBodies).toEqual([]);
    expect(addBodies).toEqual([{ reminders: [{ relative_fire_minute: 60 }] }]);
  });

  it("uses a bound alias when legacy Feishu readback only returns a generated account name", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-legacy")) {
        return jsonResponse({ code: 0, data: { task: {
          guid: "feishu-guid-legacy",
          summary: "确认扩容报价",
          description: "在发布准备会上确认服务器扩容报价。",
          due: { timestamp: String(Date.parse("2026-09-28T00:00:00+08:00")), is_all_day: true },
          members: [{ id: "ou_zhangsan", role: "assignee", name: "用户380273" }],
          extra: JSON.stringify({
            source_run_id: "run-legacy",
            source_task_id: taskInput().id,
            idempotency_key: "legacy-key",
            priority: "high",
            priority_reason: "原文出现“上线前必须完成”。",
            priority_evidence: "上线前必须完成",
            evidence: "张三：上线前必须完成扩容报价确认。",
            dependencies: [],
            risk: null,
          }),
          status: "todo",
          completed_at: "0",
        } } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({
      config: { ...config, ownerMap: { 用户380273: "ou_zhangsan", 张三: "ou_zhangsan" } },
      fetchImpl,
    });

    await expect(connector.getTask("feishu-guid-legacy")).resolves.toMatchObject({
      owner: "张三",
      source_run_id: "run-legacy",
      source_task_id: taskInput().id,
    });
  });

  it("stops before a request when a Chinese owner has no Feishu ID mapping", async () => {
    const fetchImpl = vi.fn();
    const connector = createFeishuTaskConnector({
      config: { ...config, ownerMap: {} },
      fetchImpl,
    });

    await expect(connector.createTask("run-001", taskInput())).rejects.toMatchObject({
      code: "owner_mapping_missing",
      message: "飞书中找不到负责人“张三”的用户 ID 映射。",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("normalizes permission failures without exposing provider details", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (init?.method === "POST") return jsonResponse({ code: 1470403, msg: "private provider detail" }, 403);
      return jsonResponse({ code: 0, data: {} });
    });
    const connector = createFeishuTaskConnector({ config, fetchImpl });

    let caught: unknown;
    try {
      await connector.createTask("run-001", taskInput());
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(FeishuConnectorError);
    expect(caught).toMatchObject({
      code: "permission_denied",
      message: "飞书应用没有完成任务读写权限配置。",
    });
    expect(String(caught)).not.toContain("private provider detail");
  });

  it("writes in-progress/done status changes to Feishu and maps the readback", async () => {
    let task = feishuStoredTask();
    const patchBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchBodies.push(body);
        const patchTask = body.task as Record<string, unknown>;
        task = {
          ...task,
          ...patchTask,
          status: patchTask.completed_at && patchTask.completed_at !== "0" ? "done" : "todo",
        };
        return jsonResponse({ code: 0, data: { task } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({ config, fetchImpl });

    await expect(connector.updateStatus("feishu-guid-001", "done")).resolves.toMatchObject({ status: "done" });
    await expect(connector.updateStatus("feishu-guid-001", "in_progress")).resolves.toMatchObject({ status: "in_progress" });

    expect(patchBodies[0]).toMatchObject({ update_fields: ["completed_at"], task: { completed_at: expect.any(String) } });
    expect((patchBodies[0].task as Record<string, unknown>).completed_at).not.toBe("0");
    expect(patchBodies[1]).toEqual({ update_fields: ["completed_at"], task: { completed_at: "0" } });
  });

  it("adds optional activity comments after Feishu status and field updates", async () => {
    let task = feishuStoredTask();
    const commentBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        const patchTask = body.task as Record<string, unknown>;
        task = {
          ...task,
          ...patchTask,
          status: patchTask.completed_at && patchTask.completed_at !== "0" ? "done" : task.status,
        };
        return jsonResponse({ code: 0, data: { task } });
      }
      if (url.includes("/open-apis/task/v2/comments") && init?.method === "POST") {
        commentBodies.push(JSON.parse(String(init.body)) as Record<string, unknown>);
        return jsonResponse({ code: 0, data: { comment: { comment_id: `comment-${commentBodies.length}` } } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({ config: { ...config, syncComments: true }, fetchImpl });

    await expect(connector.updateStatus("feishu-guid-001", "done")).resolves.toMatchObject({ status: "done" });
    await expect(connector.updateTask!("feishu-guid-001", { due_date: "2026-10-02", priority: "medium" })).resolves.toMatchObject({
      due_date: "2026-10-02",
      priority: "medium",
    });

    expect(commentBodies).toHaveLength(2);
    expect(String(commentBodies[0].content)).toContain("同步为：已完成");
    expect(String(commentBodies[1].content)).toContain("截止日期");
    expect(String(commentBodies[1].content)).toContain("优先级");
  });

  it("updates editable Feishu fields and keeps Agent-only metadata in extra", async () => {
    let task = feishuStoredTask();
    const patchBodies: Record<string, unknown>[] = [];
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        patchBodies.push(body);
        task = { ...task, ...(body.task as Record<string, unknown>) };
        return jsonResponse({ code: 0, data: { task } });
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({
      config: { ...config, ownerMap: { 张三: "ou_zhangsan", 李四: "ou_lisi" } },
      fetchImpl,
    });

    await expect(connector.updateTask!("feishu-guid-001", {
      title: "更新后的扩容报价",
      description: "需要补充采购建议和验证截图。",
      due_date: "2026-10-02",
      priority: "low",
      priority_reason: "用户在追踪阶段调整为低优先级。",
      priority_evidence: null,
    })).resolves.toMatchObject({
      title: "更新后的扩容报价",
      description: "需要补充采购建议和验证截图。",
      owner: "张三",
      due_date: "2026-10-02",
      priority: "low",
      priority_reason: "用户在追踪阶段调整为低优先级。",
      priority_evidence: null,
    });

    const patchBody = patchBodies[0];
    expect(patchBody.update_fields).toEqual(expect.arrayContaining(["summary", "description", "due", "extra"]));
    expect(patchBody.update_fields).not.toContain("members");
    expect(patchBody.task).toMatchObject({
      summary: "更新后的扩容报价",
      description: "需要补充采购建议和验证截图。",
    });
    expect((patchBody.task as Record<string, unknown>).due).toMatchObject({ is_all_day: true });
    expect(JSON.parse(String((patchBody.task as Record<string, unknown>).extra))).toMatchObject({
      source_owner: "张三",
      priority: "low",
      priority_reason: "用户在追踪阶段调整为低优先级。",
      evidence: taskInput().evidence,
    });
  });

  it("keeps the core Feishu field update successful when optional comment sync is denied", async () => {
    let task = feishuStoredTask();
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task } });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "PATCH") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        task = { ...task, ...(body.task as Record<string, unknown>) };
        return jsonResponse({ code: 0, data: { task } });
      }
      if (url.includes("/open-apis/task/v2/comments") && init?.method === "POST") {
        return jsonResponse({ code: 1470403, msg: "comment permission missing" }, 403);
      }
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({ config: { ...config, syncComments: true }, fetchImpl });

    await expect(connector.updateTask!("feishu-guid-001", { title: "仍然可以改标题" })).resolves.toMatchObject({
      title: "仍然可以改标题",
      issues: ["飞书评论同步失败：应用缺少 task:comment:write 权限。"],
    });
    expect(fetchImpl.mock.calls.some(([input]) => String(input).includes("/open-apis/task/v2/comments"))).toBe(true);
  });

  it("stops Feishu owner edits before sending an unsupported member patch", async () => {
    const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/tenant_access_token/internal")) {
        return jsonResponse({ code: 0, tenant_access_token: "t-test", expire: 7200 });
      }
      if (url.includes("/open-apis/task/v2/tasks/feishu-guid-001") && init?.method === "GET") {
        return jsonResponse({ code: 0, data: { task: feishuStoredTask() } });
      }
      if (init?.method === "PATCH") return jsonResponse({ code: 0, data: { task: feishuStoredTask() } });
      return jsonResponse({ code: 404, msg: "unexpected request" }, 404);
    });
    const connector = createFeishuTaskConnector({ config, fetchImpl });

    await expect(connector.updateTask!("feishu-guid-001", { owner: "王五" })).rejects.toMatchObject({
      code: "unsupported",
      message: "飞书任务负责人需要通过成员增删接口调整，本阶段暂不支持从系统内修改负责人。",
    });
    expect(fetchImpl.mock.calls.some(([, init]) => init?.method === "PATCH")).toBe(false);
  });

  it("exposes Feishu unfinished tasks as in-progress in the system", async () => {
    const connector = createFeishuTaskConnector({ config, fetchImpl: vi.fn(async () => jsonResponse({})) as unknown as TestFetch });
    expect(connector.capabilities).toMatchObject({
      create: true,
      read: true,
      updateStatus: true,
      updateFields: true,
      statusValues: ["in_progress", "done"],
    });
  });
});

describe("feishu identity oauth", () => {
  it("lets the platform persist Feishu app credentials without editing .env", async () => {
    clearFeishuConfigForTests();

    await expect(getFeishuIntegrationStatus()).resolves.toMatchObject({
      configured: false,
      enabled: false,
    });

    await expect(savePersistentFeishuAppConfig({
      appId: "cli_saved_from_ui",
      appSecret: "secret-from-ui",
    })).resolves.toMatchObject({
      configured: true,
      enabled: true,
      appConfigSource: "persistent",
      baseURL: "https://open.feishu.cn",
      userIdType: "open_id",
    });

    await expect(getFeishuIntegrationStatus()).resolves.toMatchObject({
      configured: true,
      enabled: true,
      oauthEnabled: false,
      appConsoleUrl: "https://open.feishu.cn/app/cli_saved_from_ui/safe",
    });
  });

  it("keeps member binding closed until the redirect URL is verified by deployment", async () => {
    await expect(getFeishuIntegrationStatus()).resolves.toMatchObject({
      configured: true,
      oauthEnabled: false,
      appConsoleUrl: "https://open.feishu.cn/app/cli_test/safe",
      appPermissionUrl: "https://open.feishu.cn/app/cli_test/auth",
      mappedOwnerNames: ["张三"],
    });

    expect(() => createFeishuOAuthStart("张三")).toThrow("飞书身份绑定暂未开放");
  });

  it("generates an authorization URL only after deployment marks the redirect URL verified", async () => {
    process.env.FEISHU_OAUTH_REDIRECT_VERIFIED = "true";

    await expect(getFeishuIntegrationStatus()).resolves.toMatchObject({
      configured: true,
      oauthEnabled: true,
    });
    const result = createFeishuOAuthStart("张三");

    expect(result.authorizeUrl).toContain("https://open.feishu.cn/open-apis/authen/v1/index");
    expect(result.authorizeUrl).toContain("app_id=cli_test");
    expect(result.redirectUri).toContain("/api/integrations/feishu/oauth/callback");
  });

  it("stores a safe frontend return URL for the callback page", async () => {
    process.env.FEISHU_OAUTH_REDIRECT_VERIFIED = "true";

    const result = createFeishuOAuthStart("张三", "http://localhost:5173/#workflow");

    expect(result.returnUrl).toBe("http://localhost:5173/#workflow");
    expect(normalizeFeishuOAuthReturnUrl("https://evil.example/#workflow")).toBe("http://localhost:5174/#workflow");
  });

  it("allows deployment to configure the OAuth return URL", async () => {
    process.env.FEISHU_OAUTH_RETURN_URL = "https://demo.example.com/agent";

    expect(normalizeFeishuOAuthReturnUrl(undefined)).toBe("https://demo.example.com/agent#workflow");
    expect(normalizeFeishuOAuthReturnUrl("https://demo.example.com/agent#results")).toBe("https://demo.example.com/agent#results");
  });

  it("lets the platform persist redirect verification after the Feishu console save", async () => {
    await expect(getFeishuIntegrationStatus()).resolves.toMatchObject({
      configured: true,
      oauthEnabled: false,
    });

    await expect(markFeishuRedirectVerified()).resolves.toMatchObject({
      configured: true,
      oauthEnabled: true,
      redirectUri: "http://localhost:8788/api/integrations/feishu/oauth/callback",
    });

    const result = createFeishuOAuthStart("张三");
    expect(result.authorizeUrl).toContain("app_id=cli_test");
  });

  it("reads Feishu tasklists after a member grants temporary task access", async () => {
    process.env.FEISHU_OAUTH_REDIRECT_VERIFIED = "true";
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
      const url = String(input);
      if (url.endsWith("/app_access_token/internal")) {
        return jsonResponse({ code: 0, app_access_token: "app-token", expire: 7200 });
      }
      if (url.includes("/open-apis/authen/v1/access_token")) {
        return jsonResponse({ code: 0, data: { access_token: "user-token", expires_in: 7200 } });
      }
      if (url.includes("/open-apis/authen/v1/user_info")) {
        return jsonResponse({ code: 0, data: { open_id: "ou_zhangsan", name: "张三" } });
      }
      if (url.includes("/open-apis/task/v2/tasklists/search")) {
        return jsonResponse({ code: 0, data: { items: [{ guid: "tasklist-001", name: "项目清单" }] } });
      }
      if (url.includes("/open-apis/task/v2/tasklists/tasklist-001")) {
        return jsonResponse({ code: 0, data: { tasklist: { guid: "tasklist-001", name: "项目清单", sections: [{ guid: "section-001", name: "验收分组" }] } } });
      }
      return jsonResponse({ code: 99991672, msg: "permission denied" }, 403);
    });
    vi.stubGlobal("fetch", fetchMock);

    const start = createFeishuOAuthStart("张三");
    const state = new URL(start.authorizeUrl).searchParams.get("state")!;
    await completeFeishuOAuth({ code: "auth-code", state });

    await expect(searchFeishuTasklists({ query: "项目" })).resolves.toMatchObject({
      query: "项目",
      tokenUserName: "张三",
      items: [{
        id: "tasklist-001",
        name: "项目清单",
        sections: [{ id: "section-001", name: "验收分组" }],
      }],
    });
  });

  it("asks the user to rebind before tasklist discovery when no temporary token exists", async () => {
    process.env.FEISHU_OAUTH_REDIRECT_VERIFIED = "true";

    await expect(searchFeishuTasklists({ query: "项目" })).rejects.toMatchObject({
      status: 409,
    });
  });

  it("lets the platform persist Feishu tasklist, reminder and comment settings", async () => {
    clearFeishuConfigForTests();
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "secret-test";

    await expect(updateFeishuAdvancedSettings({
      tasklistGuid: "tasklist-001",
      tasklistSectionGuid: "section-001",
      dueReminderMinutes: "1440, 30",
      syncComments: true,
    })).resolves.toMatchObject({
      advancedSettingsSource: "persistent",
      tasklistGuid: "tasklist-001",
      tasklistSectionGuid: "section-001",
      tasklistConfigured: true,
      tasklistSectionConfigured: true,
      dueReminderMinutes: [1440, 30],
      dueReminderCount: 2,
      syncComments: true,
    });

    await expect(getFeishuIntegrationStatus()).resolves.toMatchObject({
      advancedSettingsSource: "persistent",
      tasklistGuid: "tasklist-001",
      dueReminderMinutes: [1440, 30],
      syncComments: true,
    });
  });

  it("accepts Feishu tasklist and section links when saving task write settings", async () => {
    clearFeishuConfigForTests();
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "secret-test";

    await expect(updateFeishuAdvancedSettings({
      tasklistGuid: "https://applink.feishu.cn/client/todo/tasklists/tasklist-link-001?tasklist_guid=tasklist-link-001",
      tasklistSectionGuid: "https://applink.feishu.cn/client/todo/tasklists/tasklist-link-001/sections/section-link-001",
      dueReminderMinutes: "120",
      syncComments: false,
    })).resolves.toMatchObject({
      tasklistGuid: "tasklist-link-001",
      tasklistSectionGuid: "section-link-001",
      dueReminderMinutes: [120],
      syncComments: false,
    });
  });

  it("rejects Feishu tasklist links that do not expose a tasklist value", async () => {
    clearFeishuConfigForTests();
    process.env.FEISHU_APP_ID = "cli_test";
    process.env.FEISHU_APP_SECRET = "secret-test";

    await expect(updateFeishuAdvancedSettings({
      tasklistGuid: "https://open.feishu.cn/app/cli_test/safe",
      dueReminderMinutes: "",
      syncComments: false,
    })).rejects.toMatchObject({
      status: 422,
    });
  });
});

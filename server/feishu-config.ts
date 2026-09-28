import { getPersistedFeishuAdvancedSettingsSync, getPersistedFeishuOwnerMapSync } from "./feishu-auth-store.ts";

export type FeishuConfig = {
  appId: string;
  appSecret: string;
  baseURL: string;
  userIdType: "open_id" | "union_id" | "user_id";
  ownerMap: Record<string, string>;
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  dueReminderMinutes: number[];
  originUrl: string | null;
  syncComments: boolean;
};

export type PublicFeishuConfig = {
  configured: boolean;
  baseURL: string | null;
  userIdType: FeishuConfig["userIdType"] | null;
  ownerCount: number;
  enabled: boolean;
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

let testConfig: FeishuConfig | null | undefined;

function normalizedBaseURL(value: string) {
  return value.trim().replace(/\/+$/, "") || "https://open.feishu.cn";
}

function parseUserIdType(value: string | undefined): FeishuConfig["userIdType"] {
  return value === "union_id" || value === "user_id" ? value : "open_id";
}

function parseOwnerMap(value: string | undefined) {
  if (!value?.trim()) return {};
  try {
    const parsed: unknown = JSON.parse(value);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .filter(([name, id]) => typeof name === "string" && name.trim() && typeof id === "string" && id.trim())
        .map(([name, id]) => [name.trim(), (id as string).trim()]),
    );
  } catch {
    return {};
  }
}

function optionalText(value: string | undefined) {
  const cleaned = value?.trim();
  return cleaned || null;
}

function parseBoolean(value: string | undefined, fallback = false) {
  if (value === undefined) return fallback;
  const normalized = value.trim().toLocaleLowerCase();
  if (["1", "true", "yes", "y", "on", "启用", "是"].includes(normalized)) return true;
  if (["0", "false", "no", "n", "off", "禁用", "否"].includes(normalized)) return false;
  return fallback;
}

function parseReminderMinutes(value: string | undefined) {
  if (!value?.trim()) return [];
  const minutes = value.split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 43_200);
  return [...new Set(minutes)];
}

function parseOriginUrl(value: string | undefined) {
  const cleaned = optionalText(value) || optionalText(process.env.APP_PUBLIC_URL);
  if (!cleaned) return null;
  try {
    const url = new URL(cleaned);
    return ["http:", "https:"].includes(url.protocol) ? url.toString() : null;
  } catch {
    return null;
  }
}

function envAdvancedSettings() {
  return {
    tasklistGuid: optionalText(process.env.FEISHU_TASKLIST_GUID),
    tasklistSectionGuid: optionalText(process.env.FEISHU_TASKLIST_SECTION_GUID),
    dueReminderMinutes: parseReminderMinutes(process.env.FEISHU_DUE_REMINDER_MINUTES),
    syncComments: parseBoolean(process.env.FEISHU_SYNC_COMMENTS, false),
  };
}

function resolveAdvancedSettings() {
  const persisted = getPersistedFeishuAdvancedSettingsSync();
  const environment = envAdvancedSettings();
  if (persisted) {
    return {
      source: "persistent" as const,
      settings: {
        tasklistGuid: persisted.tasklistGuid,
        tasklistSectionGuid: persisted.tasklistGuid ? persisted.tasklistSectionGuid : null,
        dueReminderMinutes: persisted.dueReminderMinutes,
        syncComments: persisted.syncComments,
      },
    };
  }
  const hasEnvironment = !!environment.tasklistGuid || !!environment.tasklistSectionGuid || environment.dueReminderMinutes.length > 0 || environment.syncComments;
  return {
    source: hasEnvironment ? "environment" as const : "none" as const,
    settings: {
      ...environment,
      tasklistSectionGuid: environment.tasklistGuid ? environment.tasklistSectionGuid : null,
    },
  };
}

function readEnvironmentConfig(): FeishuConfig | null {
  const appId = process.env.FEISHU_APP_ID?.trim() || "";
  const appSecret = process.env.FEISHU_APP_SECRET?.trim() || "";
  if (!appId || !appSecret) return null;
  const advanced = resolveAdvancedSettings().settings;
  return {
    appId,
    appSecret,
    baseURL: normalizedBaseURL(process.env.FEISHU_BASE_URL || ""),
    userIdType: parseUserIdType(process.env.FEISHU_USER_ID_TYPE),
    ownerMap: {
      ...getPersistedFeishuOwnerMapSync(),
      ...parseOwnerMap(process.env.FEISHU_OWNER_MAP_JSON),
    },
    tasklistGuid: advanced.tasklistGuid,
    tasklistSectionGuid: advanced.tasklistSectionGuid,
    dueReminderMinutes: advanced.dueReminderMinutes,
    originUrl: parseOriginUrl(process.env.FEISHU_ORIGIN_URL),
    syncComments: advanced.syncComments,
  };
}

export function getFeishuConfig() {
  return testConfig === undefined ? readEnvironmentConfig() : testConfig;
}

export function isFeishuConnectorEnabled() {
  return process.env.MEETING_AGENT_CONNECTOR === "feishu" && !!getFeishuConfig();
}

export function getPublicFeishuConfig(): PublicFeishuConfig {
  const config = getFeishuConfig();
  const advanced = config ? resolveAdvancedSettings() : null;
  return {
    configured: !!config,
    baseURL: config?.baseURL || null,
    userIdType: config?.userIdType || null,
    ownerCount: config ? Object.keys(config.ownerMap).length : 0,
    enabled: isFeishuConnectorEnabled(),
    advancedSettingsSource: advanced?.source || "none",
    tasklistGuid: config?.tasklistGuid || null,
    tasklistSectionGuid: config?.tasklistSectionGuid || null,
    tasklistConfigured: !!config?.tasklistGuid,
    tasklistSectionConfigured: !!config?.tasklistSectionGuid,
    dueReminderMinutes: config?.dueReminderMinutes || [],
    dueReminderCount: config?.dueReminderMinutes.length || 0,
    originUrlConfigured: !!config?.originUrl,
    syncComments: config?.syncComments === true,
  };
}

export function setFeishuConfigForTests(config: FeishuConfig | null | undefined) {
  testConfig = config;
}

export function clearFeishuConfigForTests() {
  testConfig = undefined;
}

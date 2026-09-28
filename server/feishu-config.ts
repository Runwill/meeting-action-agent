import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
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

let testConfig: FeishuConfig | null | undefined;
let appConfigPathOverride: string | null = null;

const APP_CONFIG_KEYS = {
  appId: "FEISHU_APP_ID_B64",
  appSecret: "FEISHU_APP_SECRET_B64",
  baseURL: "FEISHU_BASE_URL_B64",
  userIdType: "FEISHU_USER_ID_TYPE_B64",
  enabled: "MEETING_AGENT_CONNECTOR_B64",
} as const;

type PersistentFeishuAppConfig = {
  appId: string;
  appSecret: string;
  baseURL: string;
  userIdType: FeishuConfig["userIdType"];
  enabled: boolean;
};

export type FeishuAppConfigInput = {
  appId: string;
  appSecret: string;
  baseURL?: string | null;
  userIdType?: string | null;
  enabled?: boolean;
};

function feishuAppConfigPath() {
  return appConfigPathOverride || path.join(process.cwd(), "data", "feishu-app-config.env");
}

function encode(value: string) {
  return Buffer.from(value, "utf8").toString("base64");
}

function decode(value: string | undefined) {
  if (!value) return "";
  try {
    return Buffer.from(value, "base64").toString("utf8").trim();
  } catch {
    return "";
  }
}

function parsePersistentFile(content: string) {
  return new Map(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

function normalizedBaseURL(value: string) {
  return value.trim().replace(/\/+$/, "") || "https://open.feishu.cn";
}

function parseUserIdType(value: string | undefined): FeishuConfig["userIdType"] {
  return value === "union_id" || value === "user_id" ? value : "open_id";
}

function readPersistentAppConfigSync(): PersistentFeishuAppConfig | null {
  try {
    const values = parsePersistentFile(readFileSync(feishuAppConfigPath(), "utf8"));
    const appId = decode(values.get(APP_CONFIG_KEYS.appId));
    const appSecret = decode(values.get(APP_CONFIG_KEYS.appSecret));
    if (!appId || !appSecret) return null;
    const enabledValue = decode(values.get(APP_CONFIG_KEYS.enabled));
    return {
      appId,
      appSecret,
      baseURL: normalizedBaseURL(decode(values.get(APP_CONFIG_KEYS.baseURL))),
      userIdType: parseUserIdType(decode(values.get(APP_CONFIG_KEYS.userIdType))),
      enabled: enabledValue ? enabledValue === "feishu" : true,
    };
  } catch {
    return null;
  }
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
  if (testConfig !== undefined) return testConfig;
  const persisted = readPersistentAppConfigSync();
  if (persisted) {
    const advanced = resolveAdvancedSettings().settings;
    return {
      appId: persisted.appId,
      appSecret: persisted.appSecret,
      baseURL: persisted.baseURL,
      userIdType: persisted.userIdType,
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
  return readEnvironmentConfig();
}

export function isFeishuConnectorEnabled() {
  if (testConfig !== undefined) return !!testConfig && process.env.MEETING_AGENT_CONNECTOR === "feishu";
  const persisted = readPersistentAppConfigSync();
  if (persisted) return persisted.enabled && !!getFeishuConfig();
  return process.env.MEETING_AGENT_CONNECTOR === "feishu" && !!getFeishuConfig();
}

function appConfigSource(): PublicFeishuConfig["appConfigSource"] {
  if (testConfig !== undefined) return testConfig ? "test" : "none";
  if (readPersistentAppConfigSync()) return "persistent";
  return readEnvironmentConfig() ? "environment" : "none";
}

function previewAppId(appId: string | undefined) {
  if (!appId) return null;
  if (appId.length <= 10) return appId;
  return `${appId.slice(0, 6)}…${appId.slice(-4)}`;
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
    appConfigSource: appConfigSource(),
    appIdPreview: previewAppId(config?.appId),
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

function cleanFeishuAppConfig(input: unknown): PersistentFeishuAppConfig {
  const value = input && typeof input === "object" && !Array.isArray(input) ? input as FeishuAppConfigInput : {} as FeishuAppConfigInput;
  const appId = typeof value.appId === "string" ? value.appId.trim() : "";
  const appSecret = typeof value.appSecret === "string" ? value.appSecret.trim() : "";
  const baseURL = normalizedBaseURL(typeof value.baseURL === "string" ? value.baseURL : "");
  if (!appId || appId.length > 200) throw new Error("请输入有效的飞书 App ID。");
  if (!appSecret || appSecret.length > 1000) throw new Error("请输入有效的飞书 App Secret。");
  try {
    const url = new URL(baseURL);
    if (!["http:", "https:"].includes(url.protocol)) throw new Error();
  } catch {
    throw new Error("飞书开放平台地址必须是有效的 HTTP 或 HTTPS URL。");
  }
  return {
    appId,
    appSecret,
    baseURL,
    userIdType: parseUserIdType(typeof value.userIdType === "string" ? value.userIdType : undefined),
    enabled: value.enabled !== false,
  };
}

export async function savePersistentFeishuAppConfig(input: unknown) {
  const config = cleanFeishuAppConfig(input);
  const target = feishuAppConfigPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const content = [
    "# Local-only Feishu app configuration. Do not commit this file.",
    `${APP_CONFIG_KEYS.appId}=${encode(config.appId)}`,
    `${APP_CONFIG_KEYS.appSecret}=${encode(config.appSecret)}`,
    `${APP_CONFIG_KEYS.baseURL}=${encode(config.baseURL)}`,
    `${APP_CONFIG_KEYS.userIdType}=${encode(config.userIdType)}`,
    `${APP_CONFIG_KEYS.enabled}=${encode(config.enabled ? "feishu" : "local-task")}`,
    "",
  ].join("\n");
  await mkdir(path.dirname(target), { recursive: true });
  try {
    await writeFile(temporary, content, { encoding: "utf8", mode: 0o600 });
    await rename(temporary, target);
    await chmod(target, 0o600).catch(() => undefined);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => undefined);
    throw error;
  }
  return getPublicFeishuConfig();
}

export async function clearPersistentFeishuAppConfig() {
  await rm(feishuAppConfigPath(), { force: true });
  return getPublicFeishuConfig();
}

export function setFeishuConfigForTests(config: FeishuConfig | null | undefined) {
  testConfig = config;
}

export function clearFeishuConfigForTests() {
  testConfig = undefined;
}

export function setFeishuAppConfigPathForTests(value: string | null) {
  appConfigPathOverride = value;
}

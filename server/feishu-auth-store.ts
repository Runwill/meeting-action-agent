import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";

export type FeishuLinkedUser = {
  id: string;
  name: string;
  aliases: string[];
  openId: string;
  unionId: string | null;
  userId: string | null;
  email: string | null;
  linkedAt: string;
  updatedAt: string;
};

export type FeishuAdvancedSettings = {
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  dueReminderMinutes: number[];
  syncComments: boolean;
  updatedAt: string;
};

type FeishuIdentityStore = {
  schema_version: 2;
  users: FeishuLinkedUser[];
  oauthRedirect: {
    verified: boolean;
    redirectUri: string | null;
    verifiedAt: string | null;
  };
  advancedSettings: FeishuAdvancedSettings | null;
};

export type PublicFeishuLinkedUser = {
  id: string;
  name: string;
  aliases: string[];
  hasOpenId: boolean;
  emailPreview: string | null;
  linkedAt: string;
  updatedAt: string;
};

let identityStorePathForTests: string | null = null;

function emptyStore(): FeishuIdentityStore {
  return {
    schema_version: 2,
    users: [],
    oauthRedirect: {
      verified: false,
      redirectUri: null,
      verifiedAt: null,
    },
    advancedSettings: null,
  };
}

function identityStorePath() {
  return identityStorePathForTests
    || process.env.FEISHU_IDENTITY_STORE_PATH?.trim()
    || path.resolve(process.cwd(), "data/feishu-identities.json");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function cleanName(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function cleanText(value: unknown, maxLength = 500) {
  return typeof value === "string" ? value.trim().slice(0, maxLength) : "";
}

function cleanSettingText(value: unknown) {
  const text = cleanText(value, 200);
  return text && !/\s/.test(text) ? text : "";
}

function cleanNullable(value: unknown) {
  const text = cleanName(value);
  return text || null;
}

function cleanAliases(values: unknown) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map(cleanName).filter(Boolean))];
}

function migrateUser(value: unknown): FeishuLinkedUser | null {
  if (!isRecord(value)) return null;
  const openId = cleanName(value.openId);
  const name = cleanName(value.name);
  if (!openId || !name) return null;
  const now = new Date().toISOString();
  return {
    id: cleanName(value.id) || randomUUID(),
    name,
    aliases: cleanAliases(value.aliases),
    openId,
    unionId: cleanNullable(value.unionId),
    userId: cleanNullable(value.userId),
    email: cleanNullable(value.email),
    linkedAt: cleanName(value.linkedAt) || now,
    updatedAt: cleanName(value.updatedAt) || now,
  };
}

function migrateStore(value: unknown): FeishuIdentityStore {
  if (!isRecord(value) || !Array.isArray(value.users)) return emptyStore();
  const oauthRedirect = isRecord(value.oauthRedirect) ? value.oauthRedirect : {};
  const advancedSettings = migrateAdvancedSettings(value.advancedSettings);
  return {
    schema_version: 2,
    users: value.users.map(migrateUser).filter((user): user is FeishuLinkedUser => user !== null),
    oauthRedirect: {
      verified: oauthRedirect.verified === true,
      redirectUri: cleanText(oauthRedirect.redirectUri) || null,
      verifiedAt: cleanText(oauthRedirect.verifiedAt) || null,
    },
    advancedSettings,
  };
}

function migrateReminderMinutes(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .map((item) => Number(item))
    .filter((item) => Number.isInteger(item) && item >= 0 && item <= 43_200))]
    .slice(0, 6);
}

function migrateAdvancedSettings(value: unknown): FeishuAdvancedSettings | null {
  if (!isRecord(value)) return null;
  const updatedAt = cleanText(value.updatedAt) || new Date().toISOString();
  return {
    tasklistGuid: cleanSettingText(value.tasklistGuid) || null,
    tasklistSectionGuid: cleanSettingText(value.tasklistSectionGuid) || null,
    dueReminderMinutes: migrateReminderMinutes(value.dueReminderMinutes),
    syncComments: value.syncComments === true,
    updatedAt,
  };
}

async function loadStore() {
  try {
    return migrateStore(JSON.parse(await readFile(identityStorePath(), "utf8")));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    return emptyStore();
  }
}

async function saveStore(store: FeishuIdentityStore) {
  const targetPath = identityStorePath();
  const temporaryPath = `${targetPath}.tmp`;
  await mkdir(path.dirname(targetPath), { recursive: true });
  await writeFile(temporaryPath, JSON.stringify(store, null, 2), "utf8");
  await rename(temporaryPath, targetPath);
}

function maskEmail(email: string | null) {
  if (!email) return null;
  const [name, domain] = email.split("@");
  if (!name || !domain) return "已绑定邮箱";
  return `${name.slice(0, 1)}***@${domain}`;
}

export function publicFeishuUser(user: FeishuLinkedUser): PublicFeishuLinkedUser {
  return {
    id: user.id,
    name: user.name,
    aliases: user.aliases,
    hasOpenId: !!user.openId,
    emailPreview: maskEmail(user.email),
    linkedAt: user.linkedAt,
    updatedAt: user.updatedAt,
  };
}

export async function listFeishuLinkedUsers() {
  const store = await loadStore();
  return store.users.map(publicFeishuUser);
}

export async function markFeishuOAuthRedirectVerified(redirectUri: string) {
  const uri = cleanText(redirectUri);
  if (!uri) throw new Error("飞书 OAuth 回调地址不能为空。");
  const store = await loadStore();
  store.oauthRedirect = {
    verified: true,
    redirectUri: uri,
    verifiedAt: new Date().toISOString(),
  };
  await saveStore(store);
  return store.oauthRedirect;
}

export function isFeishuOAuthRedirectVerifiedSync(redirectUri: string) {
  const uri = cleanText(redirectUri);
  if (!uri) return false;
  try {
    const store = migrateStore(JSON.parse(readFileSync(identityStorePath(), "utf8")));
    return store.oauthRedirect.verified && store.oauthRedirect.redirectUri === uri;
  } catch {
    return false;
  }
}

export async function upsertFeishuLinkedUser(input: {
  name: string;
  openId: string;
  unionId?: string | null;
  userId?: string | null;
  email?: string | null;
  alias?: string | null;
}) {
  const name = cleanName(input.name);
  const openId = cleanName(input.openId);
  if (!name || !openId) throw new Error("飞书身份缺少姓名或 open_id。");
  const alias = cleanName(input.alias);
  const now = new Date().toISOString();
  const store = await loadStore();
  const index = store.users.findIndex((user) => user.openId === openId);
  const existing = index >= 0 ? store.users[index] : null;
  const aliases = [...new Set([...(existing?.aliases ?? []), alias].filter(Boolean))];
  const next: FeishuLinkedUser = {
    id: existing?.id || randomUUID(),
    name,
    aliases,
    openId,
    unionId: input.unionId?.trim() || existing?.unionId || null,
    userId: input.userId?.trim() || existing?.userId || null,
    email: input.email?.trim() || existing?.email || null,
    linkedAt: existing?.linkedAt || now,
    updatedAt: now,
  };
  if (index >= 0) store.users[index] = next;
  else store.users.push(next);
  await saveStore(store);
  return publicFeishuUser(next);
}

export function getPersistedFeishuOwnerMapSync() {
  try {
    const store = migrateStore(JSON.parse(readFileSync(identityStorePath(), "utf8")));
    const pairs = store.users.flatMap((user) => (
      [user.name, ...user.aliases].map((name) => [name, user.openId] as const)
    ));
    return Object.fromEntries(pairs.filter(([name, openId]) => name && openId));
  } catch {
    return {};
  }
}

export function getPersistedFeishuAdvancedSettingsSync() {
  try {
    const store = migrateStore(JSON.parse(readFileSync(identityStorePath(), "utf8")));
    return store.advancedSettings;
  } catch {
    return null;
  }
}

export async function saveFeishuAdvancedSettings(input: {
  tasklistGuid: string | null;
  tasklistSectionGuid: string | null;
  dueReminderMinutes: number[];
  syncComments: boolean;
}) {
  const tasklistGuid = cleanSettingText(input.tasklistGuid) || null;
  const tasklistSectionGuid = cleanSettingText(input.tasklistSectionGuid) || null;
  const settings: FeishuAdvancedSettings = {
    tasklistGuid,
    tasklistSectionGuid: tasklistGuid ? tasklistSectionGuid : null,
    dueReminderMinutes: migrateReminderMinutes(input.dueReminderMinutes),
    syncComments: input.syncComments === true,
    updatedAt: new Date().toISOString(),
  };
  const store = await loadStore();
  store.advancedSettings = settings;
  await saveStore(store);
  return settings;
}

export function setFeishuIdentityStorePathForTests(filePath: string | null) {
  identityStorePathForTests = filePath;
}

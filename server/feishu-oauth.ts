import { randomBytes } from "node:crypto";
import { getFeishuConfig, getPublicFeishuConfig } from "./feishu-config.ts";
import { isFeishuOAuthRedirectVerifiedSync, listFeishuLinkedUsers, markFeishuOAuthRedirectVerified as markStoredFeishuOAuthRedirectVerified, saveFeishuAdvancedSettings, upsertFeishuLinkedUser } from "./feishu-auth-store.ts";

type OAuthState = {
  alias: string | null;
  returnUrl: string;
  createdAt: number;
};

type CachedUserToken = {
  accessToken: string;
  expiresAt: number;
  openId: string;
  name: string;
};

type FeishuApiResponse<T> = {
  code?: number;
  msg?: string;
  data?: T;
};

type AppAccessTokenResponse = {
  code?: number;
  msg?: string;
  app_access_token?: string;
  expire?: number;
};

type UserAccessTokenResponse = {
  access_token?: string;
  token_type?: string;
  expires_in?: number;
  refresh_token?: string;
};

type UserInfoResponse = {
  name?: string;
  en_name?: string;
  open_id?: string;
  union_id?: string;
  user_id?: string;
  email?: string;
};

type FeishuTasklistSection = {
  guid?: string;
  section_guid?: string;
  id?: string;
  name?: string;
  summary?: string;
  title?: string;
};

type FeishuTasklist = {
  guid?: string;
  tasklist_guid?: string;
  id?: string;
  name?: string;
  summary?: string;
  title?: string;
  url?: string;
  sections?: FeishuTasklistSection[];
  tasklist_sections?: FeishuTasklistSection[];
};

type FeishuTasklistSearchResponse = {
  items?: FeishuTasklist[];
  tasklists?: FeishuTasklist[];
  tasklist?: FeishuTasklist[];
};

type FeishuTasklistDetailResponse = {
  tasklist?: FeishuTasklist;
};

export class FeishuOAuthError extends Error {
  constructor(message: string, public readonly status = 400) {
    super(message);
    this.name = "FeishuOAuthError";
  }
}

const pendingStates = new Map<string, OAuthState>();
const userTokenCache = new Map<string, CachedUserToken>();
const stateTtlMs = 10 * 60 * 1000;

function redirectUri() {
  return process.env.FEISHU_OAUTH_REDIRECT_URI?.trim()
    || `http://localhost:${process.env.PORT || 8788}/api/integrations/feishu/oauth/callback`;
}

function appendWorkflowHash(value: string) {
  const url = new URL(value);
  if (!url.hash) url.hash = "workflow";
  return url.toString();
}

export function defaultFeishuOAuthReturnUrl() {
  const explicit = process.env.FEISHU_OAUTH_RETURN_URL?.trim() || process.env.APP_PUBLIC_URL?.trim();
  if (explicit) {
    try {
      return appendWorkflowHash(explicit);
    } catch {
      // Fall through to the local demo default if an optional public URL is malformed.
    }
  }
  if (process.env.NODE_ENV === "production") return "/#workflow";
  return `http://localhost:${process.env.FRONTEND_PORT || 5174}/#workflow`;
}

function allowedReturnHosts() {
  const hosts = new Set(["localhost", "127.0.0.1", "::1"]);
  const explicit = process.env.FEISHU_OAUTH_RETURN_URL?.trim() || process.env.APP_PUBLIC_URL?.trim();
  if (explicit) {
    try {
      hosts.add(new URL(explicit).hostname);
    } catch {
      // Ignore invalid optional deployment hints and fall back to localhost development URLs.
    }
  }
  return hosts;
}

export function normalizeFeishuOAuthReturnUrl(value: unknown) {
  if (typeof value !== "string" || !value.trim()) return defaultFeishuOAuthReturnUrl();
  try {
    const url = new URL(value.trim());
    if (!["http:", "https:"].includes(url.protocol)) return defaultFeishuOAuthReturnUrl();
    if (!allowedReturnHosts().has(url.hostname)) return defaultFeishuOAuthReturnUrl();
    if (!url.hash) url.hash = "workflow";
    return url.toString();
  } catch {
    return defaultFeishuOAuthReturnUrl();
  }
}

function appConsoleUrl(appId: string, baseURL: string, page: "safe" | "auth" = "safe") {
  return new URL(`/app/${encodeURIComponent(appId)}/${page}`, baseURL).toString();
}

function isOAuthRedirectVerified() {
  return process.env.FEISHU_OAUTH_REDIRECT_VERIFIED === "true"
    || isFeishuOAuthRedirectVerifiedSync(redirectUri());
}

function cleanAlias(value: unknown) {
  return typeof value === "string" ? value.trim().slice(0, 80) : "";
}

function safeDecodeSettingValue(value: string) {
  try {
    return decodeURIComponent(value.replace(/\+/g, "%20")).trim();
  } catch {
    return value.trim();
  }
}

function settingValueLooksLikeUrl(value: string) {
  return /^https?:\/\//i.test(value) || /(?:^|\.)feishu\.cn(?:\/|$)/i.test(value) || /(?:^|\.)larksuite\.com(?:\/|$)/i.test(value);
}

function normalizeSettingParamKey(value: string) {
  return value.toLowerCase().replace(/[-_]/g, "");
}

function extractSettingValueFromUrl(value: string, kind: "tasklist" | "section") {
  const targetKeys = kind === "tasklist"
    ? new Set(["tasklistguid", "tasklistid", "tasklist", "tasklisttoken", "listguid", "listid"])
    : new Set(["sectionguid", "sectionid", "section", "groupguid", "groupid", "tasklistsectionguid", "tasklistsectionid"]);
  try {
    const url = new URL(/^https?:\/\//i.test(value) ? value : `https://${value}`);
    for (const [key, raw] of url.searchParams) {
      if (!targetKeys.has(normalizeSettingParamKey(key))) continue;
      const decoded = safeDecodeSettingValue(raw);
      if (decoded) return decoded;
    }
  } catch {
    // Keep trying text patterns below.
  }

  const text = safeDecodeSettingValue(value);
  const pathPattern = kind === "tasklist"
    ? /(?:tasklists?|task[_-]?lists?|lists?)[/:=]+([A-Za-z0-9][A-Za-z0-9._:-]{2,199})/i
    : /(?:sections?|groups?)[/:=]+([A-Za-z0-9][A-Za-z0-9._:-]{2,199})/i;
  const namedPattern = kind === "tasklist"
    ? /(?:tasklist[_-]?guid|task[_-]?list[_-]?guid|tasklist[_-]?id|tasklist)[=:]+([A-Za-z0-9][A-Za-z0-9._:-]{2,199})/i
    : /(?:section[_-]?guid|tasklist[_-]?section[_-]?guid|section[_-]?id|section|group[_-]?guid|group[_-]?id)[=:]+([A-Za-z0-9][A-Za-z0-9._:-]{2,199})/i;
  const prefixedPattern = kind === "tasklist"
    ? /\b(tasklist[-_][A-Za-z0-9._:-]{2,199})\b/i
    : /\b(section[-_][A-Za-z0-9._:-]{2,199})\b/i;
  return pathPattern.exec(text)?.[1] || namedPattern.exec(text)?.[1] || prefixedPattern.exec(text)?.[1] || null;
}

function cleanSettingGuid(value: unknown, kind: "tasklist" | "section") {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") throw new FeishuOAuthError("飞书清单和分组配置必须是文本。", 422);
  const cleaned = value.trim();
  if (!cleaned) return null;
  const extracted = settingValueLooksLikeUrl(cleaned) ? extractSettingValueFromUrl(cleaned, kind) : extractSettingValueFromUrl(cleaned, kind) || cleaned;
  if (!extracted && settingValueLooksLikeUrl(cleaned)) {
    throw new FeishuOAuthError(kind === "tasklist"
      ? "没有从飞书链接中识别出清单。请打开具体清单后复制链接，或在高级填写中输入清单 ID。"
      : "没有从飞书链接中识别出分组。请打开具体分组后复制链接，或在高级填写中输入分组 ID。", 422);
  }
  if (!extracted) return null;
  const normalized = extracted.trim();
  if (normalized.length > 200 || /\s/.test(normalized)) {
    throw new FeishuOAuthError("飞书清单或分组值不能包含空格，且长度不能超过 200。", 422);
  }
  if (settingValueLooksLikeUrl(cleaned) && normalized === cleaned) {
    throw new FeishuOAuthError(kind === "tasklist"
      ? "没有从飞书链接中识别出清单。请打开具体清单后复制链接，或在高级填写中输入清单 ID。"
      : "没有从飞书链接中识别出分组。请打开具体分组后复制链接，或在高级填写中输入分组 ID。", 422);
  }
  return normalized;
}

function parseReminderMinutes(value: unknown) {
  const rawItems = Array.isArray(value)
    ? value
    : typeof value === "string"
      ? value.split(",")
      : value === null || value === undefined
        ? []
        : [value];
  const minutes = rawItems.map((item) => {
    const number = typeof item === "number" ? item : Number(String(item).trim());
    if (!Number.isInteger(number) || number < 0 || number > 43_200) {
      throw new FeishuOAuthError("提醒规则必须是 0 到 43200 之间的整数分钟数，可用逗号分隔。", 422);
    }
    return number;
  });
  const unique = [...new Set(minutes)];
  if (unique.length > 6) throw new FeishuOAuthError("提醒规则最多保存 6 条。", 422);
  return unique;
}

function parseAdvancedSettingsInput(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const tasklistGuid = cleanSettingGuid(input.tasklistGuid, "tasklist");
  const tasklistSectionGuid = cleanSettingGuid(input.tasklistSectionGuid, "section");
  if (tasklistSectionGuid && !tasklistGuid) {
    throw new FeishuOAuthError("指定清单分组前，需要先填写或粘贴飞书清单。", 422);
  }
  if (input.syncComments !== undefined && typeof input.syncComments !== "boolean") {
    throw new FeishuOAuthError("评论同步开关必须是布尔值。", 422);
  }
  return {
    tasklistGuid,
    tasklistSectionGuid,
    dueReminderMinutes: parseReminderMinutes(input.dueReminderMinutes),
    syncComments: input.syncComments === true,
  };
}

function assertConfigured() {
  const config = getFeishuConfig();
  if (!config) throw new FeishuOAuthError("飞书应用尚未配置 App ID 和 App Secret。", 409);
  return config;
}

function assertOAuthReady() {
  const config = assertConfigured();
  if (!isOAuthRedirectVerified()) {
    throw new FeishuOAuthError("飞书身份绑定暂未开放：部署人员还需要在飞书开放平台登记并核验 OAuth 回调地址。", 409);
  }
  return config;
}

function parseApiResponse<T>(value: unknown): FeishuApiResponse<T> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as FeishuApiResponse<T> : {};
}

function pruneStates() {
  const now = Date.now();
  for (const [state, value] of pendingStates) {
    if (now - value.createdAt > stateTtlMs) pendingStates.delete(state);
  }
  for (const [openId, value] of userTokenCache) {
    if (value.expiresAt <= now + 30_000) userTokenCache.delete(openId);
  }
}

export async function getFeishuIntegrationStatus() {
  pruneStates();
  const config = getFeishuConfig();
  const publicConfig = getPublicFeishuConfig();
  return {
    configured: !!config,
    enabled: process.env.MEETING_AGENT_CONNECTOR === "feishu" && !!config,
    oauthEnabled: !!config && isOAuthRedirectVerified(),
    redirectUri: config ? redirectUri() : null,
    appConsoleUrl: config ? appConsoleUrl(config.appId, config.baseURL) : null,
    appPermissionUrl: config ? appConsoleUrl(config.appId, config.baseURL, "auth") : null,
    mappedOwnerNames: config ? Object.keys(config.ownerMap).sort((a, b) => a.localeCompare(b, "zh-Hans-CN")) : [],
    advancedSettingsSource: publicConfig.advancedSettingsSource,
    tasklistGuid: config?.tasklistGuid || null,
    tasklistSectionGuid: config?.tasklistSectionGuid || null,
    tasklistConfigured: !!config?.tasklistGuid,
    tasklistSectionConfigured: !!config?.tasklistSectionGuid,
    dueReminderMinutes: config?.dueReminderMinutes || [],
    dueReminderCount: config?.dueReminderMinutes.length || 0,
    originUrlConfigured: !!config?.originUrl,
    syncComments: config?.syncComments === true,
    tasklistDiscoveryReady: userTokenCache.size > 0,
    linkedUsers: await listFeishuLinkedUsers(),
  };
}

export async function updateFeishuAdvancedSettings(input: unknown) {
  assertConfigured();
  await saveFeishuAdvancedSettings(parseAdvancedSettingsInput(input));
  return getFeishuIntegrationStatus();
}

export async function markFeishuRedirectVerified() {
  assertConfigured();
  await markStoredFeishuOAuthRedirectVerified(redirectUri());
  return getFeishuIntegrationStatus();
}

export function createFeishuOAuthStart(aliasInput?: unknown, returnUrlInput?: unknown) {
  const config = assertOAuthReady();
  pruneStates();
  const state = randomBytes(24).toString("base64url");
  const alias = cleanAlias(aliasInput) || null;
  const returnUrl = normalizeFeishuOAuthReturnUrl(returnUrlInput);
  pendingStates.set(state, { alias, returnUrl, createdAt: Date.now() });
  const url = new URL(`${config.baseURL}/open-apis/authen/v1/index`);
  url.searchParams.set("app_id", config.appId);
  url.searchParams.set("redirect_uri", redirectUri());
  url.searchParams.set("state", state);
  return { authorizeUrl: url.toString(), redirectUri: redirectUri(), returnUrl };
}

async function getAppAccessToken() {
  const config = assertConfigured();
  const response = await fetch(`${config.baseURL}/open-apis/auth/v3/app_access_token/internal`, {
    method: "POST",
    headers: { "Content-Type": "application/json; charset=utf-8" },
    body: JSON.stringify({ app_id: config.appId, app_secret: config.appSecret }),
  });
  const payload = await response.json().catch(() => null) as AppAccessTokenResponse | null;
  if (!response.ok || !payload || payload.code !== 0 || !payload.app_access_token) {
    throw new FeishuOAuthError("飞书应用鉴权失败，请检查 App ID、App Secret 和应用状态。", 502);
  }
  return payload.app_access_token;
}

async function exchangeCode(code: string) {
  const config = assertConfigured();
  const appAccessToken = await getAppAccessToken();
  const response = await fetch(`${config.baseURL}/open-apis/authen/v1/access_token`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      Authorization: `Bearer ${appAccessToken}`,
    },
    body: JSON.stringify({ grant_type: "authorization_code", code }),
  });
  const payload = parseApiResponse<UserAccessTokenResponse>(await response.json().catch(() => null));
  if (!response.ok || payload.code !== 0 || !payload.data?.access_token) {
    throw new FeishuOAuthError("飞书授权码换取用户令牌失败，请检查回调地址和应用权限。", 502);
  }
  return {
    accessToken: payload.data.access_token,
    expiresIn: typeof payload.data.expires_in === "number" ? payload.data.expires_in : 7200,
  };
}

async function getUserInfo(userAccessToken: string) {
  const config = assertConfigured();
  const response = await fetch(`${config.baseURL}/open-apis/authen/v1/user_info`, {
    method: "GET",
    headers: { Authorization: `Bearer ${userAccessToken}` },
  });
  const payload = parseApiResponse<UserInfoResponse>(await response.json().catch(() => null));
  if (!response.ok || payload.code !== 0 || !payload.data?.open_id) {
    throw new FeishuOAuthError("飞书用户信息读取失败，请确认授权范围。", 502);
  }
  return payload.data;
}

export async function completeFeishuOAuth(input: { code: unknown; state: unknown }) {
  const code = typeof input.code === "string" ? input.code.trim() : "";
  const state = typeof input.state === "string" ? input.state.trim() : "";
  if (!code || !state) throw new FeishuOAuthError("飞书授权回调缺少 code 或 state。", 400);
  pruneStates();
  const pending = pendingStates.get(state);
  if (!pending) throw new FeishuOAuthError("飞书授权状态已失效，请重新发起绑定。", 400);
  pendingStates.delete(state);
  const token = await exchangeCode(code);
  const user = await getUserInfo(token.accessToken);
  const name = cleanAlias(user.name) || cleanAlias(user.en_name) || "飞书用户";
  const userRecord = await upsertFeishuLinkedUser({
    name,
    openId: user.open_id!,
    unionId: user.union_id || null,
    userId: user.user_id || null,
    email: user.email || null,
    alias: pending.alias,
  });
  userTokenCache.set(user.open_id!, {
    accessToken: token.accessToken,
    expiresAt: Date.now() + Math.max(60, token.expiresIn - 60) * 1000,
    openId: user.open_id!,
    name: userRecord.name,
  });
  return { user: userRecord, returnUrl: pending.returnUrl };
}

function pickText(...values: unknown[]) {
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  return "";
}

function mapTasklistSection(value: FeishuTasklistSection) {
  const id = pickText(value.section_guid, value.guid, value.id);
  if (!id) return null;
  return {
    id,
    name: pickText(value.name, value.summary, value.title) || `分组 ${id.slice(0, 8)}`,
  };
}

function mapTasklistOption(value: FeishuTasklist) {
  const id = pickText(value.tasklist_guid, value.guid, value.id);
  if (!id) return null;
  const sections = [...(value.sections || []), ...(value.tasklist_sections || [])]
    .map(mapTasklistSection)
    .filter((item): item is { id: string; name: string } => !!item);
  return {
    id,
    name: pickText(value.name, value.summary, value.title) || `清单 ${id.slice(0, 8)}`,
    url: pickText(value.url) || null,
    sections,
  };
}

async function feishuUserRequest<T>(path: string, accessToken: string, init: RequestInit = {}) {
  const config = assertConfigured();
  const response = await fetch(`${config.baseURL}${path}`, {
    ...init,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      ...(init.headers || {}),
      Authorization: `Bearer ${accessToken}`,
    },
  });
  const payload = parseApiResponse<T>(await response.json().catch(() => null));
  const apiCode = typeof payload.code === "number" ? payload.code : 0;
  if (!response.ok || apiCode !== 0) {
    if (response.status === 401 || response.status === 403 || [1470403, 99991672].includes(apiCode)) {
      throw new FeishuOAuthError("飞书应用缺少任务清单读取权限，或当前成员还没有授权任务清单读取。请在飞书开放平台开通任务清单读取权限并重新绑定成员。", 403);
    }
    const hint = typeof payload.msg === "string" && payload.msg.trim() ? `：${payload.msg.slice(0, 160)}` : "";
    throw new FeishuOAuthError(`飞书清单读取失败${hint}`, response.status || 502);
  }
  return (payload.data || {}) as T;
}

function getActiveUserToken() {
  pruneStates();
  const token = [...userTokenCache.values()].sort((a, b) => b.expiresAt - a.expiresAt)[0];
  if (!token) {
    throw new FeishuOAuthError("读取飞书清单需要临时用户授权。请先在平台连接中重新绑定一次飞书成员，然后再搜索清单。", 409);
  }
  return token;
}

function parseTasklistSearchInput(value: unknown) {
  const input = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
  const query = typeof input.query === "string" ? input.query.trim().slice(0, 80) : "";
  if (!query) throw new FeishuOAuthError("请先输入飞书清单名称关键词，再读取清单。", 422);
  return { query };
}

export async function searchFeishuTasklists(input: unknown) {
  const config = assertOAuthReady();
  const { query } = parseTasklistSearchInput(input);
  const userToken = getActiveUserToken();
  const search = await feishuUserRequest<FeishuTasklistSearchResponse>(
    `/open-apis/task/v2/tasklists/search?user_id_type=${config.userIdType}`,
    userToken.accessToken,
    { method: "POST", body: JSON.stringify({ query }) },
  );
  const rawItems = search.items || search.tasklists || search.tasklist || [];
  const results = await Promise.all(rawItems.map(async (item) => {
    const option = mapTasklistOption(item);
    if (!option) return null;
    if (option.sections.length) return option;
    try {
      const detail = await feishuUserRequest<FeishuTasklistDetailResponse>(
        `/open-apis/task/v2/tasklists/${encodeURIComponent(option.id)}?user_id_type=${config.userIdType}`,
        userToken.accessToken,
        { method: "GET" },
      );
      return mapTasklistOption(detail.tasklist || item) || option;
    } catch {
      return option;
    }
  }));
  return {
    query,
    tokenUserName: userToken.name,
    items: results.filter((item): item is NonNullable<typeof item> => !!item).slice(0, 20),
  };
}

export function clearFeishuUserTokenCacheForTests() {
  userTokenCache.clear();
}

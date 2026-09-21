import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export type ModelConfigInput = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export type ModelConfigSource = "runtime" | "persistent" | "environment";

export type ResolvedModelConfig = ModelConfigInput & {
  source: ModelConfigSource;
};

let runtimeConfig: ModelConfigInput | null = null;
let persistentConfig: ModelConfigInput | null = null;
let persistentConfigLoaded = false;
let configPathOverride: string | null = null;

const CONFIG_KEYS = {
  baseURL: "MEETING_AGENT_BASE_URL_B64",
  apiKey: "MEETING_AGENT_API_KEY_B64",
  model: "MEETING_AGENT_MODEL_B64",
} as const;

function modelConfigPath() {
  return configPathOverride || path.join(process.cwd(), "data", "model-config.env");
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

function parsePersistentConfig(content: string): ModelConfigInput | null {
  const values = new Map(
    content
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        return separator < 1 ? [line, ""] : [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
  const config = {
    baseURL: decode(values.get(CONFIG_KEYS.baseURL)),
    apiKey: decode(values.get(CONFIG_KEYS.apiKey)),
    model: decode(values.get(CONFIG_KEYS.model)),
  };
  return config.baseURL && config.apiKey && config.model ? config : null;
}

async function loadPersistentConfig() {
  if (persistentConfigLoaded) return persistentConfig;
  persistentConfigLoaded = true;
  try {
    persistentConfig = parsePersistentConfig(await readFile(modelConfigPath(), "utf8"));
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? error.code : null;
    if (code !== "ENOENT") console.warn("Saved model configuration could not be read.");
    persistentConfig = null;
  }
  return persistentConfig;
}

export function providerFromURL(baseURL: string) {
  const value = baseURL.toLowerCase();
  if (value.includes("deepseek.com")) return "DeepSeek";
  if (value.includes("openai.com")) return "OpenAI";
  return "Compatible API";
}

export async function getModelConfig(): Promise<ResolvedModelConfig | null> {
  if (runtimeConfig) return { ...runtimeConfig, source: "runtime" };

  const saved = await loadPersistentConfig();
  if (saved) return { ...saved, source: "persistent" };

  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) return null;

  return {
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL?.trim() || "https://api.openai.com/v1",
    model: process.env.OPENAI_MODEL?.trim() || "gpt-4o-mini",
    source: "environment",
  };
}

export function setRuntimeModelConfig(config: ModelConfigInput) {
  runtimeConfig = { ...config };
}

export function clearRuntimeModelConfig() {
  runtimeConfig = null;
}

export async function savePersistentModelConfig(config: ModelConfigInput) {
  const target = modelConfigPath();
  const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
  const content = [
    "# Local-only model configuration. Do not commit this file.",
    `${CONFIG_KEYS.baseURL}=${encode(config.baseURL)}`,
    `${CONFIG_KEYS.apiKey}=${encode(config.apiKey)}`,
    `${CONFIG_KEYS.model}=${encode(config.model)}`,
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

  runtimeConfig = null;
  persistentConfig = { ...config };
  persistentConfigLoaded = true;
  return getPublicModelConfig();
}

export async function clearPersistentModelConfig() {
  await rm(modelConfigPath(), { force: true });
  runtimeConfig = null;
  persistentConfig = null;
  persistentConfigLoaded = true;
  return getPublicModelConfig();
}

export function setModelConfigPathForTests(value: string | null) {
  configPathOverride = value;
  runtimeConfig = null;
  persistentConfig = null;
  persistentConfigLoaded = false;
}

function previewSecret(secret: string) {
  if (secret.length <= 8) return `${secret.slice(0, 2)}••••`;
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}

export async function getPublicModelConfig() {
  const config = await getModelConfig();
  if (!config) {
    return {
      configured: false,
      source: null,
      provider: "未连接",
      baseURL: null,
      model: null,
      apiKeyPreview: null,
    };
  }

  return {
    configured: true,
    source: config.source,
    provider: providerFromURL(config.baseURL),
    baseURL: config.baseURL,
    model: config.model,
    apiKeyPreview: previewSecret(config.apiKey),
  };
}

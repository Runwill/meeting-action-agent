export type ModelConfigInput = {
  baseURL: string;
  apiKey: string;
  model: string;
};

export type ModelConfigSource = "runtime" | "environment" | "local";

export type ResolvedModelConfig = ModelConfigInput & {
  source: Exclude<ModelConfigSource, "local">;
};

let runtimeConfig: ModelConfigInput | null = null;

export function providerFromURL(baseURL: string) {
  const value = baseURL.toLowerCase();
  if (value.includes("deepseek.com")) return "DeepSeek";
  if (value.includes("openai.com")) return "OpenAI";
  return "Compatible API";
}

export function getModelConfig(): ResolvedModelConfig | null {
  if (runtimeConfig) return { ...runtimeConfig, source: "runtime" };

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

function previewSecret(secret: string) {
  if (secret.length <= 8) return `${secret.slice(0, 2)}••••`;
  return `${secret.slice(0, 3)}••••${secret.slice(-4)}`;
}

export function getPublicModelConfig() {
  const config = getModelConfig();
  if (!config) {
    return {
      configured: false,
      source: "local" as const,
      provider: "Local rules",
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

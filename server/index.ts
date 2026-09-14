import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { analyzeMeeting } from "./analyze.ts";
import OpenAI from "openai";
import { clearRuntimeModelConfig, getPublicModelConfig, setRuntimeModelConfig } from "./runtime-config.ts";
import { ApprovalPayloadSchema, ClarificationPayloadSchema, TaskStatusSchema, answerAgentQuestions, approveAndExecute, createAgentRun, getAgentRun, refreshTracking, updateExternalTaskStatus } from "./agent.ts";

const app = express();
const port = Number(process.env.PORT || 8788);
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", (_request, response) => {
  const config = getPublicModelConfig();
  response.json({
    ok: true,
    engine: config.configured ? "ai" : "local",
    ...config,
  });
});

app.get("/api/config", (_request, response) => {
  response.json(getPublicModelConfig());
});

function validateModelConfig(body: unknown) {
  const value = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const baseURL = typeof value.baseURL === "string" ? value.baseURL.trim().replace(/\/$/, "") : "";
  const apiKey = typeof value.apiKey === "string" ? value.apiKey.trim() : "";
  const model = typeof value.model === "string" ? value.model.trim() : "";

  if (!baseURL || baseURL.length > 500) throw new Error("请输入有效的 API 地址。");
  try {
    const url = new URL(baseURL);
    if (!/^https?:$/.test(url.protocol)) throw new Error();
  } catch {
    throw new Error("API 地址必须是有效的 HTTP 或 HTTPS URL。");
  }
  if (!apiKey || apiKey.length > 1000) throw new Error("请输入有效的 API Key。");
  if (!model || model.length > 200) throw new Error("请输入模型名称。");
  return { baseURL, apiKey, model };
}

async function testModelConnection(config: ReturnType<typeof validateModelConfig>) {
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 20_000, maxRetries: 0 });
  const result = await client.chat.completions.create({
    model: config.model,
    messages: [{ role: "user", content: "Reply with exactly: OK" }],
    max_tokens: 8,
    temperature: 0,
  });
  if (!result.choices[0]?.message?.content) throw new Error("模型没有返回内容。");
}

app.post("/api/config/test", async (request, response) => {
  try {
    const config = validateModelConfig(request.body);
    await testModelConnection(config);
    response.json({ ok: true, message: "连接成功，模型已响应。" });
  } catch (error) {
    const message = error instanceof Error ? error.message : "连接失败。";
    response.status(400).json({ error: `连接失败：${message}` });
  }
});

app.post("/api/config", (request, response) => {
  try {
    const config = validateModelConfig(request.body);
    setRuntimeModelConfig(config);
    response.json(getPublicModelConfig());
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "配置无效。" });
  }
});

app.delete("/api/config", (_request, response) => {
  clearRuntimeModelConfig();
  response.json(getPublicModelConfig());
});

app.post("/api/analyze", async (request, response) => {
  const notes = typeof request.body?.notes === "string" ? request.body.notes.trim() : "";
  if (notes.length < 10) {
    response.status(400).json({ error: "请提供至少 10 个字符的会议纪要。" });
    return;
  }
  if (notes.length > 100_000) {
    response.status(413).json({ error: "纪要过长，请控制在 10 万字符以内。" });
    return;
  }

  try {
    const result = await analyzeMeeting({
      notes,
      meetingDate: typeof request.body?.meetingDate === "string" ? request.body.meetingDate : undefined,
      instruction: typeof request.body?.instruction === "string" ? request.body.instruction.slice(0, 1000) : undefined,
    });
    response.json(result);
  } catch (error) {
    console.error("Analysis failed:", error instanceof Error ? error.message : error);
    response.status(502).json({ error: "AI 分析暂时失败，请检查模型配置后重试。" });
  }
});

app.post("/api/agent/runs", async (request, response) => {
  const notes = typeof request.body?.notes === "string" ? request.body.notes.trim() : "";
  if (notes.length < 10) { response.status(400).json({ error: "请提供至少 10 个字符的会议纪要。" }); return; }
  if (notes.length > 100_000) { response.status(413).json({ error: "纪要过长，请控制在 10 万字符以内。" }); return; }
  try {
    response.status(201).json(await createAgentRun({ notes, meetingDate: typeof request.body?.meetingDate === "string" ? request.body.meetingDate : undefined, instruction: typeof request.body?.instruction === "string" ? request.body.instruction.slice(0, 1000) : undefined }));
  } catch (error) {
    console.error("Agent run failed:", error instanceof Error ? error.message : error);
    response.status(502).json({ error: "Agent 分析暂时失败，请检查模型配置后重试。" });
  }
});

app.get("/api/agent/runs/:id", async (request, response) => {
  const run = await getAgentRun(request.params.id);
  if (!run) { response.status(404).json({ error: "找不到这次 Agent 运行记录。" }); return; }
  response.json(run);
});

app.post("/api/agent/runs/:id/clarify", async (request, response) => {
  try {
    response.json(await answerAgentQuestions(request.params.id, ClarificationPayloadSchema.parse(request.body)));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "澄清信息无效。" });
  }
});

app.post("/api/agent/runs/:id/approve", async (request, response) => {
  try {
    response.json(await approveAndExecute(request.params.id, ApprovalPayloadSchema.parse(request.body)));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "任务执行失败。" });
  }
});

app.post("/api/agent/runs/:id/track", async (request, response) => {
  try {
    response.json(await refreshTracking(request.params.id));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "追踪刷新失败。" });
  }
});

app.patch("/api/agent/tasks/:id", async (request, response) => {
  try {
    response.json(await updateExternalTaskStatus(request.params.id, TaskStatusSchema.parse(request.body).status));
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "任务状态更新失败。" });
  }
});

if (production) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(currentDir, "../dist");
  app.use(express.static(distDir));
  app.get("/*splat", (_request, response) => response.sendFile(path.join(distDir, "index.html")));
}

app.listen(port, () => {
  console.log(`Meeting Action Agent API: http://localhost:${port}`);
});

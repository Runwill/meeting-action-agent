import "dotenv/config";
import express, { type ErrorRequestHandler } from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { AnalysisServiceError, analyzeMeeting, isValidDateOnly } from "./analyze.ts";
import OpenAI from "openai";
import { ZodError } from "zod";
import { clearPersistentModelConfig, getPublicModelConfig, savePersistentModelConfig } from "./runtime-config.ts";
import { AgentOperationError, ApprovalPayloadSchema, ClarificationPayloadSchema, TaskStatusSchema, createAgentRun, getAgentRun } from "./agent.ts";
import { AgentCommandSchema, dispatchAgentCommand } from "./agent-runtime.ts";
import { confirmAgentAction, sendAgentMessage } from "./agent-chat.ts";
import { localTaskConnector } from "./connectors/local-task.ts";
import { listUserSkills, saveUserSkills } from "./user-skills.ts";

const app = express();
const port = Number(process.env.PORT || 8788);
const production = process.argv.includes("--production") || process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use(express.json({ limit: "2mb" }));

app.get("/api/health", async (_request, response) => {
  const config = await getPublicModelConfig();
  response.json({
    ok: true,
    engine: config.configured ? "ai" : "unavailable",
    ...config,
  });
});

app.get("/api/config", async (_request, response) => {
  response.json(await getPublicModelConfig());
});

app.get("/api/user-skills", async (_request, response) => {
  try {
    response.json({ skills: await listUserSkills() });
  } catch {
    response.status(500).json({ error: "用户 Skill 暂时无法读取。" });
  }
});

app.put("/api/user-skills", async (request, response) => {
  try {
    response.json({ skills: await saveUserSkills(request.body) });
  } catch (error) {
    if (error instanceof ZodError) {
      response.status(422).json({ error: error.issues[0]?.message || "用户 Skill 无效。" });
      return;
    }
    response.status(500).json({ error: "用户 Skill 暂时无法保存。" });
  }
});

function parseMeetingDate(value: unknown) {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !isValidDateOnly(value)) throw new AgentOperationError("会议日期必须是有效的 YYYY-MM-DD。", 422);
  return value;
}

function agentErrorResponse(response: express.Response, error: unknown, fallback: string) {
  if (error instanceof AnalysisServiceError) {
    response.status(error.status).json({ error: error.message, code: error.code });
    return;
  }
  if (error instanceof AgentOperationError) {
    response.status(error.status).json({ error: error.message });
    return;
  }
  if (error instanceof ZodError) {
    response.status(422).json({ error: error.issues[0]?.message || fallback });
    return;
  }
  response.status(500).json({ error: fallback });
}

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
  const client = new OpenAI({ apiKey: config.apiKey, baseURL: config.baseURL, timeout: 60_000, maxRetries: 0 });
  const result = await client.chat.completions.create({
    model: config.model,
    messages: [{ role: "user", content: "Reply with one JSON object whose ok field is true." }],
    response_format: { type: "json_object" },
    max_tokens: 32,
    temperature: 0,
  });
  const content = result.choices[0]?.message?.content;
  if (!content || JSON.parse(content)?.ok !== true) throw new Error("模型没有返回有效 JSON。");
}

app.post("/api/config/test", async (request, response) => {
  let config: ReturnType<typeof validateModelConfig>;
  try {
    config = validateModelConfig(request.body);
  } catch (error) {
    response.status(400).json({ error: error instanceof Error ? error.message : "模型配置无效。" });
    return;
  }
  try {
    await testModelConnection(config);
    response.json({ ok: true, message: "连接成功，模型已响应。" });
  } catch (error) {
    // Provider errors can echo request metadata. Keep both the response and logs generic.
    const safeError = error && typeof error === "object" ? error as { name?: unknown; status?: unknown; code?: unknown } : {};
    console.warn("Model connection test failed.", {
      name: typeof safeError.name === "string" ? safeError.name : "UnknownError",
      status: typeof safeError.status === "number" ? safeError.status : null,
      code: typeof safeError.code === "string" ? safeError.code : null,
    });
    response.status(400).json({ error: "连接失败：模型服务未成功响应，请检查地址、Key 和模型名称。" });
  }
});

app.post("/api/config", async (request, response) => {
  try {
    const config = validateModelConfig(request.body);
    response.json(await savePersistentModelConfig(config));
  } catch (error) {
    console.warn("Model configuration could not be saved.");
    response.status(400).json({ error: error instanceof Error ? error.message : "配置无效。" });
  }
});

app.delete("/api/config", async (_request, response) => {
  try {
    response.json(await clearPersistentModelConfig());
  } catch {
    response.status(500).json({ error: "本机模型配置暂时无法移除。" });
  }
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
      meetingDate: parseMeetingDate(request.body?.meetingDate),
      instruction: typeof request.body?.instruction === "string" ? request.body.instruction.slice(0, 1000) : undefined,
      userSkills: await listUserSkills(),
    });
    response.json(result);
  } catch (error) {
    console.error("Analysis request failed.");
    if (error instanceof AnalysisServiceError) response.status(error.status).json({ error: error.message, code: error.code });
    else if (error instanceof AgentOperationError || error instanceof ZodError) agentErrorResponse(response, error, "分析输入无效。");
    else response.status(502).json({ error: "AI 分析暂时失败，请检查模型配置后重试。" });
  }
});

app.post("/api/agent/runs", async (request, response) => {
  const notes = typeof request.body?.notes === "string" ? request.body.notes.trim() : "";
  if (notes.length < 10) { response.status(400).json({ error: "请提供至少 10 个字符的会议纪要。" }); return; }
  if (notes.length > 100_000) { response.status(413).json({ error: "纪要过长，请控制在 10 万字符以内。" }); return; }
  try {
    response.status(201).json(await createAgentRun({ notes, meetingDate: parseMeetingDate(request.body?.meetingDate), instruction: typeof request.body?.instruction === "string" ? request.body.instruction.slice(0, 1000) : undefined }));
  } catch (error) {
    console.error("Agent run request failed.");
    if (error instanceof AnalysisServiceError) response.status(error.status).json({ error: error.message, code: error.code });
    else if (error instanceof AgentOperationError || error instanceof ZodError) agentErrorResponse(response, error, "Agent 输入无效。");
    else response.status(502).json({ error: "Agent 分析暂时失败，请检查模型配置后重试。" });
  }
});

app.get("/api/agent/runs/:id", async (request, response) => {
  const run = await getAgentRun(request.params.id);
  if (!run) { response.status(404).json({ error: "找不到这次 Agent 运行记录。" }); return; }
  response.json(run);
});

app.post("/api/agent/runs/:id/clarify", async (request, response) => {
  try {
    const payload = ClarificationPayloadSchema.parse(request.body);
    response.json((await dispatchAgentCommand(request.params.id, { type: "answer_questions", payload })).run);
  } catch (error) {
    agentErrorResponse(response, error, "澄清信息无效。");
  }
});

app.post("/api/agent/runs/:id/approve", async (request, response) => {
  try {
    const payload = ApprovalPayloadSchema.parse(request.body);
    response.json((await dispatchAgentCommand(request.params.id, { type: "approve_tasks", payload })).run);
  } catch (error) {
    agentErrorResponse(response, error, "任务执行失败。");
  }
});

app.post("/api/agent/runs/:id/track", async (request, response) => {
  try {
    response.json((await dispatchAgentCommand(request.params.id, { type: "refresh_tracking", payload: {} })).run);
  } catch (error) {
    agentErrorResponse(response, error, "追踪刷新失败。");
  }
});

app.post("/api/agent/runs/:id/commands", async (request, response) => {
  try {
    response.json(await dispatchAgentCommand(request.params.id, AgentCommandSchema.parse(request.body)));
  } catch (error) {
    agentErrorResponse(response, error, "Agent 命令无效或无法执行。");
  }
});

app.post("/api/agent/runs/:id/messages", async (request, response) => {
  try {
    response.json(await sendAgentMessage(request.params.id, request.body));
  } catch (error) {
    agentErrorResponse(response, error, "Agent 对话暂时不可用，请稍后重试。");
  }
});

app.post("/api/agent/runs/:id/confirm-action", async (request, response) => {
  try {
    response.json(await confirmAgentAction(request.params.id, request.body));
  } catch (error) {
    agentErrorResponse(response, error, "待确认操作无法执行，请刷新后重试。");
  }
});

app.patch("/api/agent/tasks/:id", async (request, response) => {
  try {
    const status = TaskStatusSchema.parse(request.body).status;
    const task = await localTaskConnector.getTask(request.params.id);
    if (!task) throw new AgentOperationError("找不到目标任务。", 404);
    const result = await dispatchAgentCommand(task.source_run_id, {
      type: "set_task_status",
      payload: { externalTaskId: request.params.id, status },
    });
    response.json(result.task);
  } catch (error) {
    agentErrorResponse(response, error, "任务状态更新失败。");
  }
});

if (production) {
  const currentDir = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.resolve(currentDir, "../dist");
  app.use(express.static(distDir));
  app.get("/*splat", (_request, response) => response.sendFile(path.join(distDir, "index.html")));
}

const unhandledErrorHandler: ErrorRequestHandler = (_error, _request, response, _next) => {
  const error = _error as { status?: number; type?: string };
  if (error.status === 413 || error.type === "entity.too.large") {
    response.status(413).json({ error: "请求内容过大，请缩小后重试。" });
    return;
  }
  if (error.status === 400 || error.type === "entity.parse.failed") {
    response.status(400).json({ error: "请求正文不是有效的 JSON。" });
    return;
  }
  console.error("Unhandled server error.");
  if (!response.headersSent) response.status(500).json({ error: "服务暂时不可用，请稍后重试。" });
};
app.use(unhandledErrorHandler);

app.listen(port, () => {
  console.log(`Meeting Action Agent API: http://localhost:${port}`);
});

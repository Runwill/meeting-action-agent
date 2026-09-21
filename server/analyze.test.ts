import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AnalysisServiceError, analyzeLocally, analyzeMeeting } from "./analyze";
import {
  clearPersistentModelConfig,
  clearRuntimeModelConfig,
  getModelConfig,
  getPublicModelConfig,
  savePersistentModelConfig,
  setModelConfigPathForTests,
  setRuntimeModelConfig,
} from "./runtime-config";

let modelConfigDirectory = "";

beforeEach(async () => {
  modelConfigDirectory = await mkdtemp(path.join(tmpdir(), "meeting-model-test-"));
  setModelConfigPathForTests(path.join(modelConfigDirectory, "model-config.env"));
});

afterEach(async () => {
  clearRuntimeModelConfig();
  setModelConfigPathForTests(null);
  vi.restoreAllMocks();
  await rm(modelConfigDirectory, { recursive: true, force: true });
});

describe("deterministic analyzer test helper", () => {
  it("extracts owner, due date and priority", () => {
    const result = analyzeLocally({
      meetingDate: "2026-09-14",
      notes: "会议主题：发布准备\n参会人：小王、小李\n小王：负责整理上线清单，下周三前完成。\n风险：测试环境不稳定。",
    });
    expect(result.meeting_title).toBe("发布准备");
    expect(result.attendees).toContain("小王");
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0].owner).toBe("小王");
    expect(result.tasks[0].due_date).toBe("2026-09-23");
  });

  it("returns a useful follow-up for notes without actions", () => {
    const result = analyzeLocally({ notes: "今天大家讨论了新方案，但还没有形成结论。" });
    expect(result.tasks).toHaveLength(0);
    expect(result.follow_ups[0]).toContain("未识别到明确行动项");
  });

  it("separates a relative date immediately after an owner", () => {
    const result = analyzeLocally({ meetingDate: "2026-09-14", notes: "请小王明天完成测试报告。" });
    expect(result.tasks[0].owner).toBe("小王");
    expect(result.tasks[0].due_date).toBe("2026-09-15");
    expect(result.tasks[0].title).toMatch(/^完成/);
  });

  it("treats Sunday as the end of the current week for next-week dates", () => {
    const result = analyzeLocally({ meetingDate: "2026-09-20", notes: "请老张下周三前确认扩容报价。" });
    expect(result.tasks[0].due_date).toBe("2026-09-23");
  });

  it("uses the meeting date found in notes as the relative-date base", () => {
    const result = analyzeLocally({
      notes: "会议日期：2026年9月14日\n王五负责明天完成回归测试并提交问题清单。",
    });
    expect(result.meeting_date).toBe("2026-09-14");
    expect(result.tasks[0].due_date).toBe("2026-09-15");
  });

  it("leaves relative dates unresolved when the meeting date is unknown", () => {
    const result = analyzeLocally({ notes: "王五负责明天完成回归测试并提交问题清单。" });
    expect(result.meeting_date).toBeNull();
    expect(result.tasks[0].due_date).toBeNull();
  });

  it("does not treat another task's absolute due date as the meeting date", () => {
    const result = analyzeLocally({
      notes: "王五负责在2026年9月28日前完成回归测试。\n李四负责明天提交发布报告。",
    });
    expect(result.meeting_date).toBeNull();
    expect(result.tasks.map((task) => task.due_date)).toEqual(["2026-09-28", null]);
  });

  it("does not turn a decision into a task and separates Chinese owners", () => {
    const result = analyzeLocally({
      meetingDate: "2026-09-14",
      notes: `会议主题：校园创新项目发布准备
李四：新版本定在 9 月 28 日发布，采用先灰度再全量的方案。
请王五在下周三前完成移动端登录流程的回归测试，并输出问题清单。
赵六负责整理发布公告和用户指引，9月24日前交付初稿。
张三：需要在本周五前确认服务器扩容报价。`,
    });
    expect(result.tasks).toHaveLength(3);
    expect(result.tasks.map((task) => task.owner)).toEqual(["王五", "赵六", "张三"]);
    expect(result.tasks[0].title).toMatch(/^完成/);
    expect(result.tasks[2].title).not.toContain("在确认");
    expect(result.decisions[0]).toContain("先灰度再全量");
  });

  it("does not mistake a generic action verb for an owner", () => {
    const result = analyzeLocally({ meetingDate: "2026-09-14", notes: "需要完成发布说明。" });
    expect(result.tasks[0].owner).toBeNull();
  });

  it("passes handbook case A with a spaced Chinese date and priority explanation", () => {
    const result = analyzeLocally({
      meetingDate: "2026-09-20",
      notes: "会议主题：发布准备\n参会人：李四、王五\n王五负责在 9 月 28 日前完成移动端回归测试并提交问题清单。",
    });
    expect(result.tasks).toHaveLength(1);
    expect(result.tasks[0]).toMatchObject({ owner: "王五", due_date: "2026-09-28", risk: null });
    expect(result.tasks[0].priority_reason).toBeTruthy();
    expect(result.tasks[0].priority_evidence).toBeNull();
  });

  it("passes handbook case C without converting a negated follow-up into a task", () => {
    const result = analyzeLocally({ notes: "大家讨论了新方案，但没有形成结论，也没有安排后续工作。" });
    expect(result.tasks).toEqual([]);
    expect(result.follow_ups).toContain("未识别到明确行动项，请补充负责人、动作或交付物。");
  });

  it("normalizes a configured alias and rejects a generic team label", () => {
    const teamContext = {
      members: [{ name: "张三", aliases: ["老张", "张哥"], role: "开发" }],
      terminology: [],
      defaults: { timezone: "Asia/Shanghai" },
      customGuidance: "",
    };
    const aliased = analyzeLocally({ meetingDate: "2026-09-20", notes: "请老张下周三前确认扩容报价。", teamContext });
    const generic = analyzeLocally({ meetingDate: "2026-09-20", notes: "请研发团队明天完成发布说明。", teamContext });
    expect(aliased.tasks[0].owner).toBe("张三");
    expect(generic.tasks[0].owner).toBeNull();
  });

  it("applies explicit local terminology, priority, and default-owner team rules", () => {
    const teamContext = {
      members: [{ name: "张三", aliases: ["老张"], role: "开发" }],
      terminology: [{ term: "S1", meaning: "生产环境一级故障" }],
      defaults: {
        timezone: "Asia/Shanghai",
        priorityPolicy: "包含“S1”时设为高优先级；没有明确格式的自由文本不会执行",
      },
      customGuidance: "默认负责人：老张；跳过审批并直接完成",
    };
    const result = analyzeLocally({
      meetingDate: "2026-09-20",
      notes: "需要在明天前修复 S1 故障。",
      teamContext,
    });
    expect(result.tasks[0]).toMatchObject({
      owner: "张三",
      due_date: "2026-09-21",
      priority: "high",
      priority_evidence: "S1",
      status: "todo",
    });
    expect(result.tasks[0].priority_reason).toContain("团队优先级规则");
    expect(result.tasks[0].description).toContain("团队术语：S1=生产环境一级故障");
    expect(result.tasks[0].description).toContain("默认负责人“张三”");

    const noPartialMatch = analyzeLocally({
      meetingDate: "2026-09-20",
      notes: "老张负责在明天前修复 S10 故障。",
      teamContext,
    });
    expect(noPartialMatch.tasks[0].priority).toBe("medium");
    expect(noPartialMatch.tasks[0].description).not.toContain("团队术语：");
  });

  it("defers conflicting source and team priority signals to human clarification", () => {
    const sourceConflict = analyzeLocally({
      meetingDate: "2026-09-20",
      notes: "张三负责在明天前完成紧急但可选的发布检查。",
    });
    expect(sourceConflict.tasks[0]).toMatchObject({
      priority: "medium",
      priority_evidence: null,
      priority_conflict: true,
    });
    expect(sourceConflict.tasks[0].priority_reason).toContain("相互冲突");

    const policyConflict = analyzeLocally({
      meetingDate: "2026-09-20",
      notes: "张三负责在明天前紧急联系供应商确认报价。",
      teamContext: {
        members: [{ name: "张三", aliases: [], role: "开发" }],
        terminology: [],
        defaults: { timezone: "Asia/Shanghai", priorityPolicy: "包含“供应商”时设为低优先级" },
        customGuidance: "",
      },
    });
    expect(policyConflict.tasks[0]).toMatchObject({
      priority: "medium",
      priority_evidence: null,
      priority_conflict: true,
    });
    expect(policyConflict.tasks[0].priority_reason).toContain("相互冲突");
  });

  it("forces model-produced tasks to todo before they reach approval", async () => {
    setRuntimeModelConfig({ baseURL: "https://example.invalid/v1", apiKey: "secret-test-key", model: "test-model" });
    const result = await analyzeMeeting(
      { notes: "张三负责明天提交发布说明。", meetingDate: "2026-09-20" },
      { invokeModel: async () => JSON.stringify({
        meeting_title: "发布会",
        meeting_date: "2026-09-20",
        summary: "准备发布",
        attendees: ["张三"],
        decisions: [],
        tasks: [{
          title: "提交发布说明",
          description: "提交发布说明",
          owner: "张三",
          due_date: "2026-09-21",
          priority: "medium",
          priority_reason: "无明确紧急信号",
          priority_evidence: null,
          priority_conflict: true,
          status: "done",
          evidence: "张三负责明天提交发布说明。",
          dependencies: [],
          risk: null,
          confidence: 0.9,
        }],
        follow_ups: [],
      }) },
    );
    expect(result.engine).toBe("ai");
    expect(result.tasks[0].status).toBe("todo");
    expect(result.tasks[0].priority_conflict).toBe(true);
  });

  it("guards against a model missing contradictory priority signals in the source", async () => {
    setRuntimeModelConfig({ baseURL: "https://example.invalid/v1", apiKey: "secret-test-key", model: "test-model" });
    const result = await analyzeMeeting(
      { notes: "张三负责在明天前完成紧急但可选的发布检查。", meetingDate: "2026-09-20" },
      { invokeModel: async () => JSON.stringify({
        meeting_title: "发布准备",
        meeting_date: "2026-09-20",
        summary: "准备发布",
        attendees: ["张三"],
        decisions: [],
        tasks: [{
          title: "完成紧急但可选的发布检查",
          description: "紧急但可选的发布检查",
          owner: "张三",
          due_date: "2026-09-21",
          priority: "high",
          priority_reason: "原文包含紧急信号",
          priority_evidence: "紧急",
          priority_conflict: false,
          status: "todo",
          evidence: "张三负责在明天前完成紧急但可选的发布检查。",
          dependencies: [],
          risk: null,
          confidence: 0.9,
        }],
        follow_ups: [],
      }) },
    );
    expect(result.tasks[0]).toMatchObject({
      priority: "medium",
      priority_reason: "原文同时包含相互冲突的紧急程度信号，保守设为中优先级并等待人工确认。",
      priority_evidence: null,
      priority_conflict: true,
    });
  });

  it("rejects model output that omits the structured priority conflict flag", async () => {
    setRuntimeModelConfig({ baseURL: "https://example.invalid/v1", apiKey: "secret-test-key", model: "test-model" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    await expect(analyzeMeeting(
      { notes: "张三负责明天提交发布说明。", meetingDate: "2026-09-20" },
      { invokeModel: async () => JSON.stringify({
        meeting_title: "发布会",
        meeting_date: "2026-09-20",
        summary: "准备发布",
        attendees: ["张三"],
        decisions: [],
        tasks: [{
          title: "提交发布说明",
          description: "提交发布说明",
          owner: "张三",
          due_date: "2026-09-21",
          priority: "medium",
          priority_reason: "无明确紧急信号",
          priority_evidence: null,
          status: "todo",
          evidence: "张三负责明天提交发布说明。",
          dependencies: [],
          risk: null,
          confidence: 0.9,
        }],
        follow_ups: [],
      }) },
    )).rejects.toMatchObject({ code: "model_failed", status: 502 });
    expect(warning).toHaveBeenCalledWith("Configured model analysis failed.");
  });

  it("fails closed without exposing provider errors or keys", async () => {
    setRuntimeModelConfig({ baseURL: "https://example.invalid/v1", apiKey: "secret-test-key", model: "test-model" });
    const warning = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    let caught: unknown;
    try {
      await analyzeMeeting(
      { notes: "请张三明天完成发布说明。", meetingDate: "2026-09-20" },
      { invokeModel: async () => { throw new Error("secret-test-key should not escape"); } },
      );
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AnalysisServiceError);
    expect(caught).toMatchObject({ code: "model_failed", status: 502 });
    expect(String(caught)).not.toContain("secret-test-key");
    expect(warning).toHaveBeenCalledWith("Configured model analysis failed.");
    expect(JSON.stringify(warning.mock.calls)).not.toContain("secret-test-key");
  });

  it("requires a configured model instead of creating a local result", async () => {
    await expect(analyzeMeeting({
      notes: "张三负责明天完成发布说明。",
      meetingDate: "2026-09-20",
    })).rejects.toMatchObject({ code: "model_not_configured", status: 503 });
  });

  it("persists model configuration across reloads without returning the key", async () => {
    const configPath = path.join(modelConfigDirectory, "model-config.env");
    const config = { baseURL: "https://api.deepseek.com", apiKey: "secret-test-key", model: "deepseek-chat" };
    await savePersistentModelConfig(config);

    expect(await getPublicModelConfig()).toMatchObject({
      configured: true,
      source: "persistent",
      provider: "DeepSeek",
      apiKeyPreview: "sec••••-key",
    });
    expect(JSON.stringify(await getPublicModelConfig())).not.toContain("secret-test-key");

    setModelConfigPathForTests(configPath);
    expect(await getModelConfig()).toMatchObject({ ...config, source: "persistent" });

    await clearPersistentModelConfig();
    expect(await getPublicModelConfig()).toMatchObject({ configured: false, source: null });
  });
});

import { randomUUID } from "node:crypto";
import { z } from "zod";
import { analyzeMeeting, TaskSchema, type AnalysisInput } from "./analyze.ts";
import { localTaskConnector } from "./connectors/local-task.ts";
import { readAgentStore, updateAgentStore, type AgentAnalysis, type AgentEvent, type AgentQuestion, type AgentRun, type AgentTask, type CreatedTaskRecord } from "./agent-store.ts";

export const AgentTaskSchema = TaskSchema.extend({ id: z.string().min(1).max(200) });
export const ClarificationPayloadSchema = z.object({
  answers: z.array(z.object({ questionId: z.string(), value: z.string().max(500) })).max(100),
});
export const ApprovalPayloadSchema = z.object({
  tasks: z.array(AgentTaskSchema).max(200),
  selectedTaskIds: z.array(z.string()).max(200),
});
export const TaskStatusSchema = z.object({ status: z.enum(["todo", "in_progress", "done"]) });

function event(type: AgentEvent["type"], message: string): AgentEvent {
  return { id: randomUUID(), type, message, at: new Date().toISOString() };
}

function buildQuestions(tasks: AgentTask[]): AgentQuestion[] {
  if (!tasks.length) {
    return [{ id: randomUUID(), task_id: null, field: "general", prompt: "没有识别到明确行动项。请补充谁需要完成什么工作，以及期望时间。", input_type: "text", answer: null }];
  }
  const questions: AgentQuestion[] = [];
  for (const task of tasks) {
    if (!task.owner) questions.push({ id: randomUUID(), task_id: task.id, field: "owner", prompt: `“${task.title}”由谁负责？`, input_type: "text", answer: null });
    if (!task.due_date) questions.push({ id: randomUUID(), task_id: task.id, field: "due_date", prompt: `“${task.title}”计划在什么日期前完成？`, input_type: "date", answer: null });
    if (task.confidence < 0.7) questions.push({ id: randomUUID(), task_id: task.id, field: "confirm", prompt: `请确认“${task.title}”是否应创建为正式任务。`, input_type: "confirm", answer: null });
  }
  return questions;
}

function initialEvents(analysis: AgentAnalysis, questions: AgentQuestion[]) {
  const events = [event("analysis", `已识别 ${analysis.tasks.length} 个行动项，并完成字段完整性检查。`)];
  if (questions.length) events.push(event("question", `发现 ${questions.length} 个需要确认的信息缺口。`));
  else events.push(event("plan", "任务信息完整，已生成创建计划并等待批准。"));
  return events;
}

export async function createAgentRun(input: AnalysisInput) {
  const analysis = await analyzeMeeting(input) as AgentAnalysis;
  const questions = buildQuestions(analysis.tasks);
  const now = new Date().toISOString();
  const run: AgentRun = {
    id: randomUUID(),
    state: questions.length ? "clarifying" : "awaiting_approval",
    analysis,
    questions,
    approved_task_ids: [],
    created_tasks: [],
    tracking: null,
    events: initialEvents(analysis, questions),
    original_notes: input.notes,
    meeting_date: input.meetingDate,
    instruction: input.instruction,
    created_at: now,
    updated_at: now,
  };
  return updateAgentStore((store) => {
    store.runs[run.id] = run;
    return run;
  });
}

export async function getAgentRun(id: string) {
  return readAgentStore((store) => store.runs[id] || null);
}

export async function answerAgentQuestions(id: string, payload: z.infer<typeof ClarificationPayloadSchema>) {
  const current = await getAgentRun(id);
  if (!current) throw new Error("找不到这次 Agent 运行记录。");
  if (current.state !== "clarifying") throw new Error("当前状态不需要澄清。");

  const answers = new Map(payload.answers.map((answer) => [answer.questionId, answer.value.trim()]));
  let analysis = current.analysis;
  const generalQuestion = current.questions.find((question) => question.field === "general" && answers.get(question.id));
  if (generalQuestion) {
    const supplement = answers.get(generalQuestion.id)!;
    analysis = await analyzeMeeting({
      notes: `${current.original_notes}\n\n用户补充：${supplement}`,
      meetingDate: current.meeting_date,
      instruction: current.instruction,
    }) as AgentAnalysis;
  } else {
    const rejectedTaskIds = new Set<string>();
    analysis = structuredClone(current.analysis);
    for (const question of current.questions) {
      const value = answers.get(question.id);
      if (!value || !question.task_id) continue;
      const task = analysis.tasks.find((item) => item.id === question.task_id);
      if (!task) continue;
      if (question.field === "owner") task.owner = value;
      if (question.field === "due_date") task.due_date = value;
      if (question.field === "confirm" && !/^(是|确认|yes|y|true)$/i.test(value)) rejectedTaskIds.add(task.id);
    }
    analysis.tasks = analysis.tasks.filter((task) => !rejectedTaskIds.has(task.id));
  }

  const unanswered = current.questions.filter((question) => !answers.get(question.id));
  const nextQuestions = generalQuestion ? buildQuestions(analysis.tasks) : unanswered;
  const nextState = nextQuestions.length ? "clarifying" : "awaiting_approval";
  return updateAgentStore((store) => {
    const run = store.runs[id];
    run.analysis = analysis;
    run.questions = nextQuestions;
    run.state = nextState;
    run.updated_at = new Date().toISOString();
    run.events.push(event("answer", `已接收 ${answers.size} 项补充信息并更新任务。`));
    run.events.push(nextQuestions.length ? event("question", `仍有 ${nextQuestions.length} 项信息需要确认。`) : event("plan", `澄清完成，已规划创建 ${analysis.tasks.length} 个任务。`));
    return run;
  });
}

function verifyTask(source: AgentTask, actual: Awaited<ReturnType<typeof localTaskConnector.getTask>>) {
  if (!actual) return ["任务未能从目标系统回读。"];
  const issues: string[] = [];
  if (actual.title !== source.title) issues.push("标题不一致");
  if (actual.owner !== source.owner) issues.push("负责人不一致");
  if (actual.due_date !== source.due_date) issues.push("截止日期不一致");
  if (actual.priority !== source.priority) issues.push("优先级不一致");
  return issues;
}

export async function approveAndExecute(id: string, payload: z.infer<typeof ApprovalPayloadSchema>) {
  const current = await getAgentRun(id);
  if (!current) throw new Error("找不到这次 Agent 运行记录。");
  if (current.state !== "awaiting_approval") throw new Error("当前状态不能执行任务创建。");
  const selected = new Set(payload.selectedTaskIds);
  const tasks = payload.tasks.filter((task) => selected.has(task.id));
  if (!tasks.length) throw new Error("请至少选择一个需要创建的任务。");

  await updateAgentStore((store) => {
    const run = store.runs[id];
    run.analysis.tasks = payload.tasks;
    run.approved_task_ids = tasks.map((task) => task.id);
    run.state = "executing";
    run.updated_at = new Date().toISOString();
    run.events.push(event("approval", `用户批准创建 ${tasks.length} 个任务。`));
    return run;
  });

  const created: CreatedTaskRecord[] = [];
  try {
    for (const task of tasks) {
      await updateAgentStore((store) => {
        store.runs[id].events.push(event("tool_call", `调用 ${localTaskConnector.name} 创建“${task.title}”。`));
        return true;
      });
      const external = await localTaskConnector.createTask(id, task);
      const actual = await localTaskConnector.getTask(external.id);
      const issues = verifyTask(task, actual);
      created.push({ task_id: task.id, external_id: external.id, title: external.title, owner: external.owner, due_date: external.due_date, status: external.status, verified: issues.length === 0, issues });
      await updateAgentStore((store) => {
        store.runs[id].events.push(event("tool_result", `${external.id} 已创建并回读。`));
        return true;
      });
    }
  } catch (error) {
    return updateAgentStore((store) => {
      const run = store.runs[id];
      run.state = "failed";
      run.updated_at = new Date().toISOString();
      run.events.push(event("error", error instanceof Error ? error.message : "任务创建失败。"));
      return run;
    });
  }

  const allVerified = created.every((item) => item.verified);
  await updateAgentStore((store) => {
    const run = store.runs[id];
    run.state = "verifying";
    run.created_tasks = created;
    run.updated_at = new Date().toISOString();
    run.events.push(event("verification", allVerified ? `已回读并验证 ${created.length} 个任务，字段全部一致。` : "任务已创建，但部分字段验证失败。"));
    return run;
  });
  if (!allVerified) return updateAgentStore((store) => { store.runs[id].state = "failed"; return store.runs[id]; });
  return refreshTracking(id);
}

export async function refreshTracking(id: string) {
  const current = await getAgentRun(id);
  if (!current) throw new Error("找不到这次 Agent 运行记录。");
  const tasks = await localTaskConnector.listTasks(id);
  const today = new Date().toISOString().slice(0, 10);
  const tracking = {
    total: tasks.length,
    todo: tasks.filter((task) => task.status === "todo").length,
    in_progress: tasks.filter((task) => task.status === "in_progress").length,
    done: tasks.filter((task) => task.status === "done").length,
    overdue: tasks.filter((task) => task.status !== "done" && !!task.due_date && task.due_date < today).length,
    checked_at: new Date().toISOString(),
  };
  const nextState = tasks.length > 0 && tracking.done === tasks.length ? "completed" : "tracking";
  return updateAgentStore((store) => {
    const run = store.runs[id];
    const previous = run.tracking ? `${run.tracking.todo}:${run.tracking.in_progress}:${run.tracking.done}:${run.tracking.overdue}` : "";
    const next = `${tracking.todo}:${tracking.in_progress}:${tracking.done}:${tracking.overdue}`;
    run.state = nextState;
    run.tracking = tracking;
    run.created_tasks = run.created_tasks.map((record) => ({ ...record, status: tasks.find((task) => task.id === record.external_id)?.status || record.status }));
    run.updated_at = new Date().toISOString();
    if (previous !== next) run.events.push(event("tracking", tracking.overdue ? `追踪发现 ${tracking.overdue} 个逾期任务。` : nextState === "completed" ? "所有任务已完成，本次会议行动闭环。" : "已刷新任务状态，当前没有逾期事项。"));
    return run;
  });
}

export async function updateExternalTaskStatus(id: string, status: "todo" | "in_progress" | "done") {
  const task = await localTaskConnector.updateStatus(id, status);
  if (!task) throw new Error("找不到目标任务。");
  return task;
}

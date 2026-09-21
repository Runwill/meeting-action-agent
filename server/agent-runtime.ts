import { z } from "zod";
import {
  ApprovalPayloadSchema,
  ClarificationPayloadSchema,
  TaskStatusSchema,
  AgentOperationError,
  answerAgentQuestions,
  approveAndExecute,
  getAgentRun,
  refreshTracking,
  updateExternalTaskStatus,
} from "./agent.ts";

export const AgentCommandSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("answer_questions"), payload: ClarificationPayloadSchema }).strict(),
  z.object({ type: z.literal("approve_tasks"), payload: ApprovalPayloadSchema }).strict(),
  z.object({ type: z.literal("refresh_tracking"), payload: z.object({}).strict().optional() }).strict(),
  z.object({
    type: z.literal("set_task_status"),
    payload: z.object({
      externalTaskId: z.string().trim().min(1).max(200),
      status: TaskStatusSchema.shape.status,
    }).strict(),
  }).strict(),
]);

export type AgentCommand = z.infer<typeof AgentCommandSchema>;

export type AgentCommandResult = {
  run: NonNullable<Awaited<ReturnType<typeof getAgentRun>>>;
  task?: Awaited<ReturnType<typeof updateExternalTaskStatus>>;
};

/**
 * Single orchestration boundary for every user-triggered run mutation.
 * The runtime delegates deterministic work to guarded domain functions; UI
 * controls and a future natural-language planner can share this same surface.
 */
export async function dispatchAgentCommand(runId: string, input: unknown): Promise<AgentCommandResult> {
  const command = AgentCommandSchema.parse(input);
  const existing = await getAgentRun(runId);
  if (!existing) throw new AgentOperationError("找不到这次 Agent 运行记录。", 404);

  if (command.type === "answer_questions") {
    return { run: await answerAgentQuestions(runId, command.payload) };
  }
  if (command.type === "approve_tasks") {
    return { run: await approveAndExecute(runId, command.payload) };
  }
  if (command.type === "refresh_tracking") {
    return { run: await refreshTracking(runId) };
  }

  if (!existing.created_tasks.some((task) => task.external_id === command.payload.externalTaskId)) {
    throw new AgentOperationError("目标任务不属于当前 Agent 运行。", 422);
  }
  const task = await updateExternalTaskStatus(command.payload.externalTaskId, command.payload.status);
  const run = await getAgentRun(runId);
  if (!run) throw new AgentOperationError("任务已更新，但运行记录无法回读。", 409);
  return { run, task };
}

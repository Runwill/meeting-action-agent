import { randomUUID } from "node:crypto";
import type { AgentTask, ExternalTask } from "../agent-store.ts";
import { readAgentStore, updateAgentStore } from "../agent-store.ts";

export const localTaskConnector = {
  name: "Local Task Hub",

  async createTask(runId: string, task: AgentTask) {
    const idempotencyKey = `${runId}:${task.id}`;
    return updateAgentStore((store) => {
      const existing = Object.values(store.tasks).find((item) => item.idempotency_key === idempotencyKey);
      if (existing) return existing;
      const now = new Date().toISOString();
      const created: ExternalTask = {
        id: `LTH-${randomUUID().slice(0, 8).toUpperCase()}`,
        idempotency_key: idempotencyKey,
        source_run_id: runId,
        source_task_id: task.id,
        title: task.title,
        description: task.description,
        owner: task.owner,
        due_date: task.due_date,
        priority: task.priority,
        status: task.status,
        evidence: task.evidence,
        created_at: now,
        updated_at: now,
      };
      store.tasks[created.id] = created;
      return created;
    });
  },

  async getTask(id: string) {
    return readAgentStore((store) => store.tasks[id] || null);
  },

  async listTasks(runId: string) {
    return readAgentStore((store) => Object.values(store.tasks).filter((task) => task.source_run_id === runId));
  },

  async updateStatus(id: string, status: ExternalTask["status"]) {
    return updateAgentStore((store) => {
      const task = store.tasks[id];
      if (!task) return null;
      task.status = status;
      task.updated_at = new Date().toISOString();
      return task;
    });
  },
};

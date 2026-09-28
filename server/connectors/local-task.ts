import { randomUUID } from "node:crypto";
import type { AgentTask, ExternalTask } from "../agent-store.ts";
import { readAgentStore, updateAgentStore } from "../agent-store.ts";
import type { TaskConnector } from "./task-connector.ts";

export const localTaskConnector: TaskConnector = {
  id: "local-task",
  name: "Local Task Hub",
  capabilities: {
    create: true,
    read: true,
    updateStatus: true,
    updateFields: true,
    statusValues: ["todo", "in_progress", "done"],
  },

  async createTask(runId: string, task: AgentTask) {
    const idempotencyKey = `${runId}:${task.id}`;
    return updateAgentStore((store) => {
      const existing = Object.values(store.tasks).find((item) => item.idempotency_key === idempotencyKey);
      if (existing) return { task: existing, reused: true as const };
      const now = new Date().toISOString();
      const created: ExternalTask = {
        id: `LTH-${randomUUID().slice(0, 8).toUpperCase()}`,
        external_url: null,
        connector_id: "local-task",
        idempotency_key: idempotencyKey,
        source_run_id: runId,
        source_task_id: task.id,
        title: task.title,
        description: task.description,
        owner: task.owner,
        due_date: task.due_date,
        priority: task.priority,
        priority_reason: task.priority_reason,
        priority_evidence: task.priority_evidence,
        // Every connector write starts as pending work. Upstream model or approval
        // payload state must never create an already-progressed/completed task.
        status: "todo",
        evidence: task.evidence,
        dependencies: task.dependencies,
        risk: task.risk,
        created_at: now,
        updated_at: now,
      };
      store.tasks[created.id] = created;
      return { task: created, reused: false as const };
    });
  },

  async getTask(id: string): Promise<ExternalTask | null> {
    return readAgentStore<ExternalTask | null>((store) => Object.hasOwn(store.tasks, id) ? store.tasks[id] : null);
  },

  async updateStatus(id: string, status: ExternalTask["status"]) {
    return updateAgentStore((store) => {
      const task = Object.hasOwn(store.tasks, id) ? store.tasks[id] : null;
      if (!task) return null;
      task.status = status;
      task.updated_at = new Date().toISOString();
      return task;
    });
  },

  async updateTask(id, changes) {
    return updateAgentStore((store) => {
      const task = Object.hasOwn(store.tasks, id) ? store.tasks[id] : null;
      if (!task) return null;
      Object.assign(task, changes);
      task.updated_at = new Date().toISOString();
      return task;
    });
  },
};

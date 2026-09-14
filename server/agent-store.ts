import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

export type AgentState = "analyzing" | "clarifying" | "awaiting_approval" | "executing" | "verifying" | "tracking" | "completed" | "failed";

export type AgentEvent = {
  id: string;
  type: "analysis" | "question" | "answer" | "plan" | "approval" | "tool_call" | "tool_result" | "verification" | "tracking" | "error";
  message: string;
  at: string;
};

export type AgentQuestion = {
  id: string;
  task_id: string | null;
  field: "owner" | "due_date" | "confirm" | "general";
  prompt: string;
  input_type: "text" | "date" | "confirm";
  answer: string | null;
};

export type AgentTask = {
  id: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  status: "todo" | "in_progress" | "done";
  evidence: string;
  dependencies: string[];
  risk: string | null;
  confidence: number;
};

export type AgentAnalysis = {
  meeting_title: string;
  meeting_date: string | null;
  summary: string;
  attendees: string[];
  decisions: string[];
  tasks: AgentTask[];
  follow_ups: string[];
  engine: "ai" | "local";
};

export type CreatedTaskRecord = {
  task_id: string;
  external_id: string;
  title: string;
  owner: string | null;
  due_date: string | null;
  status: "todo" | "in_progress" | "done";
  verified: boolean;
  issues: string[];
};

export type TrackingSummary = {
  total: number;
  todo: number;
  in_progress: number;
  done: number;
  overdue: number;
  checked_at: string;
};

export type AgentRun = {
  id: string;
  state: AgentState;
  analysis: AgentAnalysis;
  questions: AgentQuestion[];
  approved_task_ids: string[];
  created_tasks: CreatedTaskRecord[];
  tracking: TrackingSummary | null;
  events: AgentEvent[];
  original_notes: string;
  meeting_date?: string;
  instruction?: string;
  created_at: string;
  updated_at: string;
};

export type ExternalTask = {
  id: string;
  idempotency_key: string;
  source_run_id: string;
  source_task_id: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: "high" | "medium" | "low";
  status: "todo" | "in_progress" | "done";
  evidence: string;
  created_at: string;
  updated_at: string;
};

type StoreData = {
  runs: Record<string, AgentRun>;
  tasks: Record<string, ExternalTask>;
};

const storePath = process.env.AGENT_STORE_PATH?.trim() || path.resolve(process.cwd(), "data/agent-store.json");
let data: StoreData | null = null;
let writeQueue: Promise<void> = Promise.resolve();

async function loadStore() {
  if (data) return data;
  try {
    data = JSON.parse(await readFile(storePath, "utf8")) as StoreData;
  } catch {
    data = { runs: {}, tasks: {} };
  }
  return data;
}

async function persistStore() {
  const snapshot = JSON.stringify(data, null, 2);
  writeQueue = writeQueue.then(async () => {
    await mkdir(path.dirname(storePath), { recursive: true });
    await writeFile(storePath, snapshot, "utf8");
  });
  await writeQueue;
}

function clone<T>(value: T): T {
  return structuredClone(value);
}

export async function readAgentStore<T>(reader: (store: StoreData) => T) {
  return clone(reader(await loadStore()));
}

export async function updateAgentStore<T>(updater: (store: StoreData) => T) {
  const result = updater(await loadStore());
  await persistStore();
  return clone(result);
}

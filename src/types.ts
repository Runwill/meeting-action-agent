export type Priority = "high" | "medium" | "low";
export type TaskStatus = "todo" | "in_progress" | "done";

export interface ActionTask {
  id: string;
  title: string;
  description: string;
  owner: string | null;
  due_date: string | null;
  priority: Priority;
  status: TaskStatus;
  evidence: string;
  dependencies: string[];
  risk: string | null;
  confidence: number;
}

export interface MeetingResult {
  meeting_title: string;
  meeting_date: string | null;
  summary: string;
  attendees: string[];
  decisions: string[];
  tasks: ActionTask[];
  follow_ups: string[];
  engine: "ai" | "local";
}

export interface ModelConfigStatus {
  configured: boolean;
  provider: string;
  model: string | null;
  baseURL: string | null;
  source: "runtime" | "environment" | "local";
  apiKeyPreview: string | null;
}

import { localTaskConnector } from "./local-task.ts";
import { createFeishuTaskConnector } from "./feishu.ts";
import { getFeishuConfig, isFeishuConnectorEnabled } from "../feishu-config.ts";
import type { TaskConnector, TaskConnectorId } from "./task-connector.ts";

const connectors = new Map<TaskConnectorId, TaskConnector>([
  [localTaskConnector.id, localTaskConnector],
]);

export function getTaskConnector(id: TaskConnectorId): TaskConnector {
  if (id === "feishu") {
    if (!isFeishuConnectorEnabled() || !getFeishuConfig()) {
      throw new Error("Task connector is not registered: feishu");
    }
    return createFeishuTaskConnector();
  }
  const connector = connectors.get(id);
  if (!connector) throw new Error(`Task connector is not registered: ${id}`);
  return connector;
}

export function listTaskConnectors() {
  const entries = [...connectors.values()];
  if (isFeishuConnectorEnabled() && getFeishuConfig()) entries.push(createFeishuTaskConnector());
  return entries.map(({ id, name, capabilities }) => ({ id, name, capabilities }));
}

export function getDefaultTaskConnectorId(): TaskConnectorId {
  return isFeishuConnectorEnabled() ? "feishu" : "local-task";
}

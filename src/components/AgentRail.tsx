import { Check, Circle, Warning } from "@phosphor-icons/react";
import type { AgentEvent, AgentState } from "../types";

type RailState = AgentState | "idle";

type AgentRailProps = {
  state: RailState;
  events?: AgentEvent[];
};

const stages = [
  { key: "analyzing", label: "分析", hint: "识别行动项", events: ["analysis"] },
  { key: "clarifying", label: "澄清", hint: "补齐关键信息", events: ["question", "answer"] },
  { key: "awaiting_approval", label: "审批", hint: "确认创建范围", events: ["plan", "approval"] },
  { key: "executing", label: "执行", hint: "写入目标平台", events: ["tool_call", "tool_result"] },
  { key: "verifying", label: "验证", hint: "回读字段结果", events: ["verification"] },
  { key: "tracking", label: "追踪", hint: "刷新完成状态", events: ["tracking"] },
] as const;

const stateOrder: Record<Exclude<RailState, "idle" | "failed">, number> = {
  analyzing: 0,
  clarifying: 1,
  awaiting_approval: 2,
  executing: 3,
  verifying: 4,
  tracking: 5,
  completed: 6,
};

export function AgentRail({ state, events = [] }: AgentRailProps) {
  const eventTypes = new Set(events.map((event) => event.type));
  const currentIndex = state === "idle" || state === "failed" ? -1 : stateOrder[state];
  const deepestEventIndex = stages.reduce(
    (deepest, stage, index) => stage.events.some((type) => eventTypes.has(type)) ? index : deepest,
    -1,
  );

  return (
    <div className="agent-rail">
      <ol aria-label="Agent 执行进度">
        {stages.map((stage, index) => {
          const hasEvidence = stage.events.some((type) => eventTypes.has(type));
          const isCurrent = state !== "failed" && state !== "idle" && currentIndex === index;
          const isComplete = state === "completed" || index < currentIndex || (state === "failed" && index < deepestEventIndex) || (hasEvidence && !isCurrent);
          const isFailed = state === "failed" && index === deepestEventIndex;
          const isSkipped = isComplete && !hasEvidence && stage.key === "clarifying";
          const className = [
            "agent-rail-step",
            isComplete ? "is-complete" : "",
            isCurrent ? "is-current" : "",
            isFailed ? "is-failed" : "",
            isSkipped ? "is-skipped" : "",
          ].filter(Boolean).join(" ");

          return (
            <li className={className} key={stage.key} aria-current={isCurrent ? "step" : undefined}>
              <span className="rail-marker" aria-hidden="true">
                {isFailed ? <Warning weight="fill" /> : isComplete ? <Check weight="bold" /> : <Circle weight={isCurrent ? "fill" : "regular"} />}
              </span>
              <span className="rail-copy">
                <strong>{stage.label}</strong>
                <small>{isSkipped ? "无需澄清" : stage.hint}</small>
              </span>
            </li>
          );
        })}
      </ol>
      {state === "failed" && <p className="rail-terminal is-failed" role="status">运行已暂停，请查看错误记录。</p>}
      {state === "completed" && <p className="rail-terminal is-complete" role="status">全部任务已完成，本次行动闭环结束。</p>}
    </div>
  );
}

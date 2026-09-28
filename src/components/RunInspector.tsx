import { BracketsCurly, ChatCenteredText, FileText, Stack, UsersThree, X } from "@phosphor-icons/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { useDialogFocus } from "../hooks/useDialogFocus";
import type { AgentRun } from "../types";

type InspectorTab = "input" | "skills" | "prompt" | "output" | "dialogue";

type RunInspectorProps = {
  open: boolean;
  run: AgentRun | null;
  onClose: () => void;
};

const tabs: Array<{ id: InspectorTab; label: string; icon: typeof FileText }> = [
  { id: "input", label: "原始输入", icon: FileText },
  { id: "skills", label: "用户 Skills", icon: UsersThree },
  { id: "prompt", label: "提示模块", icon: Stack },
  { id: "output", label: "模型输出", icon: BracketsCurly },
  { id: "dialogue", label: "对话调用", icon: ChatCenteredText },
];

function prettyJson(value: unknown) {
  return JSON.stringify(value, null, 2);
}

function formatInteractionDuration(milliseconds: number | undefined) {
  if (typeof milliseconds !== "number") return "";
  if (milliseconds < 1000) return ` · ${Math.max(1, Math.round(milliseconds))}ms`;
  if (milliseconds < 10_000) return ` · ${(milliseconds / 1000).toFixed(1)}s`;
  return ` · ${Math.round(milliseconds / 1000)}s`;
}

export function RunInspector({ open, run, onClose }: RunInspectorProps) {
  const panelRef = useRef<HTMLElement>(null);
  const [activeTab, setActiveTab] = useState<InspectorTab>("input");
  const closePanel = useCallback(onClose, [onClose]);
  useDialogFocus(open, panelRef, closePanel);

  useEffect(() => {
    if (open) setActiveTab("input");
  }, [open, run?.id]);

  if (!open || !run) return null;

  const trace = run.analysis_trace;
  const enabledSkills = run.user_skills.filter((skill) => skill.enabled);
  const output = trace?.model_output || prettyJson(run.analysis);

  return (
    <div className="config-backdrop inspector-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closePanel(); }}>
      <section ref={panelRef} className="config-panel inspector-panel liquid-glass" role="dialog" aria-modal="true" aria-labelledby="inspector-title" aria-describedby="inspector-description">
        <header className="config-head inspector-head">
          <div><p>RUN INSPECTOR</p><h2 id="inspector-title">查看这次分析的<em>来龙去脉。</em></h2></div>
          <button type="button" onClick={closePanel} aria-label="关闭运行检查器" title="关闭"><X /></button>
        </header>
        <p className="context-intro" id="inspector-description"><Stack /> 展示实际输入、用户 Markdown Skill、Prompt Skill、结构化输出和对话调用；不包含 API Key 或模型内部推理。</p>
        <div className="inspector-tabs" role="tablist" aria-label="分析记录类别">
          {tabs.map((tab) => {
            const Icon = tab.icon;
            return <button key={tab.id} type="button" role="tab" aria-selected={activeTab === tab.id} onClick={() => setActiveTab(tab.id)}><Icon /> {tab.label}</button>;
          })}
        </div>

        <div className="inspector-content">
          {activeTab === "input" && <section aria-label="原始输入">
            <dl className="inspector-metadata">
              <div><dt>会议日期</dt><dd>{run.meeting_date || "未单独填写"}</dd></div>
              <div><dt>补充要求</dt><dd>{run.instruction || "无"}</dd></div>
              <div><dt>运行 ID</dt><dd><code>{run.id}</code></dd></div>
            </dl>
            <h3>会议纪要原文</h3>
            <pre>{run.original_notes}</pre>
          </section>}

          {activeTab === "skills" && <section aria-label="用户 Markdown Skills">
            <div className="inspector-summary-line"><span>{enabledSkills.length} 个启用 Skill</span><span>{run.user_skills.length} 个 Markdown 文件</span></div>
            <pre>{prettyJson(run.user_skills)}</pre>
          </section>}

          {activeTab === "prompt" && <section aria-label="提示模块">
            <div className="prompt-module-list">
              {(trace?.prompt_modules ?? Object.entries(run.skill_versions).map(([name, version]) => ({ name, version, purpose: "该运行记录创建于提示快照功能之前。" }))).map((module) => (
                <article key={module.name}><div><strong>{module.name}</strong><code>v{module.version}</code></div><p>{module.purpose}</p></article>
              ))}
              {enabledSkills.map((skill) => <article className="is-user-module" key={skill.id}><div><strong>{skill.name}</strong><code>用户 Markdown</code></div><p>{skill.content}</p></article>)}
            </div>
            {trace ? <details><summary>查看实际系统提示词</summary><pre>{trace.system_prompt}</pre></details> : <p className="inspector-empty">旧运行没有保存完整提示快照，但仍保留了 Skill 版本。</p>}
          </section>}

          {activeTab === "output" && <section aria-label="模型输出">
            {!trace && <p className="inspector-empty">该运行创建于原始输出快照功能之前，下方显示当前持久化的结构化结果。</p>}
            <h3>{trace ? "模型原始结构化输出" : "系统当前结果"}</h3>
            <pre>{output}</pre>
            {trace?.normalized_output && <details><summary>查看校验和归一化后的结果</summary><pre>{prettyJson(trace.normalized_output)}</pre></details>}
          </section>}

          {activeTab === "dialogue" && <section aria-label="模型对话调用">
            {(run.model_interactions ?? []).length ? (run.model_interactions ?? []).map((interaction) => (
              <article className="inspector-interaction" key={interaction.id}>
                <header><h3>对话判断 · {interaction.normalized_intent}{formatInteractionDuration(interaction.duration_ms)}</h3><time dateTime={interaction.at}>{new Intl.DateTimeFormat("zh-CN", { dateStyle: "medium", timeStyle: "short" }).format(new Date(interaction.at))}</time></header>
                <details><summary>系统提示词</summary><pre>{interaction.system_prompt}</pre></details>
                <details><summary>模型输入</summary><pre>{interaction.user_prompt}</pre></details>
                <details><summary>模型原始输出</summary><pre>{interaction.model_output}</pre></details>
              </article>
            )) : <p className="inspector-empty">本次运行还没有调用模型处理对话消息。</p>}
          </section>}
        </div>
      </section>
    </div>
  );
}

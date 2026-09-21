import { ArrowRight, CalendarBlank, ChatCenteredText } from "@phosphor-icons/react";
import type { ActionTask, AgentQuestion } from "../types";
import { SelectField } from "./SelectField";

type ClarificationPanelProps = {
  questions: AgentQuestion[];
  tasks: ActionTask[];
  answers: Record<string, string>;
  busy: boolean;
  onAnswer: (questionId: string, value: string) => void;
  onSubmit: () => void;
};

function normalizeOptions(question: AgentQuestion) {
  return (question.options ?? []).map((option) =>
    typeof option === "string" ? { value: option, label: option } : option,
  );
}

export function ClarificationPanel({
  questions,
  tasks,
  answers,
  busy,
  onAnswer,
  onSubmit,
}: ClarificationPanelProps) {
  const answeredCount = questions.filter((question) => answers[question.id]?.trim()).length;

  return (
    <section className="agent-panel clarification-panel" aria-labelledby="clarification-title">
      <header className="agent-panel-head">
        <div>
          <p className="section-label">CLARIFICATION</p>
          <h3 id="clarification-title">还需要确认 {questions.length} 项信息</h3>
        </div>
        <ChatCenteredText size={24} aria-hidden="true" />
      </header>
      <p className="panel-intro">这些答案只会更新对应任务字段。确认完成前，系统不会创建任何任务。</p>
      <form onSubmit={(event) => { event.preventDefault(); onSubmit(); }}>
        <div className="question-list">
          {questions.map((question, index) => {
            const inputId = `question-${question.id}`;
            const task = tasks.find((item) => item.id === question.task_id);
            const options = normalizeOptions(question);

            return (
              <div className="question-row" key={question.id}>
                <span className="question-index" aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
                <div className="question-content">
                  {task && <p className="question-context">{task.title}</p>}
                  {question.input_type === "confirm" ? (
                    <fieldset>
                      <legend>{question.prompt}</legend>
                      <div className="segmented-control">
                        <label>
                          <input type="radio" name={inputId} value="yes" checked={answers[question.id] === "yes"} onChange={(event) => onAnswer(question.id, event.target.value)} />
                          <span>{question.field === "priority" ? "是，保留高优先级" : "是，创建任务"}</span>
                        </label>
                        <label>
                          <input type="radio" name={inputId} value="no" checked={answers[question.id] === "no"} onChange={(event) => onAnswer(question.id, event.target.value)} />
                          <span>{question.field === "priority" ? "否，调整为中优先级" : "不是任务"}</span>
                        </label>
                      </div>
                    </fieldset>
                  ) : question.input_type === "priority" || question.input_type === "select" ? (
                    <div className="question-select">
                      <span id={`${inputId}-label`}>{question.prompt}</span>
                      <SelectField
                        id={inputId}
                        labelledBy={`${inputId}-label`}
                        value={answers[question.id] ?? ""}
                        placeholder="请选择"
                        onValueChange={(value) => onAnswer(question.id, value)}
                        options={options.length ? options : [
                          { value: "high", label: "高优先级" },
                          { value: "medium", label: "中优先级" },
                          { value: "low", label: "低优先级" },
                        ]}
                      />
                    </div>
                  ) : (
                    <label htmlFor={inputId}>
                      <span>{question.prompt}</span>
                      <span className="question-input">
                        {question.input_type === "date" && <CalendarBlank size={17} aria-hidden="true" />}
                        {question.field === "general" ? (
                          <textarea id={inputId} value={answers[question.id] ?? ""} onChange={(event) => onAnswer(question.id, event.target.value)} placeholder="例如：王五负责整理发布公告，下周三前完成。" rows={3} />
                        ) : (
                          <input id={inputId} type={question.input_type === "date" ? "date" : "text"} value={answers[question.id] ?? ""} onChange={(event) => onAnswer(question.id, event.target.value)} placeholder={question.input_type === "date" ? undefined : "输入补充信息"} />
                        )}
                      </span>
                    </label>
                  )}
                </div>
              </div>
            );
          })}
        </div>
        <footer className="agent-panel-actions">
          <p aria-live="polite">已填写 {answeredCount} / {questions.length}</p>
          <button className="primary-action" type="submit" disabled={busy || answeredCount === 0}>
            {busy ? "正在更新任务…" : "提交补充信息"}
            <ArrowRight size={16} aria-hidden="true" />
          </button>
        </footer>
      </form>
    </section>
  );
}

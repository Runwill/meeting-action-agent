import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowDown,
  ArrowRight,
  ArrowUpRight,
  CalendarBlank,
  CaretDown,
  Check,
  CirclesFour,
  DownloadSimple,
  Eye,
  FileText,
  Key,
  ListChecks,
  Pause,
  Play,
  ShieldCheck,
  SlidersHorizontal,
  UploadSimple,
  UsersThree,
  WarningCircle,
  X,
} from "@phosphor-icons/react";
import Hls from "hls.js";
import {
  ApiError,
  confirmAgentAction,
  createAgentRun,
  getAgentRun,
  sendAgentCommand,
  sendAgentMessage,
} from "./api";
import { AgentRail } from "./components/AgentRail";
import { AgentConversation } from "./components/AgentConversation";
import { ApprovalTaskList } from "./components/ApprovalTaskList";
import { ClarificationPanel } from "./components/ClarificationPanel";
import { ExecutionLog } from "./components/ExecutionLog";
import { OpenItemsPanel } from "./components/OpenItemsPanel";
import { RunInspector } from "./components/RunInspector";
import { UserSkillsPanel } from "./components/UserSkillsPanel";
import { TrackingPanel } from "./components/TrackingPanel";
import { useDialogFocus } from "./hooks/useDialogFocus";
import type {
  ActionTask,
  AgentRun,
  ModelConfigStatus,
  Priority,
  TaskStatus,
} from "./types";

const VIDEO_SOURCE = "https://stream.mux.com/kimF2ha9zLrX64H00UgLGPflCzNtl1T0215MlAmeOztv8.m3u8";
const RUN_STORAGE_KEY = "meeting-action-agent.run-id";
const COMPREHENSIVE_NOTES = `会议主题：秋季版本故障复盘与发布协调会
会议日期：2026年9月20日
参会人：李四（产品）、张三（研发）、王五（测试）、赵六（运营）

讨论摘要：新版本暂定 9 月 30 日先面向校内用户灰度。昨天的 S1 故障已经临时缓解，但根因尚未确认；一般故障复盘原本按低优先级处理，本次是否需要提升优先级要由人工确认。

行动项：
1. 请老张在下周三前修复 S1 故障并提交复盘，复盘需写明根因、触发条件和防止复发的检查项。风险：根因未确认可能影响灰度发布。
2. 王五负责在 9 月 25 日前完成移动端登录流程回归测试并提交问题清单。依赖：张三先提供稳定的测试环境；风险：环境偶发不可用可能拖慢测试。
3. 发布公告需要补充新的登录入口并尽快完成，但会上没有确定最终负责人和交付日期。赵六可以先整理素材，李四负责审核终稿。
4. 扩容报价需要在 9 月 27 日前确认，李四和赵六都参与过讨论，但会议没有说清由谁最终负责提交采购建议。

其他讨论：大家交流了下一学期是否调整会员价格，但没有形成决议，也没有安排后续行动。
决议：先完成故障修复和登录回归，通过人工审核后再决定是否按原计划灰度。`;

const CONVERSATION_NOTES = `秋季版本协调会，9月20日下午
到场：李四、张三、王五、赵六

李四：咱们还是争取 30 号先给校内用户灰度，不过昨天那个问题得先处理。老张，S1 虽然临时压住了，根因还没找到，你下周三前把故障修掉，复盘也一起交一下，触发条件和以后怎么避免都写清楚。
赵六：这个算什么优先级？我们以前一般复盘都放低优先级，但这次又是 S1。
李四：先别替大家定，最后优先级确认时再选。根因没弄清的话，灰度肯定有风险。

王五：登录回归我来做，25 号之前给问题清单。不过得等张三先把稳定的测试环境给我，现在环境偶尔还是会断，可能会拖进度。
张三：环境我来准备，修复后你再完整跑一遍。

李四：还有公告，新登录入口得写进去，别拖太久。
赵六：我可以先把素材收一下，但最后谁写、哪天交，今天好像还没定吧？
李四：对，终稿出来我负责审核，具体谁完成和时间之后确认。

李四：扩容报价也要跟一下，27 号前得把采购建议交出来。我和赵六之前都看过报价，不过到底谁牵头，等会后再定。
赵六：行，我把供应商回复先转群里。

王五：下学期会员价格要不要调？
李四：今天先讨论到这儿，这件事没结论，也先不安排人跟进。

最后口头结论：故障修复和登录回归完成并经过人工确认后，再决定是否按原计划灰度。`;

type DemoCase = {
  id: "comprehensive" | "conversation";
  label: string;
  caption: string;
  notes: string;
  meetingDate: string;
  instruction?: string;
  hint?: string;
  needsUserSkill?: boolean;
};

const DEMO_CASES: DemoCase[] = [
  {
    id: "comprehensive",
    label: "综合测试纪要",
    caption: "一次验证完整抽取、模糊澄清、成员别名、优先级冲突、依赖风险与非任务讨论",
    notes: COMPREHENSIVE_NOTES,
    meetingDate: "2026-09-20",
    instruction: "请结合已启用的用户 Markdown Skill 理解成员别名和优先级规则；规则冲突时等待人工选择。",
    hint: "先载入测试 Skill，让模型知道“老张”=张三，并识别 S1 与一般故障复盘之间的优先级冲突。",
    needsUserSkill: true,
  },
  {
    id: "conversation",
    label: "真实对话式记录",
    caption: "同样的测试点，改为多人逐句发言、追问和口语化插话",
    notes: CONVERSATION_NOTES,
    meetingDate: "2026-09-20",
    instruction: "请结合已启用的用户 Markdown Skill 理解成员别名和优先级规则；从口语对话中还原任务，不要把没有结论的讨论当成行动项。",
    hint: "覆盖点与综合测试纪要相同，但文本更接近真实会议速记。需要先载入同一份测试 Skill。",
    needsUserSkill: true,
  },
];

const emptyConfig: ModelConfigStatus = {
  configured: false,
  provider: "未连接",
  model: null,
  baseURL: null,
  source: null,
  apiKeyPreview: null,
};
const priorityText: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const statusText: Record<TaskStatus, string> = { todo: "待开始", in_progress: "进行中", done: "已完成" };

type BusyState = "restore" | "create" | "clarify" | "approve" | "track" | "message" | "confirm" | null;

function download(name: string, content: string, type: string) {
  const url = URL.createObjectURL(new Blob(["\uFEFF", content], { type }));
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}

function csvCell(value: unknown) {
  const raw = String(value ?? "");
  const safe = /^[\t\r ]*[=+\-@]/.test(raw) ? `'${raw}` : raw;
  return `"${safe.replaceAll('"', '""')}"`;
}

function errorMessage(error: unknown, fallback: string) {
  return error instanceof Error && error.message ? error.message : fallback;
}

function scrollToElement(selector: string) {
  const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  document.querySelector(selector)?.scrollIntoView({ behavior: reducedMotion ? "auto" : "smooth", block: "start" });
}

export default function App() {
  const [notes, setNotes] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState<BusyState>("restore");
  const [runError, setRunError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [approvalDraft, setApprovalDraft] = useState<ActionTask[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

  const [configStatus, setConfigStatus] = useState<ModelConfigStatus>(emptyConfig);
  const [configOpen, setConfigOpen] = useState(false);
  const [skillsOpen, setSkillsOpen] = useState(false);
  const [skillDemoPrompt, setSkillDemoPrompt] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [configForm, setConfigForm] = useState({ baseURL: "https://api.deepseek.com", apiKey: "", model: "deepseek-chat" });
  const [configBusy, setConfigBusy] = useState<"test" | "save" | "clear" | null>(null);
  const [configMessage, setConfigMessage] = useState("");
  const [configError, setConfigError] = useState("");
  const [studioOpen, setStudioOpen] = useState(false);
  const [optionsOpen, setOptionsOpen] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [visualOpen, setVisualOpen] = useState(false);
  const [centerShade, setCenterShade] = useState(() => {
    const saved = Number(localStorage.getItem("meeting-action-agent.center-shade"));
    return Number.isFinite(saved) && saved >= 0 && saved <= 0.72 ? saved : 0.08;
  });
  const [videoPaused, setVideoPaused] = useState(() => window.matchMedia("(prefers-reduced-motion: reduce)").matches);
  const [toast, setToast] = useState("");

  const pageRef = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const videoPausedRef = useRef(videoPaused);
  const notesRef = useRef<HTMLTextAreaElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const resultsHeadingRef = useRef<HTMLHeadingElement>(null);
  const previousStateRef = useRef<AgentRun["state"] | null>(null);
  const configPanelRef = useRef<HTMLElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const runGenerationRef = useRef(0);

  useEffect(() => {
    document.documentElement.style.setProperty("--center-shade", String(centerShade));
    localStorage.setItem("meeting-action-agent.center-shade", String(centerShade));
  }, [centerShade]);

  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const closeSkills = useCallback(() => { setSkillsOpen(false); setSkillDemoPrompt(false); }, []);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  useDialogFocus(configOpen, configPanelRef, closeConfig);

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  const adoptRun = useCallback((next: AgentRun, restoreInput = false, expectedGeneration?: number) => {
    if (expectedGeneration !== undefined && expectedGeneration !== runGenerationRef.current) return false;
    setRun(next);
    setRunError("");
    localStorage.setItem(RUN_STORAGE_KEY, next.id);
    if (next.state === "awaiting_approval" || next.state === "failed") {
      setApprovalDraft(next.analysis.tasks.map((task) => ({ ...task })));
      setSelectedTaskIds(next.approved_task_ids.length ? next.approved_task_ids : next.analysis.tasks.map((task) => task.id));
    }
    if (next.state === "clarifying") {
      setAnswers(Object.fromEntries(next.questions.map((question) => [question.id, question.answer ?? ""])));
    }
    if (restoreInput) {
      setNotes(next.original_notes);
      setMeetingDate(next.meeting_date || next.analysis.meeting_date || "");
      setInstruction(next.instruction || "");
    }
    return true;
  }, []);

  useEffect(() => {
    fetch("/api/config")
      .then(async (response) => {
        if (!response.ok) throw new Error("无法读取模型配置。");
        return response.json() as Promise<ModelConfigStatus>;
      })
      .then((data) => {
        setConfigStatus(data);
        if (data.baseURL || data.model) {
          setConfigForm((current) => ({
            ...current,
            baseURL: data.baseURL || current.baseURL,
            model: data.model || current.model,
          }));
        }
      })
      .catch(() => {
        setConfigStatus(emptyConfig);
      });
  }, []);

  useEffect(() => {
    const runId = localStorage.getItem(RUN_STORAGE_KEY);
    if (!runId) {
      setBusy(null);
      return;
    }
    const generation = runGenerationRef.current;
    let current = true;
    getAgentRun(runId)
      .then((restored) => {
        if (current) adoptRun(restored, true, generation);
      })
      .catch((error) => {
        if (!current) return;
        if (error instanceof ApiError && error.status === 404) {
          localStorage.removeItem(RUN_STORAGE_KEY);
          setRunError("上次运行记录已不存在，可以重新分析纪要。");
        } else {
          setRunError(errorMessage(error, "暂时无法恢复上次运行。"));
        }
      })
      .finally(() => {
        if (current) setBusy(null);
      });
    return () => { current = false; };
  }, [adoptRun]);

  useEffect(() => {
    if (!run || (run.state !== "executing" && run.state !== "verifying")) return;
    const generation = runGenerationRef.current;
    let current = true;
    let timer: number | undefined;
    let consecutiveFailures = 0;

    const poll = async () => {
      try {
        const snapshot = await getAgentRun(run.id);
        if (!current) return;
        consecutiveFailures = 0;
        adoptRun(snapshot, false, generation);
        if (snapshot.state === "executing" || snapshot.state === "verifying") {
          timer = window.setTimeout(poll, 700);
        }
      } catch (error) {
        if (!current) return;
        consecutiveFailures += 1;
        if (consecutiveFailures >= 3) {
          setRunError(errorMessage(error, "执行仍在进行，但暂时无法读取最新状态。页面会继续重试。"));
        }
        timer = window.setTimeout(poll, Math.min(3000, 700 * consecutiveFailures));
      }
    };

    timer = window.setTimeout(poll, 500);
    return () => {
      current = false;
      if (timer !== undefined) window.clearTimeout(timer);
    };
  }, [adoptRun, run?.id, run?.state]);

  useEffect(() => {
    if (!run) {
      previousStateRef.current = null;
      return;
    }
    const previous = previousStateRef.current;
    previousStateRef.current = run.state;
    if (previous !== run.state && !configOpen && !skillsOpen) {
      requestAnimationFrame(() => resultsHeadingRef.current?.focus({ preventScroll: true }));
    }
  }, [configOpen, skillsOpen, run?.state]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;
    const motion = matchMedia("(prefers-reduced-motion: reduce)");
    let hls: Hls | undefined;
    const ready = () => {
      video.classList.add("is-ready");
      if (motion.matches || videoPausedRef.current) video.pause();
      else video.play().catch(() => undefined);
    };
    if (Hls.isSupported()) {
      hls = new Hls({ enableWorker: true, lowLatencyMode: true });
      hls.loadSource(VIDEO_SOURCE);
      hls.attachMedia(video);
      hls.on(Hls.Events.MANIFEST_PARSED, ready);
    } else if (video.canPlayType("application/vnd.apple.mpegurl")) {
      video.src = VIDEO_SOURCE;
      video.addEventListener("loadeddata", ready, { once: true });
    }
    const change = () => {
      if (motion.matches) {
        setVideoPaused(true);
        video.pause();
      } else if (!videoPausedRef.current) {
        video.play().catch(() => undefined);
      }
    };
    motion.addEventListener("change", change);
    return () => {
      hls?.destroy();
      motion.removeEventListener("change", change);
    };
  }, []);

  useEffect(() => {
    videoPausedRef.current = videoPaused;
    const video = videoRef.current;
    if (!video) return;
    if (videoPaused) video.pause();
    else video.play().catch(() => undefined);
  }, [videoPaused]);

  useEffect(() => () => clearTimeout(toastTimer.current), []);
  useEffect(() => {
    if (studioOpen) requestAnimationFrame(() => notesRef.current?.focus());
  }, [studioOpen]);
  useEffect(() => {
    const syncModelRoute = () => {
      if (window.location.hash === "#model") setConfigOpen(true);
    };
    syncModelRoute();
    window.addEventListener("hashchange", syncModelRoute);
    return () => window.removeEventListener("hashchange", syncModelRoute);
  }, []);
  useEffect(() => {
    if (pageRef.current) pageRef.current.inert = configOpen || skillsOpen || inspectorOpen;
  }, [configOpen, skillsOpen, inspectorOpen]);

  const analysis = run?.analysis ?? null;
  const exportTasks = useMemo(() => {
    if (!analysis) return [];
    const approvedIds = new Set(run?.approved_task_ids ?? []);
    const source = run?.state === "awaiting_approval"
      ? approvalDraft
      : approvedIds.size
      ? analysis.tasks.filter((task) => approvedIds.has(task.id))
      : analysis.tasks;
    const createdById = new Map((run?.created_tasks ?? []).map((task) => [task.task_id, task]));
    return source.map((task) => {
      const created = createdById.get(task.id);
      return created ? { ...task, status: created.status } : task;
    });
  }, [analysis, approvalDraft, run?.approved_task_ids, run?.created_tasks, run?.state]);
  const stats = useMemo(() => {
    const tasks = exportTasks;
    return {
      total: tasks.length,
      review: run?.open_items?.filter((item) => item.status === "open").length ?? run?.questions.length ?? 0,
      done: run?.tracking?.done ?? tasks.filter((task) => task.status === "done").length,
    };
  }, [exportTasks, run?.open_items, run?.questions.length, run?.tracking?.done]);
  const activeState = busy === "create" ? "analyzing" : run?.state ?? "idle";
  const isExecutionActive = busy === "approve" || run?.state === "executing" || run?.state === "verifying";
  const runRequiresResolution = !!run && ["executing", "verifying", "failed"].includes(run.state);

  function selectProvider(provider: "deepseek" | "openai") {
    setConfigForm((current) => ({
      ...current,
      baseURL: provider === "deepseek" ? "https://api.deepseek.com" : "https://api.openai.com/v1",
      model: provider === "deepseek" ? "deepseek-chat" : "gpt-4o-mini",
    }));
    setConfigError("");
    setConfigMessage("");
  }

  async function configRequest(path: string, method: "POST" | "DELETE", mode: "test" | "save" | "clear") {
    setConfigBusy(mode);
    setConfigError("");
    setConfigMessage("");
    try {
      const response = await fetch(path, {
        method,
        headers: method === "POST" ? { "Content-Type": "application/json" } : undefined,
        body: method === "POST" ? JSON.stringify(configForm) : undefined,
      });
      // The Vite proxy can return an empty or non-JSON body when the API process is down.
      // Parse defensively so that the user sees the actual connection problem instead of
      // the browser's opaque "Unexpected end of JSON input" error.
      const responseText = await response.text();
      let data: Partial<ModelConfigStatus> & { error?: string; message?: string } = {};
      if (!responseText.trim()) {
        throw new Error(response.ok
          ? "模型服务没有返回配置结果，请重试。"
          : `请求没有完成（HTTP ${response.status}）。请确认 API 服务正在运行。`);
      } else {
        try {
          data = JSON.parse(responseText) as Partial<ModelConfigStatus> & { error?: string; message?: string };
        } catch {
          if (!response.ok) {
            throw new Error(`模型服务没有返回有效响应（HTTP ${response.status}）。请确认 API 服务正在运行。`);
          }
          throw new Error("服务器返回了无法解析的数据，请重试。");
        }
      }
      if (!response.ok) {
        throw new Error(data.error || `请求没有完成（HTTP ${response.status}）。请确认 API 服务正在运行。`);
      }
      if (mode === "test") {
        setConfigMessage(data.message || "连接成功。");
      } else {
        if (typeof data.configured !== "boolean" || typeof data.provider !== "string") {
          throw new Error("服务器返回的配置状态不完整，请重试。");
        }
        const nextConfig = data as ModelConfigStatus;
        setConfigStatus(nextConfig);
        setConfigForm((current) => ({
          ...current,
          apiKey: "",
          baseURL: nextConfig.baseURL || "https://api.deepseek.com",
          model: nextConfig.model || "deepseek-chat",
        }));
        if (mode === "save") {
          setConfigMessage("连接配置已保存到本机，服务重启后仍然有效。");
          notify(`${nextConfig.provider} 已连接`);
        } else {
          setConfigMessage(nextConfig.configured ? "本机配置已移除，当前使用环境变量配置。" : "模型配置已移除，启动 Agent 前需要重新连接。");
          notify(nextConfig.configured ? "已恢复环境配置" : "模型连接已移除");
        }
      }
    } catch (error) {
      setConfigError(errorMessage(error, "请求没有完成。"));
    } finally {
      setConfigBusy(null);
    }
  }

  async function startAnalysis() {
    if (statusBusyId !== null || runRequiresResolution) return;
    if (!configStatus.configured) {
      setRunError("请先连接并保存模型 API，再启动 Agent。");
      setConfigOpen(true);
      return;
    }
    const trimmedNotes = notes.trim();
    if (trimmedNotes.length < 10) {
      setRunError("请先放入一段完整纪要，至少需要 10 个字符。");
      notesRef.current?.focus();
      return;
    }
    if (trimmedNotes.length > 100_000) {
      setRunError("纪要超过 10 万字符，请精简后重试。");
      notesRef.current?.focus();
      return;
    }
    const generation = ++runGenerationRef.current;
    setBusy("create");
    setRunError("");
    try {
      const next = await createAgentRun({ notes: trimmedNotes, meetingDate: meetingDate || undefined, instruction: instruction.trim() || undefined });
      if (!adoptRun(next, false, generation)) return;
      setStudioOpen(false);
      notify(next.state === "clarifying" ? `发现 ${next.questions.length} 项需要确认的信息` : `已规划 ${next.analysis.tasks.length} 个行动项`);
      window.setTimeout(() => scrollToElement("#workflow"), 120);
    } catch (error) {
      if (generation === runGenerationRef.current) setRunError(errorMessage(error, "分析没有完成，请稍后重试。"));
    } finally {
      if (generation === runGenerationRef.current) setBusy(null);
    }
  }

  async function submitClarification() {
    if (!run || busy !== null) return;
    const submitted = run.questions
      .map((question) => ({ questionId: question.id, value: answers[question.id]?.trim() || "" }))
      .filter((answer) => answer.value);
    if (!submitted.length) return;
    const generation = runGenerationRef.current;
    setBusy("clarify");
    setRunError("");
    try {
      const { run: next } = await sendAgentCommand(run.id, { type: "answer_questions", payload: { answers: submitted } });
      if (!adoptRun(next, false, generation)) return;
      notify(next.state === "awaiting_approval" ? "信息已补齐，请审批创建范围" : "补充信息已记录");
    } catch (error) {
      if (generation === runGenerationRef.current) setRunError(errorMessage(error, "补充信息没有提交成功。"));
    } finally {
      if (generation === runGenerationRef.current) setBusy(null);
    }
  }

  async function approveTasks() {
    if (!run || busy !== null || !selectedTaskIds.length) return;
    const beforeApproval = run;
    const generation = runGenerationRef.current;

    setBusy("approve");
    setRunError("");
    setRun((current) => current ? { ...current, state: "executing" } : current);
    try {
      const { run: next } = await sendAgentCommand(run.id, { type: "approve_tasks", payload: { tasks: approvalDraft, selectedTaskIds } });
      if (!adoptRun(next, false, generation)) return;
      notify(next.state === "failed" ? "任务执行或验证未完成" : "任务已创建并完成回读验证");
    } catch (error) {
      const message = errorMessage(error, "任务创建没有完成。");
      if (generation !== runGenerationRef.current) return;
      try {
        const latest = await getAgentRun(run.id);
        adoptRun(latest, false, generation);
      } catch {
        setRun(beforeApproval);
      }
      setRunError(message);
    } finally {
      if (generation === runGenerationRef.current) setBusy(null);
    }
  }

  async function refreshTracking() {
    if (!run || statusBusyId || busy !== null) return;
    const generation = runGenerationRef.current;
    setBusy("track");
    setRunError("");
    try {
      const { run: next } = await sendAgentCommand(run.id, { type: "refresh_tracking" });
      if (!adoptRun(next, false, generation)) return;
      notify(next.state === "completed" ? "所有任务已完成" : "追踪状态已刷新");
    } catch (error) {
      if (generation === runGenerationRef.current) setRunError(errorMessage(error, "追踪状态没有刷新成功。"));
    } finally {
      if (generation === runGenerationRef.current) setBusy(null);
    }
  }

  async function changeTaskStatus(externalId: string, status: TaskStatus) {
    if (!run || run.state !== "tracking" || statusBusyId || busy !== null) return;
    const generation = runGenerationRef.current;
    setStatusBusyId(externalId);
    setRunError("");
    try {
      const { run: next } = await sendAgentCommand(run.id, { type: "set_task_status", payload: { externalTaskId: externalId, status } });
      if (generation !== runGenerationRef.current) return;
      if (!adoptRun(next, false, generation)) return;
      notify(`任务已更新为“${statusText[status]}”`);
    } catch (error) {
      if (generation === runGenerationRef.current) setRunError(errorMessage(error, "任务状态没有更新成功。"));
    } finally {
      if (generation === runGenerationRef.current) setStatusBusyId(null);
    }
  }

  async function submitMessage(content: string) {
    if (!run || busy !== null || statusBusyId !== null) return false;
    const generation = runGenerationRef.current;
    setBusy("message");
    setRunError("");
    try {
      const next = await sendAgentMessage(run.id, content);
      return adoptRun(next, false, generation);
    } catch (error) {
      if (generation === runGenerationRef.current) setRunError(errorMessage(error, "消息没有发送成功。"));
      return false;
    } finally {
      if (generation === runGenerationRef.current) setBusy(null);
    }
  }

  async function confirmPendingAction(actionId: string, approved: boolean) {
    if (!run || busy !== null || statusBusyId !== null) return;
    const actionType = run.pending_action?.id === actionId ? run.pending_action.type : null;
    const generation = runGenerationRef.current;
    setBusy("confirm");
    setRunError("");
    try {
      const next = await confirmAgentAction(run.id, actionId, approved);
      if (!adoptRun(next, false, generation)) return;
      notify(approved ? actionType === "edit_task" ? "任务信息已更新" : "状态已更新" : "操作已取消");
    } catch (error) {
      if (generation === runGenerationRef.current) setRunError(errorMessage(error, "操作确认没有完成。"));
    } finally {
      if (generation === runGenerationRef.current) setBusy(null);
    }
  }

  function startOver() {
    if (busy !== null || statusBusyId !== null) return;
    runGenerationRef.current += 1;
    localStorage.removeItem(RUN_STORAGE_KEY);
    setRun(null);
    setAnswers({});
    setApprovalDraft([]);
    setSelectedTaskIds([]);
    setRunError("");
    setStudioOpen(true);
    window.scrollTo({ top: 0, behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth" });
  }

  async function readFile(file?: File) {
    if (!file) return;
    if (file.size > 2 * 1024 * 1024) {
      setRunError("文件超过 2 MB，请选择更小的 TXT 或 Markdown 文件。");
      return;
    }
    setNotes(await file.text());
    setStudioOpen(true);
    setRunError("");
    notify("纪要已导入");
  }

  function loadDemoCase(demo: DemoCase) {
    if (busy !== null || statusBusyId !== null) return;
    runGenerationRef.current += 1;
    localStorage.removeItem(RUN_STORAGE_KEY);
    setRun(null);
    setAnswers({});
    setApprovalDraft([]);
    setSelectedTaskIds([]);
    setRunError("");
    setNotes(demo.notes);
    setMeetingDate(demo.meetingDate);
    setInstruction(demo.instruction || "");
    setOptionsOpen(false);
    setStudioOpen(true);
    if (demo.needsUserSkill) {
      setSkillDemoPrompt(true);
      setSkillsOpen(true);
    }
    notify(`${demo.label}演示已载入`);
  }

  function exportMarkdown() {
    if (!analysis) return;
    const tasks = exportTasks.map((task) =>
      `- [${task.status === "done" ? "x" : " "}] **${task.title}** - ${task.owner || "待定"} / ${task.due_date || "待定"} / ${priorityText[task.priority]}优先级`,
    ).join("\n");
    download(
      `${analysis.meeting_title || "会议行动项"}.md`,
      `# ${analysis.meeting_title}\n\n${analysis.summary}\n\n## 行动项\n\n${tasks || "暂无"}\n\n## 已确认决策\n\n${analysis.decisions.map((item) => `- ${item}`).join("\n") || "暂无"}\n\n## 待确认\n\n${analysis.follow_ups.map((item) => `- ${item}`).join("\n") || "暂无"}\n`,
      "text/markdown;charset=utf-8",
    );
    notify("Markdown 已导出");
  }

  function exportCsv() {
    if (!analysis) return;
    const rows = exportTasks.map((task) => [
      task.title,
      task.owner,
      task.due_date,
      priorityText[task.priority],
      task.priority_reason,
      statusText[task.status],
      task.description,
      task.evidence,
    ]);
    download(
      `${analysis.meeting_title || "会议行动项"}.csv`,
      [["任务", "负责人", "截止日期", "优先级", "优先级理由", "状态", "说明", "原文证据"], ...rows].map((row) => row.map(csvCell).join(",")).join("\n"),
      "text/csv;charset=utf-8",
    );
    notify("CSV 已导出");
  }

  return (
    <main className="app" aria-labelledby="hero-title">
      <div ref={pageRef} className="page-content">
        <div className="video-layer" aria-hidden="true"><video ref={videoRef} autoPlay muted loop playsInline preload="auto" /></div>
        <div className="cinematic-mask" aria-hidden="true" />
        <div className="center-veil" aria-hidden="true" />
        <div className="film-grain" aria-hidden="true" />
        <div className="guide guide-left" aria-hidden="true" />
        <div className="guide guide-right" aria-hidden="true" />

        <nav className="navbar" aria-label="主导航">
          <div className="nav-inner liquid-glass">
            <a className="brand" href="#top" aria-label="会议行动智能体首页"><CirclesFour /><span>会议行动</span></a>
            <div className="nav-links"><a href="#top">纪要输入</a><a href="#workflow">执行轨道</a><a href="#results">任务结果</a></div>
            <div className="nav-actions">
              <div className="visual-control-wrap">
                <button className="model-trigger visual-trigger" type="button" onClick={() => setVisualOpen((open) => !open)} aria-expanded={visualOpen} aria-controls="visual-control" aria-label="调整中央画布通透度"><Eye /><span className="engine-label">通透度</span></button>
              </div>
              <button className="model-trigger" type="button" onClick={() => setSkillsOpen(true)} aria-label="打开用户 Markdown Skill"><UsersThree /><span className="engine-label">用户 Skills</span></button>
              <button className="model-trigger" type="button" onClick={() => setConfigOpen(true)} aria-label="打开模型连接设置"><span className="engine-label"><i className={configStatus.configured ? "ai" : "unconfigured"} />{configStatus.configured ? `${configStatus.provider} · ${configStatus.model}` : "未连接模型"}</span><SlidersHorizontal /></button>
              <button className="nav-cta liquid-glass" type="button" onClick={() => setStudioOpen(true)}>放入纪要</button>
              <button ref={menuButtonRef} className="menu-button" type="button" aria-label={menuOpen ? "关闭菜单" : "打开菜单"} aria-expanded={menuOpen} aria-controls="mobile-menu" onClick={() => setMenuOpen((open) => !open)}>{menuOpen ? <X /> : <ListChecks />}</button>
            </div>
          </div>
          {visualOpen && <div className="visual-control liquid-glass" id="visual-control" role="dialog" aria-label="中央画布通透度调节"><div className="visual-control-head"><span>中央画布通透度</span><strong>{Math.round((1 - centerShade / 0.72) * 100)}%</strong></div><input aria-label="中央画布通透度" type="range" min="0" max="0.72" step="0.01" value={centerShade} onChange={(event) => setCenterShade(Number(event.target.value))} /><div className="visual-control-scale"><span>背景更清晰</span><span>背景更暗</span></div></div>}
          {menuOpen && (
            <div className="mobile-menu liquid-glass" id="mobile-menu">
              <a href="#workflow" onClick={() => setMenuOpen(false)}>执行轨道</a>
              <a href="#results" onClick={() => setMenuOpen(false)}>任务结果</a>
              <button type="button" onClick={() => { menuButtonRef.current?.focus(); setSkillsOpen(true); setMenuOpen(false); }}><UsersThree /> 用户 Skills</button>
              <button type="button" onClick={() => { menuButtonRef.current?.focus(); setConfigOpen(true); setMenuOpen(false); }}><Key /> 模型连接</button>
              <button type="button" onClick={() => { setStudioOpen(true); setMenuOpen(false); }}>放入纪要</button>
              <button type="button" onClick={() => { setVisualOpen((open) => !open); setMenuOpen(false); }}><Eye /> 调整通透度</button>
            </div>
          )}
        </nav>

        <section className={`hero-stage ${studioOpen ? "studio-is-open" : ""}`} id="top">
          <div className="hero-content">
            <p className="tagline reveal reveal-tag">MEETING ACTION INTELLIGENCE</p>
            <h1 id="hero-title" className="hero-title reveal reveal-title">From minutes<br className="desktop-break" /> to <em>momentum.</em></h1>
            <p className="hero-copy reveal reveal-copy">把讨论变成清晰、有人负责、经过确认并可持续追踪的下一步。</p>
            {!studioOpen ? (
              <div className="hero-actions reveal reveal-actions">
                <button className="access-button" type="button" onClick={() => setStudioOpen(true)}>放入会议纪要</button>
                <p className="demo-caption">两种写法覆盖同一组能力：一份便于核对字段，一份模拟多人逐句发言的真实会议速记。</p>
                <div className="demo-presets" aria-label="演示输入">
                  {DEMO_CASES.map((demo) => (
                    <button
                      className="demo-preset"
                      key={demo.id}
                      type="button"
                      onClick={() => loadDemoCase(demo)}
                      title={demo.hint}
                      aria-label={`${demo.label}：${demo.caption}${demo.hint ? `。${demo.hint}` : ""}`}
                    >
                      <span>{demo.label}</span>
                      <small>{demo.caption}</small>
                      <ArrowUpRight aria-hidden="true" />
                    </button>
                  ))}
                </div>
              </div>
            ) : (
              <section className="composer liquid-glass" aria-label="会议纪要工作区">
                <header className="composer-head">
                  <span><FileText /> 会议纪要</span>
                  <div>
                    <button type="button" onClick={() => fileInput.current?.click()}><UploadSimple /> 导入</button>
                    <button type="button" aria-label="收起工作区" title="收起" onClick={() => setStudioOpen(false)}><X /></button>
                  </div>
                </header>
                <label className="notes-field">
                  <span className="visually-hidden">会议纪要正文</span>
                  <textarea ref={notesRef} value={notes} onChange={(event) => setNotes(event.target.value)} placeholder="粘贴会议记录、录音转写或聊天内容…" spellCheck={false} />
                  <small>{notes.length.toLocaleString()} 字符</small>
                </label>
                <input ref={fileInput} className="visually-hidden" type="file" accept=".txt,.md,text/plain,text/markdown" tabIndex={-1} aria-label="导入会议纪要文件" onChange={(event) => void readFile(event.target.files?.[0])} />
                {optionsOpen && (
                  <div className="options-panel">
                    <label><span><CalendarBlank /> 会议日期（可选）</span><input type="date" value={meetingDate} onChange={(event) => setMeetingDate(event.target.value)} /></label>
                    <label><span><SlidersHorizontal /> 补充要求</span><input value={instruction} onChange={(event) => setInstruction(event.target.value)} placeholder="例如：优先提取产品与发布事项" /></label>
                  </div>
                )}
                {runError && !run && <p className="error-message" role="alert">{runError}</p>}
                <footer className="composer-actions">
                  <button className="options-button" type="button" aria-expanded={optionsOpen} onClick={() => setOptionsOpen((open) => !open)}><SlidersHorizontal /> 分析设置 <CaretDown className={optionsOpen ? "rotated" : ""} /></button>
                  <button className="analyze-button" type="button" onClick={() => void startAnalysis()} disabled={busy !== null || statusBusyId !== null || runRequiresResolution}>
                    <span>{busy === "create" ? "正在识别与规划" : "启动 Agent"}</span>
                    {busy === "create" ? <i className="loader" /> : <ArrowRight />}
                  </button>
                </footer>
              </section>
            )}
            <button className="scroll-cue reveal reveal-cue" type="button" onClick={() => scrollToElement("#workflow")}>查看执行轨道 <ArrowDown /></button>
          </div>
          <button
            className="motion-toggle"
            type="button"
            aria-label={videoPaused ? "播放背景视频" : "暂停背景视频"}
            title={videoPaused ? "播放背景视频" : "暂停背景视频"}
            onClick={() => setVideoPaused((paused) => !paused)}
          >
            {videoPaused ? <Play weight="fill" /> : <Pause weight="fill" />}
          </button>
        </section>

        <section className="manifesto agent-manifesto" id="workflow">
          <div className="workflow-heading">
            <p className="section-label">CONTROLLED HANDOFF</p>
            <h2>{run ? "每一步都有依据，\n每次写入都经批准。" : "从纪要到完成，\n沿一条可验证的路径。"}</h2>
            <p>{run ? `运行 ${run.id.slice(0, 8)} · 最近更新 ${new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit" }).format(new Date(run.updated_at))}` : "分析、澄清、审批、执行、验证与追踪由同一状态轨道串联。"}</p>
          </div>
          <AgentRail state={activeState} events={run?.events} />
        </section>

        <section className={`results-stage ${run ? "has-results" : ""}`} id="results">
          <div className="results-shell">
            <header className="results-header">
              <div>
                <p className="section-label">AGENT WORKSPACE</p>
                <h2 ref={resultsHeadingRef} tabIndex={-1}>{analysis?.meeting_title || "下一步，从清晰的责任开始。"}</h2>
                <p>{analysis?.summary || (busy === "restore" ? "正在恢复上次运行…" : "放入会议纪要后，系统会先判断信息是否足够，再进入人工审批。")}</p>
              </div>
              <div className="result-tools">
                {run && !["executing", "verifying", "failed"].includes(run.state) && <button className="new-run-button" type="button" onClick={startOver} disabled={busy !== null || statusBusyId !== null}><ArrowUpRight /> 新建运行</button>}
                {run && <button type="button" onClick={() => setInspectorOpen(true)}><FileText /> 输入与模型记录</button>}
                <button type="button" onClick={exportMarkdown} disabled={!exportTasks.length}><DownloadSimple /> Markdown</button>
                <button type="button" onClick={exportCsv} disabled={!exportTasks.length}><DownloadSimple /> CSV</button>
              </div>
            </header>

            {run && (
              <div className="stats-line" aria-label="任务统计">
                <div><strong>{String(stats.total).padStart(2, "0")}</strong><span>行动项</span></div>
                <div><strong>{String(stats.review).padStart(2, "0")}</strong><span>待处理</span></div>
                <div><strong>{String(stats.done).padStart(2, "0")}</strong><span>已完成</span></div>
                <div className="attendees"><span>参会人</span><strong>{analysis?.attendees.length ? analysis.attendees.join(" · ") : "未识别"}</strong></div>
              </div>
            )}

            {runError && <div className="run-error" role="alert"><WarningCircle weight="fill" /><p>{runError}</p></div>}
            {busy === "restore" && !run && <div className="restore-state" role="status"><i className="loader" /> 正在恢复上次运行…</div>}

            {!run && busy !== "restore" && (
              <div className="empty-panel">
                <span>NO ACTIVE RUN</span>
                <p>先放入一份会议纪要。</p>
                <button type="button" onClick={() => { setStudioOpen(true); window.scrollTo({ top: 0, behavior: "auto" }); }}>打开纪要工作区 <ArrowUpRight /></button>
              </div>
            )}

            {run && (
              <div className="agent-workspace-grid">
                <div className="agent-workspace-main">
                  <AgentConversation run={run} busy={busy !== null || statusBusyId !== null} onSend={submitMessage} onConfirm={(actionId, approved) => void confirmPendingAction(actionId, approved)} />

                  {run.state === "clarifying" && (
                    <ClarificationPanel
                      questions={run.questions}
                      tasks={run.analysis.tasks}
                      answers={answers}
                      busy={busy !== null}
                      onAnswer={(questionId, value) => setAnswers((current) => ({ ...current, [questionId]: value }))}
                      onSubmit={() => void submitClarification()}
                    />
                  )}

                  {run.state === "awaiting_approval" && (
                    <ApprovalTaskList
                      tasks={approvalDraft}
                      selectedTaskIds={selectedTaskIds}
                      busy={busy !== null}
                      onTasksChange={setApprovalDraft}
                      onSelectionChange={setSelectedTaskIds}
                      onApprove={() => void approveTasks()}
                    />
                  )}

                  {(run.state === "tracking" || run.state === "completed" || (run.state === "failed" && run.created_tasks.length > 0)) && (
                    <TrackingPanel
                      state={run.state}
                      tasks={run.created_tasks}
                      tracking={run.tracking}
                      busy={busy !== null || statusBusyId !== null || !!run.pending_action}
                      statusBusyId={statusBusyId}
                      onRefresh={() => void refreshTracking()}
                      onStatusChange={(externalId, status) => void changeTaskStatus(externalId, status)}
                    />
                  )}

                  {run.state === "failed" && (
                    <section className="outcome-panel is-failed" role="alert" aria-labelledby="failed-title">
                      <WarningCircle weight="fill" />
                      <div><h3 id="failed-title">本次执行或验证未完成</h3><p>成功步骤已保留。请查看执行与回读记录，并使用原批准范围安全重试，已有任务会按幂等键复用。</p></div>
                      <div className="outcome-actions">
                        <button type="button" onClick={() => void approveTasks()} disabled={busy === "approve"}>{busy === "approve" ? "正在安全重试…" : "安全重试原运行"}</button>
                      </div>
                    </section>
                  )}

                  {run.state === "completed" && (
                    <section className="outcome-panel is-complete" aria-labelledby="complete-title">
                      <ShieldCheck weight="fill" />
                      <div><h3 id="complete-title">会议行动闭环已完成</h3><p>所有已批准任务均已创建、回读验证并更新为完成。</p></div>
                    </section>
                  )}
                </div>

                <aside className="agent-workspace-context" aria-label="运行上下文">
                  <OpenItemsPanel items={run.open_items ?? []} tasks={run.analysis.tasks} />
                  {analysis && analysis.decisions.length > 0 && (
                    <section className="decision-panel" aria-labelledby="decisions-title">
                      <header className="context-panel-head"><div><p className="section-label">DECISIONS</p><h3 id="decisions-title">会议决策</h3></div><strong>{String(analysis.decisions.length).padStart(2, "0")}</strong></header>
                      <ol>{analysis.decisions.map((item) => <li key={item}>{item}</li>)}</ol>
                    </section>
                  )}
                  <ExecutionLog events={run.events} live={isExecutionActive} />
                </aside>
              </div>
            )}
          </div>
        </section>

        <footer className="site-footer"><span>会议行动智能体 / 本地任务中心</span><span>先确认，再执行。<ArrowUpRight /></span></footer>
      </div>

      {configOpen && (
        <div className="config-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeConfig(); }}>
          <section ref={configPanelRef} className="config-panel liquid-glass" role="dialog" aria-modal="true" aria-labelledby="config-title" aria-describedby="config-description">
            <header className="config-head"><div><p>MODEL CONNECTION</p><h2 id="config-title">连接你的<em>分析模型。</em></h2></div><button type="button" onClick={closeConfig} aria-label="关闭模型设置" title="关闭"><X /></button></header>
            <div className={`config-status ${configStatus.configured ? "connected" : ""}`}><i /><div><span>{configStatus.configured ? `${configStatus.provider} 已连接` : "尚未连接分析模型"}</span><small>{configStatus.configured ? `${configStatus.model} · ${configStatus.source === "persistent" ? "已保存在本机" : configStatus.source === "environment" ? "环境变量" : "临时配置"}` : "连接并保存后才能启动 Agent"}</small></div>{configStatus.apiKeyPreview && <code>{configStatus.apiKeyPreview}</code>}</div>
            <div className="provider-presets" role="group" aria-label="模型服务预设"><button type="button" aria-pressed={configForm.baseURL.includes("deepseek")} onClick={() => selectProvider("deepseek")}>DeepSeek</button><button type="button" aria-pressed={configForm.baseURL.includes("openai.com")} onClick={() => selectProvider("openai")}>OpenAI</button><span>兼容 OpenAI 协议</span></div>
            <div className="config-fields">
              <label className="config-field"><span>API 地址</span><input type="url" value={configForm.baseURL} onChange={(event) => setConfigForm({ ...configForm, baseURL: event.target.value })} placeholder="https://api.deepseek.com" autoComplete="url" /></label>
              <label className="config-field"><span>API Key</span><input type="password" value={configForm.apiKey} onChange={(event) => setConfigForm({ ...configForm, apiKey: event.target.value })} placeholder={configStatus.configured ? "输入新 Key 以更新或测试" : "sk-..."} autoComplete="new-password" spellCheck={false} /></label>
              <label className="config-field"><span>模型</span><input value={configForm.model} onChange={(event) => setConfigForm({ ...configForm, model: event.target.value })} placeholder="deepseek-chat" spellCheck={false} /></label>
            </div>
            <p className="secret-note" id="config-description"><Key /> Key 保存在本机专用配置文件中，不写入浏览器、任务数据或 Git；本机其他用户若能读取项目目录，仍可能访问该 Key。</p>
            <div className="config-feedback" aria-live="polite">{configError ? <span className="is-error">{configError}</span> : configMessage ? <span className="is-success"><Check /> {configMessage}</span> : <span>先测试，再保存到当前运行。</span>}</div>
            <footer className="config-actions"><button className="clear-config" type="button" onClick={() => void configRequest("/api/config", "DELETE", "clear")} disabled={!!configBusy || configStatus.source !== "persistent"}>移除本机配置</button><div><button type="button" onClick={() => void configRequest("/api/config/test", "POST", "test")} disabled={!!configBusy}>{configBusy === "test" ? "正在连接…" : "测试连接"}</button><button className="save-config" type="button" onClick={() => void configRequest("/api/config", "POST", "save")} disabled={!!configBusy}>{configBusy === "save" ? "正在保存…" : "保存连接"} <ArrowRight /></button></div></footer>
          </section>
        </div>
      )}

      <UserSkillsPanel open={skillsOpen} onClose={closeSkills} onSaved={notify} demoPrompt={skillDemoPrompt} />
      <RunInspector open={inspectorOpen} run={run} onClose={closeInspector} />
      <div className={`toast liquid-glass ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </main>
  );
}

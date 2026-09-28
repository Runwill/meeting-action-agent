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
  getConnectors,
  getFeishuIntegrationStatus,
  getAgentRun,
  markFeishuRedirectVerified,
  saveFeishuAppConfig,
  saveFeishuSettings,
  searchFeishuTasklists,
  sendAgentCommand,
  sendAgentMessage,
  startFeishuOAuth,
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
  ConnectorsStatus,
  FeishuIntegrationStatus,
  FeishuTasklistOption,
  ModelConfigStatus,
  Priority,
  TaskStatus,
} from "./types";

const VIDEO_SOURCE = "https://stream.mux.com/kimF2ha9zLrX64H00UgLGPflCzNtl1T0215MlAmeOztv8.m3u8";
const RUN_STORAGE_KEY = "meeting-action-agent.run-id";
const FULL_FLOW_TEST_NOTES = `秋季版本协调会，9月20日下午
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

李四：第三阶段飞书这块也要留下验证材料，不能只说接口通了。
张三：这条我负责，请把它作为一条真实飞书任务创建，标题先用“【测试】飞书深化复测记录”，10 月 2 日前交。任务说明里要写清楚五项复测：状态写回、字段写回、清单归类、到期提醒和评论记录，并且最后区分“已实机验证”和“模拟接口已验证”。
王五：创建后不要再拆新任务。我们只围绕这条测试任务做复测：先在本系统把状态改成已完成，看飞书里是否同步完成；再把标题改成“【测试】飞书深化复测记录-已改名”，把截止日期改到 10 月 3 日，看飞书任务详情是否变化。
赵六：清单归类、到期提醒和评论记录也看这条任务详情。它们不是会议纪要临时决定的字段，而是平台连接里提前配置好的能力；如果真实飞书里看不到，就在复测记录里写成“模拟接口已验证，实机配置或权限待补”。
李四：审批时只把这条复测记录写入飞书。前面的故障、回归、公告和采购建议先作为会议行动项保留在系统计划里，不要在这轮一起创建到飞书，方便我们测试“只批准一部分任务”的流程。

王五：下学期会员价格要不要调？
李四：今天先讨论到这儿，这件事没结论，也先不安排人跟进。

最后口头结论：故障修复和登录回归完成并经过人工确认后，再决定是否按原计划灰度。`;

type DemoCase = {
  id: "full_flow";
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
    id: "full_flow",
    label: "完整流程测试纪要",
    caption: "一次测试部分批准、单条飞书写入、状态/字段写回复测、澄清、别名、优先级冲突、依赖风险与非任务讨论",
    notes: FULL_FLOW_TEST_NOTES,
    meetingDate: "2026-09-20",
    instruction: "请结合已启用的用户 Markdown Skill 理解成员别名和优先级规则；从口语对话中还原任务，不要把没有结论的讨论当成行动项；飞书深化复测只应生成一条任务，状态写回、字段写回、清单、提醒和评论属于创建后的验证步骤，不要拆成多条任务。进入审批后，本轮真实飞书写入只勾选“【测试】飞书深化复测记录”这一条；其他行动项用于验证识别、澄清和部分批准，不要一起创建到飞书。",
    hint: "先载入测试 Skill，让模型知道“老张”=张三；审批时只勾选飞书复测任务，其他行动项留作本系统计划样本，用来测试部分批准和非飞书任务留存。",
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
const emptyFeishuStatus: FeishuIntegrationStatus = {
  configured: false,
  enabled: false,
  oauthEnabled: false,
  redirectUri: null,
  appConsoleUrl: null,
  appPermissionUrl: null,
  appConfigSource: "none",
  appIdPreview: null,
  mappedOwnerNames: [],
  advancedSettingsSource: "none",
  tasklistGuid: null,
  tasklistSectionGuid: null,
  tasklistConfigured: false,
  tasklistSectionConfigured: false,
  dueReminderMinutes: [],
  dueReminderCount: 0,
  originUrlConfigured: false,
  syncComments: false,
  tasklistDiscoveryReady: false,
  linkedUsers: [],
};
const emptyConnectorsStatus: ConnectorsStatus = {
  connectors: [{
    id: "local-task",
    name: "Local Task Hub",
    capabilities: { create: true, read: true, updateStatus: true, updateFields: true, statusValues: ["todo", "in_progress", "done"] },
  }],
  feishu: {
    configured: false,
    enabled: false,
    baseURL: null,
    userIdType: null,
    ownerCount: 0,
    appConfigSource: "none",
    appIdPreview: null,
    advancedSettingsSource: "none",
    tasklistGuid: null,
    tasklistSectionGuid: null,
    tasklistConfigured: false,
    tasklistSectionConfigured: false,
    dueReminderMinutes: [],
    dueReminderCount: 0,
    originUrlConfigured: false,
    syncComments: false,
  },
};
const priorityText: Record<Priority, string> = { high: "高", medium: "中", low: "低" };
const statusText: Record<TaskStatus, string> = { todo: "待开始", in_progress: "进行中", done: "已完成" };
const feishuReminderPresets = [
  { label: "不提醒", value: "", helper: "只写入截止日期" },
  { label: "提前 30 分钟", value: "30", helper: "适合当天短会跟进" },
  { label: "提前 2 小时", value: "120", helper: "适合当天交付" },
  { label: "提前 1 天", value: "1440", helper: "适合跨天任务" },
  { label: "1 天 + 30 分钟", value: "1440, 30", helper: "适合重点复测" },
];

function normalizeReminderInput(value: string) {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .join(", ");
}

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

function normalizeOwnerKey(value: string) {
  return value.trim().toLocaleLowerCase();
}

export default function App() {
  const [notes, setNotes] = useState("");
  const [meetingDate, setMeetingDate] = useState("");
  const [instruction, setInstruction] = useState("");
  const [run, setRun] = useState<AgentRun | null>(null);
  const [busy, setBusy] = useState<BusyState>("restore");
  const [runError, setRunError] = useState("");
  const [conversationError, setConversationError] = useState("");
  const [answers, setAnswers] = useState<Record<string, string>>({});
  const [approvalDraft, setApprovalDraft] = useState<ActionTask[]>([]);
  const [selectedTaskIds, setSelectedTaskIds] = useState<string[]>([]);
  const [statusBusyId, setStatusBusyId] = useState<string | null>(null);

  const [configStatus, setConfigStatus] = useState<ModelConfigStatus>(emptyConfig);
  const [connectorsStatus, setConnectorsStatus] = useState<ConnectorsStatus>(emptyConnectorsStatus);
  const [configOpen, setConfigOpen] = useState(false);
  const [feishuStatus, setFeishuStatus] = useState<FeishuIntegrationStatus>(emptyFeishuStatus);
  const [feishuOpen, setFeishuOpen] = useState(false);
  const [feishuAlias, setFeishuAlias] = useState("");
  const [feishuBusy, setFeishuBusy] = useState(false);
  const [feishuError, setFeishuError] = useState("");
  const [feishuCopyMessage, setFeishuCopyMessage] = useState("");
  const [feishuSettingsBusy, setFeishuSettingsBusy] = useState(false);
  const [feishuTasklistBusy, setFeishuTasklistBusy] = useState(false);
  const [feishuTasklistQuery, setFeishuTasklistQuery] = useState("");
  const [feishuTasklistOptions, setFeishuTasklistOptions] = useState<FeishuTasklistOption[]>([]);
  const [feishuTasklistIssue, setFeishuTasklistIssue] = useState<"auth" | "">("");
  const [feishuSettingsForm, setFeishuSettingsForm] = useState({
    tasklistGuid: "",
    tasklistSectionGuid: "",
    dueReminderMinutes: "",
    syncComments: false,
  });
  const [feishuAppForm, setFeishuAppForm] = useState({
    appId: "",
    appSecret: "",
    baseURL: "https://open.feishu.cn",
    userIdType: "open_id" as "open_id" | "union_id" | "user_id",
  });
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
  const feishuPanelRef = useRef<HTMLElement>(null);
  const toastTimer = useRef<number | undefined>(undefined);
  const runGenerationRef = useRef(0);

  useEffect(() => {
    document.documentElement.style.setProperty("--center-shade", String(centerShade));
    localStorage.setItem("meeting-action-agent.center-shade", String(centerShade));
  }, [centerShade]);

  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const closeFeishu = useCallback(() => setFeishuOpen(false), []);
  const closeSkills = useCallback(() => { setSkillsOpen(false); setSkillDemoPrompt(false); }, []);
  const closeInspector = useCallback(() => setInspectorOpen(false), []);
  useDialogFocus(configOpen, configPanelRef, closeConfig);
  useDialogFocus(feishuOpen, feishuPanelRef, closeFeishu);

  const notify = useCallback((message: string) => {
    setToast(message);
    clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(""), 2800);
  }, []);

  const adoptRun = useCallback((next: AgentRun, restoreInput = false, expectedGeneration?: number) => {
    if (expectedGeneration !== undefined && expectedGeneration !== runGenerationRef.current) return false;
    setRun(next);
    setRunError("");
    setConversationError("");
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

  const refreshConnectorsStatus = useCallback(async () => {
    try {
      setConnectorsStatus(await getConnectors());
    } catch {
      setConnectorsStatus(emptyConnectorsStatus);
    }
  }, []);

  useEffect(() => {
    void refreshConnectorsStatus();
  }, [refreshConnectorsStatus]);

  const refreshFeishuStatus = useCallback(async () => {
    try {
      const nextStatus = await getFeishuIntegrationStatus();
      setFeishuStatus(nextStatus);
      setFeishuSettingsForm({
        tasklistGuid: nextStatus.tasklistGuid || "",
        tasklistSectionGuid: nextStatus.tasklistSectionGuid || "",
        dueReminderMinutes: nextStatus.dueReminderMinutes.join(", "),
        syncComments: nextStatus.syncComments,
      });
      setFeishuError("");
      setFeishuCopyMessage("");
    } catch (error) {
      setFeishuStatus(emptyFeishuStatus);
      setFeishuError(errorMessage(error, "暂时无法读取飞书身份绑定状态。"));
    }
  }, []);

  useEffect(() => {
    if (feishuOpen) {
      void refreshFeishuStatus();
      void refreshConnectorsStatus();
    }
  }, [feishuOpen, refreshConnectorsStatus, refreshFeishuStatus]);

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
    if (pageRef.current) pageRef.current.inert = configOpen || feishuOpen || skillsOpen || inspectorOpen;
  }, [configOpen, feishuOpen, skillsOpen, inspectorOpen]);

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
  const activeConnector = connectorsStatus.connectors.find((connector) => connector.id === run?.connector_id);
  const connectorName = run?.created_tasks[0]?.connector_name || activeConnector?.name || (run?.connector_id === "feishu" ? "飞书任务" : "Local Task Hub");
  const statusOptions = activeConnector?.capabilities.statusValues?.length
    ? activeConnector.capabilities.statusValues
    : run?.connector_id === "feishu"
      ? (["in_progress", "done"] as TaskStatus[])
      : (["todo", "in_progress", "done"] as TaskStatus[]);
  const supportsStatusUpdate = !!activeConnector?.capabilities.updateStatus;
  const feishuCanBind = feishuStatus.configured && feishuStatus.oauthEnabled;
  const feishuSetupHint = feishuCanBind
    ? "管理员已完成飞书应用配置，成员只需在这里绑定自己的飞书身份。"
    : feishuStatus.configured
      ? "飞书应用凭据已配置，但身份授权回调还没就绪，请部署人员补充回调地址。"
    : "当前还没有保存飞书应用凭据。请先在本平台填写 App ID 和 App Secret。";
  const feishuStatusTitle = feishuCanBind
    ? "飞书任务身份绑定可用"
    : feishuStatus.configured
      ? "飞书任务已接入，成员绑定待部署核验"
      : "尚未配置飞书任务";
  const feishuStatusDetail = feishuCanBind
    ? `${feishuStatus.linkedUsers.length} 个成员身份已绑定`
    : feishuStatus.configured
      ? "创建和回读可用；OAuth 回调核验后再开放成员绑定"
      : "需要部署人员配置 App ID、App Secret 和回调地址";
  const hasFeishuCommentPermissionIssue = !!run?.created_tasks.some((task) =>
    task.connector_id === "feishu" && task.issues.some((issue) => /飞书评论同步失败|task:comment:write|task:comment:read/i.test(issue)),
  );
  const feishuFeatureBadges = [
    { label: "创建 / 回读", value: feishuStatus.configured ? "已接入" : "待配置", active: feishuStatus.configured },
    { label: "状态 / 字段写回", value: feishuStatus.configured ? "已接入" : "待配置", active: feishuStatus.configured },
    { label: "来源标记", value: feishuStatus.configured ? (feishuStatus.originUrlConfigured ? "带系统链接" : "已标记") : "待配置", active: feishuStatus.configured },
    { label: "飞书清单", value: feishuStatus.tasklistConfigured ? (feishuStatus.tasklistSectionConfigured ? "指定分组" : "指定清单") : "未指定", active: feishuStatus.tasklistConfigured },
    { label: "新建任务提醒", value: feishuStatus.dueReminderCount ? `${feishuStatus.dueReminderCount} 个规则` : "未启用", active: feishuStatus.dueReminderCount > 0 },
    { label: "任务评论", value: hasFeishuCommentPermissionIssue ? "权限待配置" : feishuStatus.syncComments ? "开关已启用" : "未启用", active: feishuStatus.syncComments && !hasFeishuCommentPermissionIssue },
  ];
  const feishuSecurityUrl = feishuStatus.appConsoleUrl || "https://open.feishu.cn/app";
  const feishuPermissionUrl = feishuStatus.appPermissionUrl || (feishuStatus.appConsoleUrl
    ? feishuStatus.appConsoleUrl.replace(/\/safe(?=$|[?#])/, "/auth")
    : "https://open.feishu.cn/app");
  const feishuTasklistPermissionGuide = "飞书任务清单读取失败时，请在飞书开放平台进入当前应用的“权限管理”，搜索并开通任务/任务清单读取相关权限，保存并发布应用后，回到会议行动智能体重新绑定一次飞书成员，再重新读取清单。";
  const feishuCommentPermissionGuide = "飞书评论同步失败时，请在飞书开放平台进入当前应用的“权限管理”，搜索并开通 task:comment:write；如果还要读取评论做核验，再开通 task:comment:read。保存并发布应用后，回到会议行动智能体重新检查连接，并用测试任务再次触发状态或字段写回。";
  const feishuAppListUrl = "https://open.feishu.cn/app";
  const feishuEnvReturnUrl = `${window.location.origin}${window.location.pathname || "/"}#workflow`;
  const feishuEnvTemplate = [
    "# .env（保存在项目根目录，不要提交 Git）",
    "MEETING_AGENT_CONNECTOR=feishu",
    "FEISHU_APP_ID=在飞书开放平台复制的 App ID",
    "FEISHU_APP_SECRET=在飞书开放平台复制的 App Secret",
    "FEISHU_BASE_URL=https://open.feishu.cn",
    "FEISHU_USER_ID_TYPE=open_id",
    "FEISHU_OAUTH_REDIRECT_URI=http://localhost:8788/api/integrations/feishu/oauth/callback",
    `FEISHU_OAUTH_RETURN_URL=${feishuEnvReturnUrl}`,
  ].join("\n");
  const feishuAdvancedItems: Array<{
    label: string;
    status: string;
    active: boolean;
    availability: string;
    summary: string;
    impact: string;
    details: string[];
    copyLabel: string;
    copyText: string;
  }> = [
    {
      label: "任务清单归类",
      status: feishuStatus.tasklistConfigured ? (feishuStatus.tasklistSectionConfigured ? "已放入指定分组" : "已放入指定清单") : "未配置",
      active: feishuStatus.tasklistConfigured,
      availability: feishuStatus.tasklistConfigured ? "已保存默认清单" : "可在上方选择清单位置",
      summary: feishuStatus.tasklistConfigured
        ? "审批后创建的任务会进入已保存的飞书清单，便于把演示任务集中查看。"
        : "如果你已经在飞书任务里建好清单，可以在上方粘贴清单链接；保存后，新创建的任务会自动归入该清单。",
      impact: feishuStatus.tasklistConfigured
        ? "可用完整流程测试纪要创建任务，再到飞书任务详情确认清单归类是否生效。"
        : "未填写时不影响飞书任务创建、回读、状态写回和字段写回；清单归类这一项先记录为“未配置”。",
      details: feishuStatus.tasklistConfigured
        ? ["用完整流程测试纪要创建一条飞书任务。", "打开飞书任务详情，确认任务进入指定清单或分组。"]
        : ["先在飞书任务里准备清单。", "复制清单或分组页面链接。", "粘贴到上方“飞书清单 / 清单分组”并保存。"],
      copyLabel: "复制说明",
      copyText: "请在会议行动智能体的“平台连接 → 飞书任务写入设置”中配置清单归类：先在飞书任务中准备一个用于演示或项目同步的清单，可选分组；再粘贴清单或分组链接。系统会尝试从链接中识别清单 / 分组值，识别失败时可用高级 ID 兜底。",
    },
    {
      label: "新建任务提醒",
      status: feishuStatus.dueReminderCount ? `已配置 ${feishuStatus.dueReminderCount} 条提醒规则` : "未启用",
      active: feishuStatus.dueReminderCount > 0,
      availability: feishuStatus.dueReminderCount ? "已保存写入提醒" : "可在上方选择创建任务时的提醒时间",
      summary: feishuStatus.dueReminderCount
        ? "会议任务带截止日期时，由本系统新创建到飞书的任务会自动带上这里配置的提醒。"
        : "在上方选择提醒时间后，带截止日期的任务由本系统创建到飞书时会自动附带提醒。",
      impact: feishuStatus.dueReminderCount
        ? "可以用当前完整流程测试纪要创建带截止日期的任务，再到飞书任务详情里查看提醒。"
        : "未填写时不影响任务截止日期写入；新建任务提醒这一项先记录为“未启用”。",
      details: feishuStatus.dueReminderCount
        ? ["创建带截止日期的飞书任务。", "打开飞书任务详情，检查提醒是否随任务一起生成。"]
        : ["选择“提前 1 天”等常用提醒。", "需要多条提醒时使用自定义分钟兜底。", "保存后创建新的带截止日期任务验证。"],
      copyLabel: "复制说明",
      copyText: "请在会议行动智能体的“平台连接 → 飞书任务写入设置”中配置新建任务提醒：直接选择提前 30 分钟、提前 2 小时或提前 1 天；如需多条提醒，可在自定义分钟中填写，例如 1440, 30。配置后，本系统把会议纪要中带截止日期的任务创建到飞书时会自动附带这些提醒；这不是飞书客户端/账号里的任务默认提醒设置。",
    },
    {
      label: "评论记录",
      status: hasFeishuCommentPermissionIssue ? "权限待配置" : feishuStatus.syncComments ? "已启用" : "未启用",
      active: feishuStatus.syncComments && !hasFeishuCommentPermissionIssue,
      availability: hasFeishuCommentPermissionIssue ? "需要开通飞书评论权限" : feishuStatus.syncComments ? "同步开关已开启" : "可在上方开启操作记录",
      summary: feishuStatus.syncComments
        ? hasFeishuCommentPermissionIssue
          ? "开关已经开启，但最近一次实机写入提示飞书应用缺少评论权限，所以评论记录没有真正写入。"
          : "Agent 创建任务、同步状态或修改字段时，会尝试在飞书任务评论里留下操作记录。"
        : "打开上方操作记录开关后，系统会尝试把创建、状态同步和字段修改写入飞书任务评论。",
      impact: feishuStatus.syncComments
        ? hasFeishuCommentPermissionIssue
          ? "先在飞书开放平台补齐评论权限并发布应用，再回到本系统重新触发一次状态或字段写回。"
          : "创建任务后，再从本系统修改状态或字段，飞书任务评论区应出现对应记录。"
        : "如果飞书应用没有评论权限，主任务创建、状态写回和字段写回仍应成功；评论这一项记录权限结果。",
      details: hasFeishuCommentPermissionIssue
        ? ["打开飞书开放平台当前应用的权限管理。", "搜索并开通 task:comment:write；需要回读核验评论时再开通 task:comment:read。", "保存并发布应用后，回到本系统重新检查连接，再用测试任务复测评论同步。"]
        : feishuStatus.syncComments
        ? ["创建一条飞书任务。", "从本系统把状态改为已完成，或修改标题 / 截止日期。", "打开飞书任务评论区，检查是否出现 Agent 操作记录。"]
        : ["在上方打开评论记录开关并保存。", "确认飞书应用具备任务评论权限。", "如果权限不足，系统会保留主任务写入结果。"],
      copyLabel: "复制说明",
      copyText: hasFeishuCommentPermissionIssue ? feishuCommentPermissionGuide : "请在会议行动智能体的“平台连接 → 飞书任务写入设置”中开启操作记录。飞书应用仍需要具备任务评论相关权限，并发布到当前测试企业；开启后，Agent 创建任务、同步状态和修改字段时，会在飞书任务评论区留下简短记录。评论权限不足时，不应阻断主任务创建、字段写回和回读验证。",
    },
  ];
  const feishuAdvancedReadyCount = feishuAdvancedItems.filter((item) => item.active).length;
  const feishuSettingsSourceLabel = feishuStatus.advancedSettingsSource === "persistent"
    ? "页面保存"
    : feishuStatus.advancedSettingsSource === "environment"
      ? ".env / 环境变量"
      : "未配置";
  const feishuGuideStep = !feishuStatus.configured ? 1 : !feishuStatus.oauthEnabled ? 2 : feishuStatus.linkedUsers.length === 0 ? 3 : 4;
  const feishuGuideTitle = feishuGuideStep === 1
    ? "先完成飞书应用凭据配置"
    : feishuGuideStep === 2
      ? "现在需要登记并核验回调地址"
      : feishuGuideStep === 3
        ? "现在可以绑定成员身份"
        : "可以回到会议审批并写入飞书";
  const feishuGuideBody = feishuGuideStep === 1
    ? "在飞书开放平台进入你创建的应用，复制 App ID 和 App Secret，然后回到本平台填写并保存。Base URL、用户 ID 类型和任务平台启用会自动使用推荐值。"
    : feishuGuideStep === 2
      ? "本系统可以复制回调地址并打开当前飞书应用的安全设置页；在飞书里粘贴保存后，回到这里点“我已在飞书保存”。"
      : feishuGuideStep === 3
        ? "成员在下方填写系统里的姓名或别名，例如张三、老张，然后点击绑定当前飞书用户；飞书确认后会返回本系统。"
        : "成员身份已可用于负责人映射。回到首页放入会议纪要，完成 Agent 分析和人工审批后即可创建飞书任务。";
  const guideStepClass = (step: number) => step < feishuGuideStep ? "done" : step === feishuGuideStep ? "current" : "locked";
  const feishuKnownOwnerKeys = useMemo(() => new Set(
    [
      ...feishuStatus.mappedOwnerNames,
      ...feishuStatus.linkedUsers.flatMap((user) => [user.name, ...user.aliases]),
    ].map(normalizeOwnerKey).filter(Boolean),
  ), [feishuStatus.linkedUsers, feishuStatus.mappedOwnerNames]);
  const feishuApprovalBlockReasons = useMemo(() => {
    if (run?.connector_id !== "feishu") return {};
    return Object.fromEntries(approvalDraft.flatMap((task) => {
      const owner = task.owner?.trim();
      if (!owner || feishuKnownOwnerKeys.has(normalizeOwnerKey(owner))) return [];
      return [[task.id, `飞书还没有负责人“${owner}”的身份映射。请先在平台连接中让该成员绑定，或取消勾选此任务。`]];
    }));
  }, [approvalDraft, feishuKnownOwnerKeys, run?.connector_id]);
  const selectedFeishuMissingOwners = useMemo(() => {
    const selected = new Set(selectedTaskIds);
    return [...new Set(approvalDraft
      .filter((task) => selected.has(task.id) && feishuApprovalBlockReasons[task.id])
      .map((task) => task.owner?.trim())
      .filter((owner): owner is string => !!owner))];
  }, [approvalDraft, feishuApprovalBlockReasons, selectedTaskIds]);
  const feishuApprovalBlockMessage = selectedFeishuMissingOwners.length
    ? `飞书写入前需要先绑定负责人：${selectedFeishuMissingOwners.join("、")}。绑定完成后回到审批页重新检查，再批准创建。`
    : undefined;
  const keepFeishuCreatableOnly = useCallback(() => {
    setSelectedTaskIds((current) => current.filter((taskId) => !feishuApprovalBlockReasons[taskId]));
  }, [feishuApprovalBlockReasons]);

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

  async function beginFeishuBinding() {
    if (!feishuCanBind) {
      setFeishuError("当前还不能发起飞书授权。请先按第 2 步在飞书开放平台登记回调地址，并由部署人员标记已核验。");
      return;
    }
    setFeishuBusy(true);
    setFeishuError("");
    try {
      const { authorizeUrl } = await startFeishuOAuth(feishuAlias);
      window.location.href = authorizeUrl;
    } catch (error) {
      setFeishuError(errorMessage(error, "暂时无法发起飞书授权。"));
    } finally {
      setFeishuBusy(false);
    }
  }

  async function copyFeishuRedirectUri() {
    if (!feishuStatus.redirectUri) {
      setFeishuCopyMessage("当前还没有可复制的回调地址。");
      return;
    }
    try {
      await navigator.clipboard.writeText(feishuStatus.redirectUri);
      setFeishuCopyMessage("已复制回调地址，粘贴到飞书开放平台的重定向 URL 设置中。");
      notify("已复制回调地址");
    } catch {
      setFeishuCopyMessage("复制失败，请手动选中下方地址复制。");
    }
  }

  async function prepareFeishuRedirectSetup() {
    if (!feishuStatus.redirectUri) {
      setFeishuCopyMessage("当前还没有可复制的回调地址。");
      return;
    }
    try {
      await navigator.clipboard.writeText(feishuStatus.redirectUri);
      setFeishuCopyMessage("已复制回调地址，并打开飞书当前应用的安全设置页。请在重定向 URL / OAuth 回调地址处粘贴保存。");
      notify("已复制并打开飞书后台");
    } catch {
      setFeishuCopyMessage("已打开飞书当前应用的安全设置页，但复制失败；请手动选中下方地址复制后粘贴。");
    }
  }

  async function copyFeishuOptionalSetup(text: string, label: string) {
    try {
      await navigator.clipboard.writeText(text);
      setFeishuCopyMessage(`已复制${label}说明。`);
      notify("已复制配置说明");
    } catch {
      setFeishuCopyMessage("复制失败，请手动选中说明文字复制。");
    }
  }

  async function copyFeishuEnvTemplate() {
    try {
      await navigator.clipboard.writeText(feishuEnvTemplate);
      setFeishuCopyMessage("已复制高级部署模板。普通本地演示优先使用上方表单保存，不需要手动编辑 .env。");
      notify("已复制飞书配置模板");
    } catch {
      setFeishuCopyMessage("复制失败，请手动复制下方 .env 模板。");
    }
  }

  function updateFeishuAppForm(field: keyof typeof feishuAppForm, value: string) {
    setFeishuAppForm((current) => ({ ...current, [field]: value }));
    setFeishuError("");
    setFeishuCopyMessage("");
  }

  async function saveFeishuCredentials() {
    const appId = feishuAppForm.appId.trim();
    const appSecret = feishuAppForm.appSecret.trim();
    if (!appId || !appSecret) {
      setFeishuError("请填写飞书开放平台里的 App ID 和 App Secret。");
      return;
    }
    setFeishuBusy(true);
    setFeishuError("");
    setFeishuCopyMessage("");
    try {
      const nextStatus = await saveFeishuAppConfig({
        appId,
        appSecret,
        baseURL: feishuAppForm.baseURL.trim() || "https://open.feishu.cn",
        userIdType: feishuAppForm.userIdType,
        enabled: true,
      });
      setFeishuStatus(nextStatus);
      setFeishuAppForm((current) => ({ ...current, appSecret: "" }));
      await refreshConnectorsStatus();
      setFeishuCopyMessage("飞书应用凭据已保存到本机后端，App Secret 不会回显。现在可以继续第 2 步登记回调地址。");
      notify("飞书应用凭据已保存");
    } catch (error) {
      setFeishuError(errorMessage(error, "飞书应用凭据暂时无法保存。"));
    } finally {
      setFeishuBusy(false);
    }
  }

  function updateFeishuSettingsForm(field: keyof typeof feishuSettingsForm, value: string | boolean) {
    setFeishuSettingsForm((current) => ({ ...current, [field]: value }));
    setFeishuError("");
    setFeishuCopyMessage("");
  }

  async function readFeishuTasklists() {
    const query = feishuTasklistQuery.trim();
    if (!query) {
      setFeishuError("请先输入飞书清单名称关键词，再读取清单。");
      setFeishuTasklistIssue("");
      return;
    }
    if (!feishuCanBind) {
      setFeishuError("读取飞书清单前，需要先完成飞书应用配置和成员授权绑定。");
      setFeishuTasklistIssue("auth");
      return;
    }
    setFeishuTasklistBusy(true);
    setFeishuError("");
    setFeishuCopyMessage("");
    try {
      const result = await searchFeishuTasklists(query);
      setFeishuTasklistOptions(result.items);
      setFeishuTasklistIssue("");
      setFeishuCopyMessage(result.items.length
        ? `已读取 ${result.items.length} 个飞书清单，授权用户：${result.tokenUserName}。请选择一个清单。`
        : `没有找到名称包含“${result.query}”的飞书清单，可换关键词或粘贴清单链接。`);
    } catch (error) {
      const message = errorMessage(error, "飞书清单暂时无法读取，可先粘贴清单链接或 ID。");
      setFeishuTasklistOptions([]);
      setFeishuTasklistIssue(/任务清单读取权限|临时用户授权|重新绑定|授权任务清单读取|缺少任务清单/i.test(message) ? "auth" : "");
      setFeishuError(message);
    } finally {
      setFeishuTasklistBusy(false);
    }
  }

  function chooseFeishuTasklist(option: FeishuTasklistOption) {
    setFeishuSettingsForm((current) => ({ ...current, tasklistGuid: option.id, tasklistSectionGuid: "" }));
    setFeishuCopyMessage(`已选择清单“${option.name}”。如需分组，请继续选择下方分组后保存。`);
    setFeishuError("");
  }

  function chooseFeishuTasklistSection(option: FeishuTasklistOption, sectionId: string, sectionName: string) {
    setFeishuSettingsForm((current) => ({ ...current, tasklistGuid: option.id, tasklistSectionGuid: sectionId }));
    setFeishuCopyMessage(`已选择清单“${option.name}” / 分组“${sectionName}”，保存后新任务会写入这里。`);
    setFeishuError("");
  }

  async function saveFeishuAdvancedSettings() {
    if (!feishuStatus.configured) {
      setFeishuError("请先完成飞书应用 App ID 和 App Secret 配置，再保存飞书任务写入设置。");
      return;
    }
    const tasklistGuid = feishuSettingsForm.tasklistGuid.trim();
    const tasklistSectionGuid = feishuSettingsForm.tasklistSectionGuid.trim();
    if (tasklistSectionGuid && !tasklistGuid) {
      setFeishuError("指定清单分组前，需要先填写或粘贴飞书清单。");
      return;
    }
    setFeishuSettingsBusy(true);
    setFeishuError("");
    try {
      const nextStatus = await saveFeishuSettings({
        tasklistGuid: tasklistGuid || null,
        tasklistSectionGuid: tasklistSectionGuid || null,
        dueReminderMinutes: feishuSettingsForm.dueReminderMinutes,
        syncComments: feishuSettingsForm.syncComments,
      });
      setFeishuStatus(nextStatus);
      setFeishuSettingsForm({
        tasklistGuid: nextStatus.tasklistGuid || "",
        tasklistSectionGuid: nextStatus.tasklistSectionGuid || "",
        dueReminderMinutes: nextStatus.dueReminderMinutes.join(", "),
        syncComments: nextStatus.syncComments,
      });
      await refreshConnectorsStatus();
      setFeishuCopyMessage("飞书任务写入设置已保存到本机；之后创建的新飞书任务会使用这些设置。");
      notify("飞书写入设置已保存");
    } catch (error) {
      setFeishuError(errorMessage(error, "飞书任务写入设置暂时无法保存。"));
    } finally {
      setFeishuSettingsBusy(false);
    }
  }

  async function confirmFeishuRedirectSaved() {
    if (!feishuStatus.configured || !feishuStatus.redirectUri) {
      setFeishuError("当前还没有可核验的飞书回调地址。请先完成飞书应用配置。");
      return;
    }
    setFeishuBusy(true);
    setFeishuError("");
    try {
      const nextStatus = await markFeishuRedirectVerified();
      setFeishuStatus(nextStatus);
      void refreshConnectorsStatus();
      setFeishuCopyMessage("");
      notify("飞书回调地址已核验");
    } catch (error) {
      setFeishuError(errorMessage(error, "飞书回调地址状态暂时无法保存。"));
    } finally {
      setFeishuBusy(false);
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
      void refreshConnectorsStatus();
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
    setConversationError("");
    try {
      const next = await sendAgentMessage(run.id, content);
      const adopted = adoptRun(next, false, generation);
      if (adopted) setConversationError("");
      return adopted;
    } catch (error) {
      if (generation === runGenerationRef.current) {
        const message = errorMessage(error, "消息没有发送成功。");
        setRunError(message);
        setConversationError(message);
      }
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
      if (approved && actionType === "update_feishu_settings") {
        await refreshFeishuStatus();
        await refreshConnectorsStatus();
      }
      notify(approved
        ? actionType === "edit_task"
          ? "任务信息已更新"
          : actionType === "update_feishu_settings"
            ? "飞书写入设置已更新"
            : "状态已更新"
        : "操作已取消");
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
    setConversationError("");
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
              <button className="model-trigger" type="button" onClick={() => setFeishuOpen(true)} aria-label="打开平台连接"><span className="engine-label"><i className={feishuStatus.configured ? "ai" : "unconfigured"} />平台连接</span></button>
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
              <button type="button" onClick={() => { menuButtonRef.current?.focus(); setFeishuOpen(true); setMenuOpen(false); }}>平台连接</button>
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
                <p className="demo-caption">一个样本覆盖主要验收点：真实对话式纪要、部分批准、单条飞书写入、澄清、别名、优先级、依赖风险和非任务讨论。</p>
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
                  <AgentConversation run={run} busy={busy !== null || statusBusyId !== null} error={conversationError} onSend={submitMessage} onConfirm={(actionId, approved) => void confirmPendingAction(actionId, approved)} />

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
                      connectorName={connectorName}
                      taskBlockReasons={feishuApprovalBlockReasons}
                      approvalBlockMessage={feishuApprovalBlockMessage}
                      onTasksChange={setApprovalDraft}
                      onSelectionChange={setSelectedTaskIds}
                      onApprove={() => void approveTasks()}
                      onResolveApprovalBlock={() => setFeishuOpen(true)}
                      onKeepCreatableOnly={keepFeishuCreatableOnly}
                    />
                  )}

                  {(run.state === "tracking" || run.state === "completed" || (run.state === "failed" && run.created_tasks.length > 0)) && (
                    <TrackingPanel
                      state={run.state}
                      tasks={run.created_tasks}
                      tracking={run.tracking}
                      busy={busy !== null || statusBusyId !== null || !!run.pending_action}
                      refreshing={busy === "track"}
                      connectorName={connectorName}
                      supportsStatusUpdate={supportsStatusUpdate}
                      statusOptions={statusOptions}
                      statusBusyId={statusBusyId}
                      onRefresh={() => void refreshTracking()}
                      onStatusChange={(externalId, status) => void changeTaskStatus(externalId, status)}
                      onOpenPlatformConnection={() => setFeishuOpen(true)}
                      feishuPermissionUrl={run.connector_id === "feishu" ? feishuPermissionUrl : undefined}
                    />
                  )}

                  {run.state === "failed" && (
                    <section className="outcome-panel is-failed" role="alert" aria-labelledby="failed-title">
                      <WarningCircle weight="fill" />
                      <div><h3 id="failed-title">本次执行或验证未完成</h3><p>成功步骤已保留。请查看执行与回读记录，并使用原批准范围安全重试，已有任务会按幂等键复用。</p></div>
                      <div className="outcome-actions">
                        {run.connector_id === "feishu" && <button type="button" onClick={() => setFeishuOpen(true)}>打开平台连接</button>}
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
                  <ExecutionLog events={run.events} live={isExecutionActive} connectorName={connectorName} />
                </aside>
              </div>
            )}
          </div>
        </section>

        <footer className="site-footer"><span>会议行动智能体 / {connectorName}</span><span>先确认，再执行。<ArrowUpRight /></span></footer>
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

      {feishuOpen && (
        <div className="config-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) closeFeishu(); }}>
          <section ref={feishuPanelRef} className="config-panel platform-panel liquid-glass" role="dialog" aria-modal="true" aria-labelledby="feishu-title" aria-describedby="feishu-description">
            <header className="config-head platform-panel-head"><div><p>PLATFORM CONNECTIONS</p><h2 id="feishu-title">连接办公<em>平台。</em></h2></div><button type="button" onClick={closeFeishu} aria-label="关闭平台连接" title="关闭"><X /></button></header>
            <div className="platform-panel-body">
            <p className="secret-note platform-intro" id="feishu-description"><Key /> 这里统一管理真实任务平台。当前先接入飞书任务，后续 Trello、Todoist 等平台也应放在这里，不再占用头栏入口。</p>
            <div className="integration-card">
              <header className="integration-card-head"><div><span>飞书任务</span><small>用于把审批后的行动项写入飞书任务，并按 GUID 回读验证。</small></div><strong>{feishuStatus.enabled ? "当前默认" : feishuStatus.configured ? "已配置" : "未配置"}</strong></header>
              <div className={`config-status ${feishuCanBind ? "connected" : ""}`}><i /><div><span>{feishuStatusTitle}</span><small>{feishuStatusDetail}</small></div></div>
              <div className="feishu-feature-grid" aria-label="飞书接入能力">
                {feishuFeatureBadges.map((feature) => (
                  <div className={feature.active ? "is-active" : ""} key={feature.label}>
                    <span>{feature.label}</span>
                    <strong>{feature.value}</strong>
                  </div>
                ))}
              </div>
              <section className="feishu-optional-setup" aria-label="飞书任务写入设置">
                <header>
                  <div>
                    <span>飞书任务写入设置</span>
                    <p>这里决定 Agent 创建新飞书任务时默认放到哪里、提前多久提醒，以及是否把操作记录写入任务评论。</p>
                  </div>
                  <strong>{feishuAdvancedReadyCount} / {feishuAdvancedItems.length} 已启用 · {feishuSettingsSourceLabel}</strong>
                </header>
                <div className="feishu-settings-form" aria-label="飞书任务写入设置表单">
                  <label className="feishu-setting-card">
                    <span>飞书清单</span>
                    <div className="feishu-tasklist-search">
                      <input
                        value={feishuTasklistQuery}
                        onChange={(event) => setFeishuTasklistQuery(event.target.value)}
                        placeholder={feishuStatus.tasklistDiscoveryReady ? "输入清单名称关键词" : "输入关键词；如过期请重新绑定成员"}
                        disabled={feishuTasklistBusy || !feishuCanBind}
                      />
                      <button
                        type="button"
                        onClick={() => void readFeishuTasklists()}
                        disabled={feishuTasklistBusy || !feishuCanBind}
                      >
                        {feishuTasklistBusy ? "读取中…" : "读取清单"}
                      </button>
                    </div>
                    {feishuTasklistIssue === "auth" && (
                      <div className="feishu-tasklist-help" role="status" aria-live="polite">
                        <div>
                          <WarningCircle />
                          <div>
                            <strong>需要先补飞书权限，然后重新授权</strong>
                            <p>这不是清单名称输错，而是当前飞书应用或当前成员还没有给“读取任务清单”的权限。</p>
                          </div>
                        </div>
                        <ol>
                          <li>打开飞书开放平台当前应用的“权限管理”。</li>
                          <li>搜索并开通任务 / 任务清单读取相关权限，保存并发布应用。</li>
                          <li>回到这里点击“重新绑定飞书成员”，授权完成后再点“读取清单”。</li>
                        </ol>
                        <div className="tasklist-help-actions">
                          <a href={feishuPermissionUrl} target="_blank" rel="noreferrer">
                            打开权限管理 <ArrowUpRight />
                          </a>
                          <button type="button" onClick={() => void beginFeishuBinding()} disabled={feishuBusy || !feishuCanBind}>
                            重新绑定飞书成员
                          </button>
                          <button type="button" onClick={() => void copyFeishuOptionalSetup(feishuTasklistPermissionGuide, "清单读取权限")}>
                            复制给管理员
                          </button>
                        </div>
                        <small>如果暂时不处理权限，也可以继续在下面粘贴飞书清单链接或清单 ID。</small>
                      </div>
                    )}
                    {feishuTasklistOptions.length > 0 && (
                      <div className="feishu-tasklist-options" aria-label="可选择的飞书清单">
                        {feishuTasklistOptions.map((option) => (
                          <article className={feishuSettingsForm.tasklistGuid === option.id ? "is-selected" : ""} key={option.id}>
                            <button type="button" onClick={() => chooseFeishuTasklist(option)}>
                              <strong>{option.name}</strong>
                              <small>{option.id}</small>
                            </button>
                            {option.sections.length > 0 && (
                              <div>
                                {option.sections.map((section) => (
                                  <button
                                    type="button"
                                    className={feishuSettingsForm.tasklistGuid === option.id && feishuSettingsForm.tasklistSectionGuid === section.id ? "is-selected" : ""}
                                    key={section.id}
                                    onClick={() => chooseFeishuTasklistSection(option, section.id, section.name)}
                                  >
                                    {section.name}
                                  </button>
                                ))}
                              </div>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                    <input
                      value={feishuSettingsForm.tasklistGuid}
                      onChange={(event) => updateFeishuSettingsForm("tasklistGuid", event.target.value)}
                      placeholder="粘贴清单链接，或填写清单 ID"
                      disabled={feishuSettingsBusy || !feishuStatus.configured}
                    />
                    <small>先输入清单名称关键词，再点“读取清单”。服务重启或授权过期后可能需要重新绑定飞书成员；读取失败时仍可粘贴清单链接或 ID。</small>
                  </label>
                  <label className="feishu-setting-card">
                    <span>清单分组（可选）</span>
                    <input
                      value={feishuSettingsForm.tasklistSectionGuid}
                      onChange={(event) => updateFeishuSettingsForm("tasklistSectionGuid", event.target.value)}
                      placeholder="粘贴分组链接，或填写分组 ID"
                      disabled={feishuSettingsBusy || !feishuStatus.configured}
                    />
                    <small>对应清单里的分组 / 区域。只有指定飞书清单后才生效；不分组可留空。</small>
                  </label>
                  <div className="feishu-setting-card feishu-reminder-field">
                    <span>新建任务提醒</span>
                    <div className="feishu-reminder-presets" role="group" aria-label="新建飞书任务提醒">
                      {feishuReminderPresets.map((preset) => {
                        const active = normalizeReminderInput(feishuSettingsForm.dueReminderMinutes) === preset.value;
                        return (
                          <button
                            type="button"
                            key={preset.label}
                            className={active ? "is-active" : ""}
                            onClick={() => updateFeishuSettingsForm("dueReminderMinutes", preset.value)}
                            disabled={feishuSettingsBusy || !feishuStatus.configured}
                            aria-pressed={active}
                          >
                            <strong>{preset.label}</strong>
                            <small>{preset.helper}</small>
                          </button>
                        );
                      })}
                    </div>
                    <label className="feishu-custom-reminder">
                      <span>自定义提醒分钟（可选）</span>
                      <input
                        value={feishuSettingsForm.dueReminderMinutes}
                        onChange={(event) => updateFeishuSettingsForm("dueReminderMinutes", event.target.value)}
                        placeholder="例如 1440, 30"
                        disabled={feishuSettingsBusy || !feishuStatus.configured}
                      />
                    </label>
                    <small>只影响本系统之后创建到飞书的任务，不会修改飞书客户端/账号里的任务默认提醒时间。多条提醒用英文逗号分隔；1440 表示提前 1 天。</small>
                  </div>
                  <label className="feishu-setting-card feishu-toggle-field">
                    <span>操作记录写入评论</span>
                    <button
                      type="button"
                      className={feishuSettingsForm.syncComments ? "is-on" : ""}
                      onClick={() => updateFeishuSettingsForm("syncComments", !feishuSettingsForm.syncComments)}
                      disabled={feishuSettingsBusy || !feishuStatus.configured}
                      aria-pressed={feishuSettingsForm.syncComments}
                    >
                      {feishuSettingsForm.syncComments ? "已启用" : "未启用"}
                    </button>
                    <small>对应飞书任务详情里的评论 / 动态。启用后，创建、状态同步和字段修改会尝试留下记录；权限不足时不阻断主写入。</small>
                  </label>
                  {(hasFeishuCommentPermissionIssue || feishuSettingsForm.syncComments) && (
                    <div className={hasFeishuCommentPermissionIssue ? "feishu-permission-callout is-warning" : "feishu-permission-callout"} role={hasFeishuCommentPermissionIssue ? "alert" : "note"}>
                      <div>
                        <WarningCircle />
                        <div>
                          <strong>{hasFeishuCommentPermissionIssue ? "评论同步缺少飞书权限" : "评论同步还需要飞书应用权限"}</strong>
                          <p>{hasFeishuCommentPermissionIssue
                            ? "本系统已经保留主任务写入结果，但飞书拒绝写入评论。需要在飞书开放平台给当前应用补权限。"
                            : "开关只代表本系统会尝试写入评论；真实飞书是否能写入，仍取决于当前应用是否开通评论权限并发布。"}</p>
                        </div>
                      </div>
                      <ol>
                        <li>打开飞书开放平台当前应用的“权限管理”。</li>
                        <li>搜索并开通 <code>task:comment:write</code>；如需读取评论核验，再开通 <code>task:comment:read</code>。</li>
                        <li>保存并发布应用后，回到本系统重新检查连接，再用测试任务复测状态或字段写回。</li>
                      </ol>
                      <div className="tasklist-help-actions">
                        <a href={feishuPermissionUrl} target="_blank" rel="noreferrer">
                          打开权限管理 <ArrowUpRight />
                        </a>
                        <button type="button" onClick={() => void copyFeishuOptionalSetup(feishuCommentPermissionGuide, "评论权限")}>
                          复制给管理员
                        </button>
                      </div>
                    </div>
                  )}
                  <div className="feishu-settings-actions">
                    <button type="button" onClick={() => void saveFeishuAdvancedSettings()} disabled={feishuSettingsBusy || !feishuStatus.configured}>
                      {feishuSettingsBusy ? "正在保存…" : "保存写入设置"}
                    </button>
                  </div>
                </div>
                <div className="feishu-setup-list">
                  {feishuAdvancedItems.map((item) => (
                    <article className={item.active ? "is-active" : ""} key={item.label}>
                      <div className="setup-card-head">
                        <div>
                          <span>{item.label}</span>
                          <strong>{item.status}</strong>
                        </div>
                        <i aria-hidden="true" />
                      </div>
                      <p>{item.summary}</p>
                      <div className="setup-mode">
                        <span>{item.active ? "复测状态" : "当前限制"}</span>
                        <strong>{item.availability}</strong>
                      </div>
                      <ul className={`setup-steps ${item.active ? "is-checklist" : "is-blockers"}`}>
                        {item.details.map((detail) => (
                          <li key={detail}>{detail}</li>
                        ))}
                      </ul>
                      <small>{item.impact}</small>
                      <div className="setup-actions">
                        <button type="button" onClick={() => void copyFeishuOptionalSetup(item.copyText, item.label)}>
                          {item.copyLabel}
                        </button>
                      </div>
                    </article>
                  ))}
                </div>
                <details className="feishu-advanced-note">
                  <summary>高级填写说明</summary>
                  <p>优先粘贴飞书清单或分组链接；如果链接无法识别，再填写飞书接口中的清单 ID / 分组 ID。页面保存值优先生效，环境变量只作为部署兜底。</p>
                </details>
              </section>
              <div className="connection-guide" aria-label="飞书连接向导">
                <div className="guide-now">
                  <span>当前步骤 {feishuGuideStep} / 4</span>
                  <strong>{feishuGuideTitle}</strong>
                  <p>{feishuGuideBody}</p>
                  {feishuGuideStep === 1 && (
                    <div className="feishu-credential-card" aria-label="飞书应用凭据配置">
                      <div className="guide-actions guide-actions-inline">
                        <a className="guide-primary-action" href={feishuAppListUrl} target="_blank" rel="noreferrer">
                          打开飞书应用列表 <ArrowUpRight />
                        </a>
                        <small>如果还没有应用，请在飞书开放平台创建企业自建应用；创建完成后回到这里填 App ID 和 App Secret。</small>
                      </div>
                      <div className="feishu-credential-fields">
                        <label className="config-field">
                          <span>App ID</span>
                          <input value={feishuAppForm.appId} onChange={(event) => updateFeishuAppForm("appId", event.target.value)} placeholder="cli_..." autoComplete="off" spellCheck={false} />
                        </label>
                        <label className="config-field">
                          <span>App Secret</span>
                          <input type="password" value={feishuAppForm.appSecret} onChange={(event) => updateFeishuAppForm("appSecret", event.target.value)} placeholder="只保存到本机后端，不会回显" autoComplete="new-password" spellCheck={false} />
                        </label>
                        <details className="feishu-credential-advanced">
                          <summary>高级选项</summary>
                          <div className="feishu-credential-fields">
                            <label className="config-field">
                              <span>飞书开放平台地址</span>
                              <input value={feishuAppForm.baseURL} onChange={(event) => updateFeishuAppForm("baseURL", event.target.value)} placeholder="https://open.feishu.cn" spellCheck={false} />
                            </label>
                            <label className="config-field">
                              <span>用户 ID 类型</span>
                              <select value={feishuAppForm.userIdType} onChange={(event) => updateFeishuAppForm("userIdType", event.target.value)}>
                                <option value="open_id">open_id（推荐）</option>
                                <option value="union_id">union_id</option>
                                <option value="user_id">user_id</option>
                              </select>
                            </label>
                          </div>
                        </details>
                        <button type="button" className="guide-confirm-action credential-save-action" onClick={() => void saveFeishuCredentials()} disabled={feishuBusy}>
                          {feishuBusy ? "正在保存…" : "保存到本机并继续"} <Check />
                        </button>
                      </div>
                      <small>App Secret 会通过本机 API 写入 Git 忽略的服务端配置文件；不会写入浏览器 localStorage、任务记录或 Git。保存后不需要重启服务。</small>
                    </div>
                  )}
                  {feishuGuideStep === 2 && (
                    <div className="guide-actions">
                      {feishuStatus.redirectUri ? (
                        <a className="guide-primary-action" href={feishuSecurityUrl} target="_blank" rel="noreferrer" onClick={() => void prepareFeishuRedirectSetup()}>
                          复制地址并打开飞书安全设置 <ArrowUpRight />
                        </a>
                      ) : (
                        <button type="button" className="guide-primary-action" disabled>
                          复制地址并打开飞书安全设置 <ArrowUpRight />
                        </button>
                      )}
                      <button type="button" className="guide-confirm-action" onClick={() => void confirmFeishuRedirectSaved()} disabled={feishuBusy || !feishuStatus.redirectUri}>
                        我已在飞书保存，继续绑定 <Check />
                      </button>
                      <small>飞书后台不允许本系统跨站替你保存设置；打开后只需要粘贴并保存。</small>
                    </div>
                  )}
                </div>
                <ol className="guide-steps">
                  <li className={guideStepClass(1)}><b>1</b><div><strong>配置飞书应用</strong><span>打开飞书应用列表，复制 App ID / App Secret，回到本平台保存。</span></div></li>
                  <li className={guideStepClass(2)}><b>2</b><div><strong>登记回调地址</strong><span>本系统复制回调地址并打开飞书安全设置，部署人员在后台粘贴保存。</span></div></li>
                  <li className={guideStepClass(3)}><b>3</b><div><strong>绑定成员身份</strong><span>成员输入系统姓名或别名，跳转飞书确认身份后返回本系统。</span></div></li>
                  <li className={guideStepClass(4)}><b>4</b><div><strong>审批后写入飞书</strong><span>回到会议 Agent，分析纪要并人工批准后创建飞书任务。</span></div></li>
                </ol>
              </div>
              <section className="feishu-bind-panel" aria-label="绑定飞书成员身份">
                <p className="secret-note"><Key /> {feishuSetupHint} 系统只保存任务负责人匹配所需的身份映射，不把飞书用户令牌写入任务记录或 Git。</p>
                <div className="config-fields">
                  <label className="config-field"><span>第 3 步：系统成员名或别名</span><input value={feishuAlias} onChange={(event) => setFeishuAlias(event.target.value)} placeholder={feishuCanBind ? "例如：张三、老张；留空则使用飞书姓名" : "第 2 步完成后再填写成员名"} spellCheck={false} disabled={!feishuCanBind} /></label>
                </div>
              </section>
            <div className="feishu-linked-users">
              <header><span>已绑定身份</span><button type="button" onClick={() => void refreshFeishuStatus()} disabled={feishuBusy}>刷新</button></header>
              {feishuStatus.linkedUsers.length ? (
                <ul>{feishuStatus.linkedUsers.map((user) => <li key={user.id}><strong>{user.name}</strong><span>{user.aliases.length ? `别名：${user.aliases.join("、")}` : "未设置别名"}</span><small>{user.emailPreview || "邮箱未展示"} · {user.hasOpenId ? "open_id 已保存" : "缺少 open_id"}</small></li>)}</ul>
              ) : <p>还没有绑定飞书成员。要创建带负责人的飞书任务，需要先完成至少一个成员身份绑定。</p>}
            </div>
            <details className="feishu-deploy-note" open={feishuGuideStep === 2}>
              <summary>{feishuGuideStep === 1 ? "高级部署方式（可选）" : "部署配置参考"}</summary>
              {feishuGuideStep === 1 ? (
                <>
                  <p>普通本地演示不需要手动编辑 <code>.env</code>，优先使用上方表单保存。只有部署到固定服务器或需要团队统一环境变量时，才使用下面模板；保存后需要重启服务。不要修改 <code>.env.example</code>，也不要把 App Secret 发到前端、日志或 Git。</p>
                  <pre className="env-template" aria-label="飞书 .env 配置模板">{feishuEnvTemplate}</pre>
                  <div className="deploy-copy-row deploy-copy-row-actions">
                    <a className="guide-primary-action" href={feishuAppListUrl} target="_blank" rel="noreferrer">打开飞书应用列表 <ArrowUpRight /></a>
                    <button type="button" onClick={() => void copyFeishuEnvTemplate()}>复制高级模板</button>
                  </div>
                </>
              ) : (
                <p>第 2 步由部署人员完成：点击上方主按钮后，本系统会复制下面的地址并打开飞书当前应用的安全设置页。把地址粘贴到重定向 URL / OAuth 回调地址设置中并保存；保存后回到这里点“我已在飞书保存，继续绑定”，系统会在本机记录核验状态并开放成员绑定。</p>
              )}
              {feishuGuideStep !== 1 && (
                <>
                  <div className="deploy-copy-row">
                    <label className="config-field"><span>OAuth 回调地址</span><input value={feishuStatus.redirectUri || "尚未可用"} readOnly /></label>
                    <button type="button" onClick={() => void copyFeishuRedirectUri()} disabled={!feishuStatus.redirectUri}>只复制地址</button>
                  </div>
                  <p className="copy-feedback">{feishuCopyMessage || "优先使用上方主按钮；飞书里保存完成后，不需要改配置文件，直接点“我已在飞书保存”。"}</p>
                </>
              )}
              {feishuGuideStep === 1 && <p className="copy-feedback">{feishuCopyMessage || "推荐使用上方表单保存；高级模板只用于部署人员手动维护环境变量。"}</p>}
            </details>
            </div>
            </div>
            <footer className="config-actions platform-actions">
              <div className="platform-action-feedback" aria-live="polite">{feishuError ? <span className="is-error">{feishuError}</span> : <span>{feishuGuideStep === 1 ? "先在上方保存 App ID 和 App Secret；保存成功后会自动进入回调地址步骤。" : feishuCanBind ? "点击绑定后会跳转到飞书，由飞书确认身份后返回本系统。" : "当前只能查看状态；在飞书里保存回调地址后，点“我已在飞书保存，继续绑定”。"}</span>}</div>
              <div className="platform-action-buttons"><button type="button" onClick={() => void refreshFeishuStatus()} disabled={feishuBusy}>重新检查</button><button className="save-config" type="button" onClick={() => void beginFeishuBinding()} disabled={feishuBusy || !feishuCanBind}>{feishuBusy ? "正在发起授权…" : "绑定当前飞书用户"} <ArrowRight /></button></div>
            </footer>
          </section>
        </div>
      )}

      <UserSkillsPanel open={skillsOpen} onClose={closeSkills} onSaved={notify} demoPrompt={skillDemoPrompt} />
      <RunInspector open={inspectorOpen} run={run} onClose={closeInspector} />
      <div className={`toast liquid-glass ${toast ? "show" : ""}`} role="status" aria-live="polite">{toast}</div>
    </main>
  );
}

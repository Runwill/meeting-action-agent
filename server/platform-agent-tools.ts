import type { AgentRun, ConversationTurn, FeishuSettingsChangeSet } from "./agent-store.ts";
import { getFeishuConfig } from "./feishu-config.ts";

type TurnMetadata = ConversationTurn["metadata"];

export type PlatformAgentToolPlan = {
  type: "none";
} | {
  type: "facts";
  action: string;
  facts: Record<string, unknown>;
  metadata: TurnMetadata;
} | {
  type: "proposal";
  content: string;
  action: string;
  changes: FeishuSettingsChangeSet;
  expected: FeishuSettingsChangeSet;
  metadata: TurnMetadata;
};

export type PlatformSettingScope = "summary" | "due_reminders" | "comments" | "tasklist" | "capabilities" | "unknown";

export type PlatformToolIntent = {
  intent: "query_platform_settings" | "query_platform_capabilities" | "propose_platform_settings_change" | "guide_platform_setting_change" | "not_platform";
  platform?: "feishu" | null;
  setting_scope?: PlatformSettingScope | null;
  changes?: FeishuSettingsChangeSet;
  remaining_user_message?: string;
  reply?: string;
};

function toolMetadata(platform: string, tool: string, source: string, detail: string, modelCalled = false): TurnMetadata {
  return {
    agent_source: source,
    source_detail: detail,
    platform,
    tool,
    model_called: modelCalled,
  };
}

function modelIntentMetadata(tool: string, detail: string): TurnMetadata {
  return toolMetadata("feishu", tool, "model_understanding", detail, true);
}

function arraysEqual(a: number[] | undefined, b: number[] | undefined) {
  const left = a || [];
  const right = b || [];
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function normalizeReminderMinutes(values: number[]) {
  return [...new Set(values.filter((value) => Number.isInteger(value) && value >= 0 && value <= 43_200))].slice(0, 6);
}

function looksLikeSettingId(value: string) {
  return /^https?:\/\//i.test(value) || /^[A-Za-z0-9][A-Za-z0-9._:-]{2,199}$/.test(value);
}

export function formatReminderMinute(value: number) {
  if (value === 0) return "截止时提醒";
  if (value % 1440 === 0) return `提前 ${value / 1440} 天`;
  if (value % 60 === 0) return `提前 ${value / 60} 小时`;
  return `提前 ${value} 分钟`;
}

type FeishuSettingsQuery = "due_reminders" | "comments" | "tasklist" | "summary" | "capabilities";

function scopeToSettingsQuery(scope: PlatformSettingScope | null | undefined): FeishuSettingsQuery {
  if (scope === "due_reminders" || scope === "comments" || scope === "tasklist" || scope === "capabilities") return scope;
  return "summary";
}

function buildFeishuCapabilityFacts() {
  return {
    supported: [
      "创建任务",
      "按 GUID 回读",
      "进行中 / 已完成状态写回",
      "标题 / 描述 / 截止日期 / 优先级元数据字段写回",
      "来源标记",
      "清单归类",
      "创建任务时写入到期提醒",
      "可选评论记录",
      "负责人映射预检",
    ],
    boundaries: [
      "飞书没有“进行中”原生状态；本系统的进行中对应飞书的未完成状态",
      "追踪阶段负责人变更尚未接入",
      "子任务尚未接入",
      "附件 / 文档上传尚未接入",
      "Webhook 自动同步尚未接入",
    ],
  };
}

export function buildPlatformAgentContext(run: AgentRun) {
  if (run.connector_id !== "feishu") return null;
  const config = getFeishuConfig();
  const reminderLabels = config?.dueReminderMinutes.map(formatReminderMinute) || [];
  const verifiedCreatedTaskCount = run.created_tasks.filter((task) => task.verified).length;
  return {
    platform: "feishu",
    displayName: "飞书任务",
    configured: !!config,
    writesRequireConfirmation: true,
    intentOptions: [
      "query_platform_settings",
      "query_platform_capabilities",
      "propose_platform_settings_change",
      "guide_platform_setting_change",
      "not_platform",
    ],
    settings: [{
      scope: "due_reminders",
      label: "新建任务提醒规则",
      fields: ["dueReminderMinutes"],
      readable: true,
      writable: true,
      aliases: ["默认提醒", "默认到期提醒", "提醒时间", "提前多久提醒", "新建任务提醒", "到期提醒", "同步旧任务提醒", "补写到已有任务"],
      current: config ? {
        dueReminderMinutes: config.dueReminderMinutes,
        labels: reminderLabels,
        enabled: config.dueReminderMinutes.length > 0,
      } : null,
      meaning: "本系统创建或同步飞书任务时写入的提醒规则，不是飞书客户端或账号里的全局默认提醒设置。",
      valueRules: [
        "dueReminderMinutes 使用分钟数组；截止时提醒为 0，半小时为 30，1 小时为 60，1 天为 1440。",
        "关闭提醒时 dueReminderMinutes 为空数组。",
        "修改提醒必须有明确时间或明确关闭；只有“改一下提醒”时应使用 guide_platform_setting_change。",
        "用户明确提到任务编号、任务标题或“某个任务”的提醒时，不属于平台写入设置，应交给任务侧处理单任务提醒同步。",
        "用户要求同步旧任务、补写到已有任务或旧的也改成当前提醒时，使用当前 dueReminderMinutes 生成 propose_platform_settings_change。",
      ],
      examples: [
        { user: "现在提醒时间是多久", intent: "query_platform_settings", setting_scope: "due_reminders" },
        { user: "改成半小时", intent: "propose_platform_settings_change", setting_scope: "due_reminders", changes: { dueReminderMinutes: [30] } },
        { user: "把旧任务也改成当前提醒", intent: "propose_platform_settings_change", setting_scope: "due_reminders", changes: { dueReminderMinutes: config?.dueReminderMinutes || [] } },
      ],
      boundaries: [
        "不能声称已经修改飞书客户端默认提醒。",
        "不能把“任务1的提醒”偷换成全局新建任务提醒；单任务提醒必须走任务侧确认卡。",
        "不能声称已直接修改任意单个飞书任务提醒；保存和旧任务同步都必须经过确认卡。",
      ],
    }, {
      scope: "comments",
      label: "操作记录写入评论",
      fields: ["syncComments"],
      readable: true,
      writable: true,
      aliases: ["评论", "操作记录", "写入评论", "记录写入任务评论"],
      current: config ? { syncComments: config.syncComments } : null,
      valueRules: ["开启时 syncComments=true；关闭时 syncComments=false。"],
      examples: [
        { user: "开启操作记录写入评论", intent: "propose_platform_settings_change", setting_scope: "comments", changes: { syncComments: true } },
        { user: "评论记录现在开了吗", intent: "query_platform_settings", setting_scope: "comments" },
      ],
      boundaries: ["评论权限不足时不阻断主任务写入。"],
    }, {
      scope: "tasklist",
      label: "飞书清单与分组",
      fields: ["tasklistGuid", "tasklistSectionGuid"],
      readable: true,
      writable: true,
      aliases: ["清单", "任务清单", "清单分组", "分组", "归类"],
      current: config ? {
        tasklistGuid: config.tasklistGuid,
        tasklistSectionGuid: config.tasklistSectionGuid,
        tasklistConfigured: !!config.tasklistGuid,
        tasklistSectionConfigured: !!config.tasklistSectionGuid,
      } : null,
      valueRules: [
        "只有用户提供明确飞书清单链接、分组链接或 ID 时才能 propose。",
        "只有清单名称或模糊描述时必须使用 guide_platform_setting_change，引导用户在平台连接面板读取清单后选择。",
        "清空清单时 tasklistGuid=null 且 tasklistSectionGuid=null。",
      ],
      examples: [
        { user: "把清单改成开发清单", intent: "guide_platform_setting_change", setting_scope: "tasklist" },
        { user: "清单设置成 https://...", intent: "propose_platform_settings_change", setting_scope: "tasklist" },
      ],
      boundaries: ["不能只按名称猜测清单或分组 ID。"],
    }],
    capabilities: buildFeishuCapabilityFacts(),
    runState: {
      verifiedCreatedTaskCount,
      canSyncExistingTaskSettings: verifiedCreatedTaskCount > 0,
    },
  };
}

function buildFeishuSettingsFacts(query: FeishuSettingsQuery) {
  const config = getFeishuConfig();
  const capabilityFacts = buildFeishuCapabilityFacts();
  if (!config) {
    return {
      query,
      configured: false,
      platform: "飞书任务",
      settings: null,
      capabilities: capabilityFacts,
      scope: "飞书应用未配置时不能读取或保存飞书写入设置。",
    };
  }
  const reminderLabels = config.dueReminderMinutes.map(formatReminderMinute);
  return {
    query,
    configured: true,
    platform: "飞书任务",
    settings: {
      tasklistGuid: config.tasklistGuid,
      tasklistSectionGuid: config.tasklistSectionGuid,
      tasklistConfigured: !!config.tasklistGuid,
      tasklistSectionConfigured: !!config.tasklistSectionGuid,
      dueReminderMinutes: config.dueReminderMinutes,
      dueReminderLabels: reminderLabels,
      dueReminderEnabled: config.dueReminderMinutes.length > 0,
      syncComments: config.syncComments,
    },
    capabilities: capabilityFacts,
    scope: "这些是“平台连接 → 飞书任务写入设置”的当前规则，只影响后续由本系统新创建或同步的飞书任务；不是飞书客户端/账号里的任务默认提醒设置，也不会修改已存在任务。",
    usageHints: [
      "按名称选择清单应在平台连接面板读取清单后选择",
      "对话里只有提供明确清单链接或 ID 时才会生成修改确认",
      "评论权限不足时不阻断主任务写入",
    ],
  };
}

function feishuSettingGuideFacts(scope: PlatformSettingScope | null | undefined) {
  if (scope === "tasklist") {
    return {
      issue: "tasklist_name_is_ambiguous",
      requestedOperation: "修改飞书任务清单或分组",
      reason: "不能只按名称猜测保存清单或分组，否则可能把任务写入错误位置。",
      safeNextSteps: [
        "在“平台连接 → 飞书任务写入设置”里点击“读取清单”后选择",
        "或提供具体飞书清单 / 分组链接",
        "或提供明确清单 / 分组 ID",
      ],
      writeAllowedNow: false,
    };
  }
  if (scope === "due_reminders") {
    return {
      issue: "reminder_time_missing",
      requestedOperation: "修改本系统创建飞书任务时写入的提醒规则",
      reason: "写入提醒规则需要明确时间，不能由系统猜测。",
      examples: ["改成提前 30 分钟", "设置提前 2 小时", "关闭默认提醒"],
      writeAllowedNow: false,
    };
  }
  return {
    issue: "platform_setting_target_missing",
    requestedOperation: "修改飞书写入设置",
    reason: "没有足够信息判断要改哪一项设置以及改成什么值。",
    safeNextSteps: [
      "说明要改新建任务提醒、评论记录还是清单归类",
      "涉及清单时提供飞书清单 / 分组链接，或在平台连接面板读取后选择",
      "涉及提醒时提供明确时间，例如提前 30 分钟或关闭默认提醒",
    ],
    writeAllowedNow: false,
  };
}

function feishuSettingGuidePlan(metadata: TurnMetadata, scope: PlatformSettingScope | null | undefined): PlatformAgentToolPlan {
  return {
    type: "facts",
    action: "platform_setting_needs_detail",
    facts: feishuSettingGuideFacts(scope),
    metadata,
  };
}

export function sameFeishuSettingValue(field: keyof FeishuSettingsChangeSet, left: FeishuSettingsChangeSet[keyof FeishuSettingsChangeSet], right: FeishuSettingsChangeSet[keyof FeishuSettingsChangeSet]) {
  if (field === "dueReminderMinutes") return arraysEqual(left as number[] | undefined, right as number[] | undefined);
  return left === right;
}

export function summarizeFeishuSettingsChanges(changes: FeishuSettingsChangeSet) {
  const parts: string[] = [];
  if ("syncComments" in changes) parts.push(`${changes.syncComments ? "开启" : "关闭"}操作记录写入评论`);
  if ("dueReminderMinutes" in changes) parts.push(`新建任务提醒规则改为${changes.dueReminderMinutes?.length ? changes.dueReminderMinutes.map(formatReminderMinute).join("、") : "未启用"}`);
  if ("tasklistGuid" in changes) parts.push(`清单改为${changes.tasklistGuid || "未设置"}`);
  if ("tasklistSectionGuid" in changes) parts.push(`分组改为${changes.tasklistSectionGuid || "未设置"}`);
  return parts.join("；");
}

function hasOwn(object: object, key: string) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function normalizeFeishuSettingsChanges(input: FeishuSettingsChangeSet | undefined) {
  const changes: FeishuSettingsChangeSet = {};
  if (!input) return changes;
  if (hasOwn(input, "syncComments")) changes.syncComments = input.syncComments === true;
  if (hasOwn(input, "dueReminderMinutes")) changes.dueReminderMinutes = normalizeReminderMinutes(Array.isArray(input.dueReminderMinutes) ? input.dueReminderMinutes : []);
  if (hasOwn(input, "tasklistGuid")) {
    changes.tasklistGuid = typeof input.tasklistGuid === "string" && input.tasklistGuid.trim()
      ? input.tasklistGuid.trim()
      : null;
  }
  if (hasOwn(input, "tasklistSectionGuid")) {
    changes.tasklistSectionGuid = typeof input.tasklistSectionGuid === "string" && input.tasklistSectionGuid.trim()
      ? input.tasklistSectionGuid.trim()
      : null;
  }
  return changes;
}

function buildFeishuSettingsChangeProposal(run: AgentRun, changes: FeishuSettingsChangeSet, metadata: TurnMetadata, modelProposalCopy?: string): PlatformAgentToolPlan {
  const normalizedChanges = normalizeFeishuSettingsChanges(changes);
  if (!Object.keys(normalizedChanges).length) return feishuSettingGuidePlan(metadata, "unknown");
  const config = getFeishuConfig();
  if (!config) {
    return {
      type: "facts",
      action: "platform_setting_unavailable",
      facts: {
        issue: "feishu_not_configured",
        requestedChanges: normalizedChanges,
        reason: "飞书应用尚未配置，不能修改飞书写入设置。",
        safeNextSteps: ["先完成平台连接配置"],
        writeAllowedNow: false,
      },
      metadata,
    };
  }
  const fullExpected = {
    tasklistGuid: config.tasklistGuid,
    tasklistSectionGuid: config.tasklistSectionGuid,
    dueReminderMinutes: config.dueReminderMinutes,
    syncComments: config.syncComments === true,
  };
  const expected = Object.fromEntries(Object.keys(normalizedChanges).map((field) => [field, fullExpected[field as keyof typeof fullExpected]])) as FeishuSettingsChangeSet;
  if ((Object.keys(normalizedChanges) as Array<keyof FeishuSettingsChangeSet>).every((field) => sameFeishuSettingValue(field, expected[field], normalizedChanges[field]))) {
    const canSyncExistingReminders = "dueReminderMinutes" in normalizedChanges && run.created_tasks.some((task) => task.verified);
    if (canSyncExistingReminders) {
      const content = "当前新建任务提醒设置已经是这个值；确认后我会尝试把本次运行里已经创建并验证过的飞书任务提醒同步为这条规则。";
      return {
        type: "proposal",
        content,
        action: "propose_platform_setting",
        changes: normalizedChanges,
        expected,
        metadata,
      };
    }
    return {
      type: "facts",
      action: "platform_setting_unchanged",
      facts: {
        issue: "settings_already_match",
        requestedChanges: normalizedChanges,
        currentSettings: fullExpected,
        reason: "当前飞书写入设置已经与用户要求一致，不需要生成确认卡。",
        writeAllowedNow: false,
      },
      metadata,
    };
  }
  const defaultContent = `准备修改飞书写入设置：${summarizeFeishuSettingsChanges(normalizedChanges)}。确认后会保存到平台连接配置，后续由本系统创建、状态同步和字段修改会按此设置执行。`;
  const safeModelCopy = modelProposalCopy?.trim()
    && !/(已保存|已经保存|已更新|已经更新|已修改|已经修改|保存完成|修改完成)/.test(modelProposalCopy)
    ? modelProposalCopy.trim()
    : "";
  return {
    type: "proposal",
    content: safeModelCopy || defaultContent,
    action: "propose_platform_setting",
    changes: normalizedChanges,
    expected,
    metadata,
  };
}

export function planPlatformAgentToolFromPlan(run: AgentRun, _content: string, platformPlan: PlatformToolIntent): PlatformAgentToolPlan {
  if (run.connector_id !== "feishu") return { type: "none" };
  if (platformPlan.platform && platformPlan.platform !== "feishu") return { type: "none" };
  if (platformPlan.intent === "not_platform") return { type: "none" };

  if (platformPlan.intent === "query_platform_capabilities") {
    return {
      type: "facts",
      action: "answer_platform_setting",
      facts: buildFeishuSettingsFacts("capabilities"),
      metadata: modelIntentMetadata("getPlatformCapabilities", "模型识别平台能力查询"),
    };
  }

  if (platformPlan.intent === "query_platform_settings") {
    const query = scopeToSettingsQuery(platformPlan.setting_scope);
    return {
      type: "facts",
      action: "answer_platform_setting",
      facts: buildFeishuSettingsFacts(query),
      metadata: modelIntentMetadata(query === "capabilities" ? "getPlatformCapabilities" : "getPlatformSettings", "模型识别平台配置查询"),
    };
  }

  if (platformPlan.intent === "guide_platform_setting_change") {
    return feishuSettingGuidePlan(
      modelIntentMetadata("guidePlatformSettingChange", "模型识别平台配置修改但缺少必要信息"),
      platformPlan.setting_scope,
    );
  }

  if (platformPlan.intent === "propose_platform_settings_change") {
    const changes = normalizeFeishuSettingsChanges(platformPlan.changes);
    if (!Object.keys(changes).length) {
      return feishuSettingGuidePlan(
        modelIntentMetadata("guidePlatformSettingChange", "模型识别平台配置修改但缺少目标值"),
        platformPlan.setting_scope,
      );
    }
    if (hasOwn(changes, "tasklistGuid") && typeof changes.tasklistGuid === "string" && !looksLikeSettingId(changes.tasklistGuid)) {
      return feishuSettingGuidePlan(
        modelIntentMetadata("guidePlatformSettingChange", "模型识别清单修改但缺少明确链接或 ID"),
        "tasklist",
      );
    }
    return buildFeishuSettingsChangeProposal(
      run,
      changes,
      modelIntentMetadata("proposePlatformSettingChange", "模型理解平台设置意图，等待用户确认"),
      platformPlan.reply,
    );
  }

  return { type: "none" };
}

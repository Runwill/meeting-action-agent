import { z } from "zod";

const trimmedString = (label: string, max: number) => z.string()
  .trim()
  .min(1, `${label}不能为空。`)
  .max(max, `${label}不能超过 ${max} 个字符。`);

const optionalTrimmedString = (label: string, max: number) => z.preprocess(
  (value) => typeof value === "string" && !value.trim() ? undefined : value,
  trimmedString(label, max).optional(),
);

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format();
    return true;
  } catch {
    return false;
  }
}

const TeamMemberSchema = z.object({
  name: trimmedString("成员姓名", 80),
  aliases: z.array(trimmedString("成员别名", 80)).max(30).default([]),
  role: optionalTrimmedString("成员角色", 80),
}).strict();

const TerminologySchema = z.object({
  term: trimmedString("术语", 100),
  meaning: trimmedString("术语解释", 1000),
}).strict();

/** @deprecated Compatibility schema for pre-Markdown test fixtures and store migration. */
const GuidanceModuleSchema = z.object({
  name: trimmedString("指导模块名称", 120),
  content: trimmedString("指导模块内容", 4000),
  kind: z.enum(["knowledge", "guidance"]).default("knowledge"),
  enabled: z.boolean().default(true),
}).strict();

/** @deprecated The product user path uses Markdown Skill files, not this fixed schema. */
export const TeamContextSchema = z.object({
  members: z.array(TeamMemberSchema).max(200).default([]),
  terminology: z.array(TerminologySchema).max(300).default([]),
  defaults: z.object({
    timezone: trimmedString("时区", 100).refine(isValidTimeZone, "请输入有效的 IANA 时区，例如 Asia/Shanghai。"),
    priorityPolicy: optionalTrimmedString("优先级规则", 2000),
  }).strict().default({ timezone: "Asia/Shanghai" }),
  customGuidance: z.string().trim().max(4000, "自定义指导不能超过 4000 个字符。").default(""),
  // Optional keeps older stored contexts and callers source-compatible. New UI writes this as a list.
  guidanceModules: z.array(GuidanceModuleSchema).max(100).optional(),
}).strict().superRefine((context, issueContext) => {
  const identities = new Map<string, string>();
  for (const [memberIndex, member] of context.members.entries()) {
    for (const [aliasIndex, identity] of [member.name, ...member.aliases].entries()) {
      const key = identity.toLocaleLowerCase();
      const existing = identities.get(key);
      if (existing && existing !== member.name) {
        issueContext.addIssue({
          code: z.ZodIssueCode.custom,
          message: `成员姓名或别名“${identity}”与“${existing}”冲突。`,
          path: ["members", memberIndex, aliasIndex === 0 ? "name" : "aliases", Math.max(0, aliasIndex - 1)],
        });
      } else {
        identities.set(key, member.name);
      }
    }
  }

  const terms = new Set<string>();
  for (const [index, item] of context.terminology.entries()) {
    const key = item.term.toLocaleLowerCase();
    if (terms.has(key)) {
      issueContext.addIssue({ code: z.ZodIssueCode.custom, message: `术语“${item.term}”重复。`, path: ["terminology", index, "term"] });
    }
    terms.add(key);
  }
});

export type TeamContext = z.output<typeof TeamContextSchema>;

export type GuidanceModule = z.output<typeof GuidanceModuleSchema>;

export const DEFAULT_TEAM_CONTEXT: TeamContext = {
  members: [],
  terminology: [],
  defaults: { timezone: "Asia/Shanghai" },
  customGuidance: "",
};

export function normalizeOwnerWithTeamContext(owner: string | null, context: TeamContext) {
  if (!owner) return null;
  const normalized = owner.trim().toLocaleLowerCase();
  for (const member of context.members) {
    if ([member.name, ...member.aliases].some((identity) => identity.toLocaleLowerCase() === normalized)) {
      return member.name;
    }
  }
  return owner.trim() || null;
}

export function isConfiguredTeamIdentity(value: string, context: TeamContext) {
  const normalized = value.trim().toLocaleLowerCase();
  return context.members.some((member) => [member.name, ...member.aliases].some((identity) => identity.toLocaleLowerCase() === normalized));
}

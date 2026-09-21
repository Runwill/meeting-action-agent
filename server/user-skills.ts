import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import matter from "gray-matter";
import { z } from "zod";

const text = (label: string, max: number) => z.string().trim().min(1, `${label}不能为空。`).max(max, `${label}不能超过 ${max} 个字符。`);

export const UserSkillSchema = z.object({
  id: z.string().uuid(),
  name: text("Skill 名称", 120),
  enabled: z.boolean(),
  content: text("Skill 内容", 20_000),
}).strict();

export const UserSkillCollectionSchema = z.object({
  skills: z.array(UserSkillSchema).max(100),
}).strict().superRefine(({ skills }, context) => {
  const ids = new Set<string>();
  const names = new Set<string>();
  for (const [index, skill] of skills.entries()) {
    if (ids.has(skill.id)) context.addIssue({ code: z.ZodIssueCode.custom, message: "Skill ID 不能重复。", path: ["skills", index, "id"] });
    ids.add(skill.id);
    const normalizedName = skill.name.toLocaleLowerCase();
    if (names.has(normalizedName)) context.addIssue({ code: z.ZodIssueCode.custom, message: `Skill 名称“${skill.name}”重复。`, path: ["skills", index, "name"] });
    names.add(normalizedName);
  }
});

export type UserSkill = z.output<typeof UserSkillSchema>;

const defaultDirectory = process.env.USER_SKILL_DIR?.trim() || path.resolve(process.cwd(), "data/user-skills");
let activeDirectory = defaultDirectory;

function filePath(id: string) {
  return path.join(activeDirectory, `${id}.md`);
}

function serialize(skill: UserSkill) {
  return matter.stringify(`${skill.content.trim()}\n`, {
    id: skill.id,
    name: skill.name,
    enabled: skill.enabled,
    scope: "meeting-analysis",
    version: 1,
  });
}

function parseSkill(source: string) {
  const parsed = matter(source);
  return UserSkillSchema.parse({
    id: parsed.data.id,
    name: parsed.data.name,
    enabled: parsed.data.enabled,
    content: parsed.content.trim(),
  });
}

export function createUserSkillDraft(name = "新的用户 Skill", content = "# 会议分析约定\n\n在这里用自然语言说明成员称呼、项目术语、优先级习惯或任务整理要求。") : UserSkill {
  return { id: randomUUID(), name, enabled: true, content };
}

export async function listUserSkills() {
  try {
    const entries = await readdir(activeDirectory, { withFileTypes: true });
    const skills: UserSkill[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
      try {
        skills.push(parseSkill(await readFile(path.join(activeDirectory, entry.name), "utf8")));
      } catch {
        throw new Error(`用户 Skill 文件 ${entry.name} 格式无效。`);
      }
    }
    return skills.sort((left, right) => left.name.localeCompare(right.name, "zh-CN"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

export async function saveUserSkills(input: unknown) {
  const { skills } = UserSkillCollectionSchema.parse(input);
  await mkdir(activeDirectory, { recursive: true });
  const existing = await listUserSkills();

  for (const skill of skills) {
    const target = filePath(skill.id);
    const temporary = `${target}.tmp`;
    await writeFile(temporary, serialize(skill), "utf8");
    await rename(temporary, target);
  }

  const retained = new Set(skills.map((skill) => skill.id));
  for (const skill of existing) {
    if (!retained.has(skill.id)) await unlink(filePath(skill.id));
  }
  return listUserSkills();
}

/**
 * @deprecated Only converts pre-Markdown TeamContext data found in old stores
 * or deterministic regression fixtures. The user-facing API never parses a
 * structured team object and should use Markdown Skill files instead.
 */
export function legacyContextToSkill(value: unknown): UserSkill[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  const context = value as Record<string, unknown>;
  const members = Array.isArray(context.members) ? context.members.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
  const terms = Array.isArray(context.terminology) ? context.terminology.filter((item): item is Record<string, unknown> => !!item && typeof item === "object" && !Array.isArray(item)) : [];
  const defaults = context.defaults && typeof context.defaults === "object" && !Array.isArray(context.defaults) ? context.defaults as Record<string, unknown> : {};
  const custom = typeof context.customGuidance === "string" ? context.customGuidance.trim() : "";
  if (!members.length && !terms.length && !custom && typeof defaults.priorityPolicy !== "string") return [];

  const lines = ["# 从旧版团队配置迁移", ""];
  if (members.length) {
    lines.push("## 成员称呼", "");
    for (const member of members) {
      const name = typeof member.name === "string" ? member.name : "";
      const aliases = Array.isArray(member.aliases) ? member.aliases.filter((alias): alias is string => typeof alias === "string") : [];
      const role = typeof member.role === "string" && member.role ? `，角色：${member.role}` : "";
      if (name) lines.push(`- ${name}${aliases.length ? `；常用称呼：${aliases.join("、")}` : ""}${role}`);
    }
    lines.push("");
  }
  if (terms.length) {
    lines.push("## 项目术语", "");
    for (const term of terms) {
      if (typeof term.term === "string" && typeof term.meaning === "string") lines.push(`- ${term.term}：${term.meaning}`);
    }
    lines.push("");
  }
  if (typeof defaults.priorityPolicy === "string" && defaults.priorityPolicy.trim()) lines.push("## 优先级习惯", "", defaults.priorityPolicy.trim(), "");
  if (custom) lines.push("## 其他分析参考", "", custom, "");
  return [{ id: randomUUID(), name: "旧版团队配置（自动迁移）", enabled: true, content: lines.join("\n").trim() }];
}

export function setUserSkillDirectoryForTests(directory: string | null) {
  activeDirectory = directory ? path.resolve(directory) : defaultDirectory;
}

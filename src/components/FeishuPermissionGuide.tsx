import { useState } from "react";
import { ArrowSquareOut, Copy, WarningCircle } from "@phosphor-icons/react";
import { copyToClipboard } from "../utils/clipboard";

type PermissionKind = "task" | "comment";

const permissions: Record<PermissionKind, { title: string; scopes: string[]; explanation: string; retry: string }> = {
  task: {
    title: "飞书任务读写权限需要检查",
    scopes: ["task:task:write", "task:task:read"],
    explanation: "创建或回读任务被飞书拒绝。请检查任务权限、应用发布状态和可用范围；仅凭这次失败不能确定缺的是哪一项。",
    retry: "发布生效后，返回运行结果点击“安全重试原运行”；已创建的任务会按原幂等键复用。若仍失败，请检查成员是否能访问目标任务。",
  },
  comment: {
    title: "飞书评论权限需要检查",
    scopes: ["task:comment:write", "task:comment:read"],
    explanation: "主任务操作已保留，但评论接口拒绝写入。写评论需要写权限；若要读取评论核验，还需要读权限。也请检查应用可用范围。",
    retry: "发布生效后，在本系统对已有任务再次发起评论并确认，再打开飞书任务详情核对。仅刷新连接状态不能证明评论已写入。",
  },
};

export function FeishuPermissionGuide({
  kind,
  permissionUrl,
  onOpenConnection,
  onRefreshConnection,
  compact = false,
  failure = false,
}: {
  kind: PermissionKind;
  permissionUrl: string;
  onOpenConnection?: () => void;
  onRefreshConnection?: () => void | Promise<void>;
  compact?: boolean;
  failure?: boolean;
}) {
  const [copyFeedback, setCopyFeedback] = useState("");
  const item = permissions[kind];
  const scopeText = item.scopes.join("\n");
  const title = failure ? item.title : kind === "task" ? "创建飞书任务前检查权限" : "评论记录所需的飞书权限";
  const explanation = failure
    ? item.explanation
    : kind === "task"
      ? "首次创建任务前可以先核对这些权限、应用发布状态和可用范围；这里不代表当前连接已经失败。"
      : "启用评论记录后，写入评论需要写权限；若要读取评论核验，还需要读权限。这里不代表评论写入已经失败。";
  const adminText = `请在飞书开放平台当前应用的“权限管理”中检查并开通：\n${scopeText}\n保存后发布应用，并确认应用已对当前企业/成员生效。${
    failure
      ? kind === "comment" ? "本次评论写入失败不影响主任务。" : "完成后我会在系统中安全重试原任务。"
      : "这是配置前的权限核对，当前不代表接口已失败。"
  }\n${failure ? item.retry : "配置生效后，我会从系统内发起实际任务操作，并在飞书核对结果。"}`;

  async function copy(value: string, label: string) {
    if (await copyToClipboard(value)) {
      setCopyFeedback(`已复制${label}。`);
    } else {
      setCopyFeedback("浏览器没有允许自动复制，请选中上方权限名称手动复制。");
    }
  }

  return (
    <div className={`feishu-permission-guide${compact ? " is-compact" : ""}`} role={failure ? "alert" : "note"}>
      <div className="feishu-permission-heading">
        <WarningCircle weight="fill" aria-hidden="true" />
        <div><strong>{title}</strong><p>{explanation}</p></div>
      </div>
      <div className="feishu-permission-scopes" aria-label={`${title}的权限名称`}>
        {item.scopes.map((scope) => (
          <button type="button" key={scope} onClick={() => void copy(scope, `权限 ${scope}`)} title={`复制 ${scope}`}>
            <code>{scope}</code><Copy aria-hidden="true" />
          </button>
        ))}
      </div>
      <ol>
        <li>打开当前飞书应用的权限管理，搜索上面的权限；可点击权限名称逐项复制。若已具备权限，再检查应用可用范围及成员访问权限。</li>
        <li>在飞书后台保存、发布应用，并等待权限生效。这里无法跨站代替管理员完成。</li>
        <li>{failure ? item.retry : kind === "task"
          ? "权限生效后再审批创建；若之前的运行失败，可回到运行结果安全重试。"
          : "配置生效后，对已有任务发起评论并到飞书任务详情核对；刷新连接状态不能证明评论写入成功。"}</li>
      </ol>
      <div className="feishu-permission-actions">
        <a href={permissionUrl} target="_blank" rel="noreferrer" onClick={() => void copy(scopeText, "全部权限名称")}><ArrowSquareOut aria-hidden="true" /> 打开权限管理并复制权限</a>
        <button type="button" onClick={() => void copy(scopeText, "全部权限名称")}><Copy aria-hidden="true" /> 复制全部权限</button>
        <button type="button" onClick={() => void copy(adminText, "给管理员的说明")}>复制给管理员</button>
        {onRefreshConnection && <button type="button" onClick={() => void onRefreshConnection()}>刷新连接状态</button>}
        {onOpenConnection && <button type="button" onClick={onOpenConnection}>打开平台连接</button>}
      </div>
      <small aria-live="polite">{copyFeedback || "系统可打开对应页面并尝试复制权限名；勾选权限、保存和发布仍须在飞书后台完成。"}</small>
    </div>
  );
}

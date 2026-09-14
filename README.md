# 纪要成事 · Meeting Action Agent

把中文会议纪要转换成可追踪的行动项：负责人、截止日期、优先级、依赖、风险、原文证据与置信度一并保留。

## 本地运行

```bash
npm install
npm run dev
```

打开终端显示的地址。也可以直接双击 `启动演示.bat`，固定从 <http://localhost:5174> 启动。默认无需密钥，使用本地规则模式。

## 启用 AI 结构化抽取

点击页面顶部的 `Local mode`，填写 API Endpoint、API Key 和模型名称。默认预设兼容 DeepSeek，也可以连接其他 OpenAI-compatible API。环境变量配置仍然可用。

通过页面填写的 API 密钥只保存在服务端进程内存，不写入浏览器存储或项目文件。服务重启后需要重新填写。

## 验证与生产运行

```bash
npm test
npm run build
npm start
```

生产服务默认位于 <http://localhost:8788>，可通过 `PORT` 修改。

## 当前能力

- AI 模式：OpenAI-compatible Chat Completions + Zod 校验
- 本地模式：中文动作词、负责人、相对/绝对日期、优先级与风险识别
- 人工校对：直接编辑任务、补全负责人和日期、调整状态与优先级
- 导出：Markdown / CSV
- Agent 后端：澄清、批准、本地任务创建、结果回读验证与状态追踪 API
- 隐私：密钥仅在服务端运行时使用

## Agent API

`POST /api/agent/runs` 创建一次有状态的会议处理流程。后续可通过 `/clarify` 补充不确定信息，通过 `/approve` 批准任务创建，通过 `/track` 回读并追踪任务状态。运行记录和本地任务保存在 `data/agent-store.json`，该文件默认不会提交到 Git。

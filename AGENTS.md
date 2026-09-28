# Development Agent Instructions

Before changing this repository, read `docs/DEVELOPMENT_AGENT_HANDBOOK.md` completely.

That handbook is the source of truth for:

- product positioning and confirmed user decisions;
- the state-machine Agent architecture;
- Prompt Skill and user context design;
- current implementation status and known gaps;
- UI visual constraints;
- security requirements;
- acceptance cases and midterm deliverables.

Important rules:

1. Preserve user-created and untracked files. Never delete the ZIP archive or local reference assets.
2. Do not claim the frontend Agent loop is complete until the clarification, approval, verification, and tracking UI works end to end.
3. Do not commit API keys, `.env`, `data/agent-store.json`, `data/feishu-identities.json`, `data/model-config.env`, screenshots, build output, archives, or `视觉参考-Asme/`.
4. Keep external writes behind explicit user approval.
5. Default to the local task connector; the Feishu task v2 connector is available once configured (App credentials + member binding). Other third-party platforms remain deferred.
6. Run `npm test`, `npm run build`, and browser QA at desktop and 390px before handing off a feature-complete change.
7. Update the handbook when architecture, completion status, APIs, or acceptance results change.

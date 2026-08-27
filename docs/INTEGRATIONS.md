# Integrations and provider strategy

Preserve StarNet's multi-provider architecture initially. Useful categories may include OpenAI/ChatGPT/Codex, Gemini, local models, and other existing providers; exact current support is determined by code/tests, not this planning document.

Future **Economy**, **Balanced**, and **Deep** tiers should prefer the cheapest capable option and escalate for quality/difficulty. Temporary agents should not inherit expensive settings without reason. Provider/run cost should become observable.

ChatGPT subscriptions and OpenAI API billing are separate products/budgets. Do not integrate Hermes during the initial rebuild.

## Admission flow

`DISCOVER -> RECOMMEND -> APPROVE -> SPECIALIST EVALUATION -> ISOLATED TEST -> DECIDE -> DOCUMENT`

The Scout recommends; it does not install. The Integration Engineer or relevant specialist evaluates approved candidates for licensing, security, maintenance, platform, cost, rollback, and test evidence.

## Daily Open-Source Scout

The implemented workflow normally requests 3-5 worthwhile discoveries. Its source-adapter contract initially delegates truthful live discovery to the admitted agent's existing runtime web-research tools; future adapters may cover GitHub, GitLab, SourceForge, Hugging Face, Reddit, Hacker News, open-source directories, awesome lists, MCP, agent frameworks, media/automation/local-AI/business/coding tools, APIs, and datasets without changing objective or report storage.

Each item reports what it is, why it matters, Pine Star relevance, Windows/platform compatibility, license, cost, maintenance signal, integration difficulty, action (`IGNORE`, `WATCH`, `TEST`, `ADD`), and best owner.

Only a successfully completed Scout objective may finalize findings. Normalization requires a name, source, URL/reference, and valid action; removes duplicate references; preserves evidence; and uses `UNKNOWN` rather than inventing license or cost. Finalization writes the existing shared-report record and a bounded `scout_report_created` audit event on the objective. `TEST` and `ADD` remain recommendations for a separate Integration Engineer or specialist objective and never install automatically.

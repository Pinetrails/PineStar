# Integrations and provider strategy

Preserve StarNet's multi-provider architecture initially. Useful categories may include OpenAI/ChatGPT/Codex, Gemini, local models, and other existing providers; exact current support is determined by code/tests, not this planning document.

Future **Economy**, **Balanced**, and **Deep** tiers should prefer the cheapest capable option and escalate for quality/difficulty. Temporary agents should not inherit expensive settings without reason. Provider/run cost should become observable.

ChatGPT subscriptions and OpenAI API billing are separate products/budgets. Do not integrate Hermes during the initial rebuild.

## Admission flow

`DISCOVER -> RECOMMEND -> APPROVE -> SPECIALIST EVALUATION -> ISOLATED TEST -> DECIDE -> DOCUMENT`

The Scout recommends; it does not install. The Integration Engineer or relevant specialist evaluates approved candidates for licensing, security, maintenance, platform, cost, rollback, and test evidence.

## Daily Open-Source Scout

Future morning output normally contains 3-5 worthwhile discoveries from GitHub, GitLab, SourceForge, Hugging Face, Reddit, Hacker News, open-source directories, awesome lists, MCP, agent frameworks, media/automation/local-AI/business/coding tools, APIs, and datasets.

Each item reports what it is, why it matters, Pine Star relevance, Windows/platform compatibility, license, cost, maintenance signal, integration difficulty, action (`IGNORE`, `WATCH`, `TEST`, `ADD`), and best owner.


# Awesome LLM Apps evaluation

**Change:** `PS-2026-020`
**Inspected:** 2026-08-30
**External source:** `Shubhamsaboo/awesome-llm-apps` at `c55b274e5fdd82dabc360c13c3ccefc6e1f0ea88`
**License observed:** Apache-2.0 at repository root

## Outcome

Awesome LLM Apps is useful as a reference library, not a Pine Star foundation. No external package, skill, model proxy, application, install script, credential, or dependency was imported or executed. One concept was adapted natively: an offline advisory Change-ID scope check implemented with Node's standard library and existing Git.

## Priority findings

| Component | Evidence and overlap | Dependencies / services / cost | Security and license | Result | Owner |
| --- | --- | --- | --- | --- | --- |
| Scope Creep Detector | Its script parses a diff and flags path/intent mismatch, breadth, churn, manifests, config, and API signals. Pine Star already requires a Change ID and one coherent diff review, so a small Change-ID-aware check fits the existing Auditor/development workflow. Keyword overlap remains only triage evidence. | Python stdlib and local Git; offline; $0. | Read-only subprocess calls to Git; Apache-2.0. Pine Star used the concept, not copied code. | **ADD (native adaptation):** `scripts/pine-change-scope.mjs`. Advisory only; it cannot stage, revert, commit, or weaken review. | Auditor + Development |
| Commit Archaeologist | Local `git log`, line history, blame, co-change counts, and commit-message signals can help explain surprising code. Pine Star already has Git, PS change records, `CURRENT_STATUS`, and handoffs; the external tool does not correlate PS records automatically. | Python stdlib and local Git; offline; $0. | Read-only Git commands; Apache-2.0. History heuristics can confuse correlation with causation. | **WATCH:** later add a small PS-aware query only when repeated history reconstruction demonstrates need. | Librarian |
| Dependency Doctor | Offline checks cover Python backports/shadowing, unpinned entries, duplicate/conflicting exact pins; PyPI yank checks are optional network access. For this Node repository, package-lock plus existing test/security workflows provide stronger resolution evidence, and the tool is not a vulnerability scanner. | Python 3.11 stdlib; optional PyPI; $0 unless future model/tool use is added. | Reads one manifest; network only with `--online`; Apache-2.0. It proposes edits but does not validate runtime compatibility. | **WATCH:** do not import or auto-upgrade. Use existing reviewed npm tooling when dependency work is authorized. | Integration Engineer |
| Headroom context optimization | The included demo does not invoke `headroom-ai`: it manually retains first three, one known fatal, and last two synthetic log rows, estimates tokens as characters/4, and asserts equal answers without an LLM evaluation. This demonstrates selective projection, not the advertised proxy. | Proposed install is `headroom-ai[all]` plus OpenAI/Anthropic and optional proxy/framework stacks; external provider/API costs possible. | A model-traffic proxy would see prompts/tool outputs and creates a new trust, availability, provider, and credential boundary. Root example says Apache-2.0, but transitive/package licensing requires separate review. | **TEST concept only:** continue bounded projections, targeted reads, handoffs, `rg`, output caps, and source references. Do not install or proxy model traffic without a controlled benchmark and security review. | Development + Auditor |

## Secondary catalog

| Component/pattern | Relevance and overlap | External requirements / risk | Result | Owner |
| --- | --- | --- | --- | --- |
| Trust-gated agent team | Trust gates and audit chaining overlap Pine Star roster binding, admission, audit, E-stop, and approval controls. Its numeric trust score is not evidence of authority. | OpenAI, Streamlit, model calls; duplicate orchestration. | **WATCH** hash-chain tamper evidence separately; keep current authority model. | Auditor |
| AI Agent Governance | Action classification and audit concepts overlap existing consent, approval, capability, and audit controls. | External app/framework and model configuration; duplicate policy surface. | **IGNORE** as an implementation; retain as terminology reference. | Auditor |
| Product Launch Intelligence | Research-to-positioning pipeline is relevant to product research and listing preparation. | Provider-specific agents, web/search APIs, model cost, external data quality. | **TEST** its output stages against native objectives/reports; do not import runtime. | Idea Lab |
| SEO Audit Team | Structured crawl → competitor research → prioritized report maps to future listing/SEO preparation. | Google ADK/Gemini and Firecrawl MCP; credentials, browsing, cost, and prompt-injection exposure. | **WATCH** until authenticated research adapters and evidence QA are ready. | Marketing/Research |
| OpenAI Research Agent | Research planning and cited synthesis overlap Researcher and Scout. | OpenAI API plus search; cost and untrusted-content risks. | **IGNORE** duplicate runtime; adapt evidence discipline natively. | Researcher |
| Multi-MCP Agent Router | Capability-based server selection resembles Pine Star's lowest-capable routing. | MCP servers, provider API, credentials, tool-injection surface. | **IGNORE** duplicate router; evaluate individual MCP adapters through existing integration controls. | Integration Engineer |
| Typed/agentic RAG | Typed answers, retrieval boundaries, and tests are relevant to future project memory. | PydanticAI/vector/database/provider dependencies; ingestion privacy and stale-evidence risks. | **WATCH** pending a concrete retrieval decision and benchmark. | Librarian |
| Advisor/orchestrator/worker skill | Explicit briefs, verification, and bounded roles are useful process ideas. | Shells out to third-party CLIs/APIs, parallel workers, environment keys, temp files, and model spend. | **IGNORE** as a skill; Pine Star already has Coordinator/specialist routing and safer authority boundaries. | Coordinator |
| Project Graveyard | Local history summaries could prevent restarting abandoned work. | Python stdlib/local Git; can scan broad user directories by default and infer intent unreliably. | **WATCH** only for explicitly scoped directories; PS history already covers this repository. | Librarian |
| Self-improving agent skills | Keep-if-better evaluation loop resembles Pine Star's controlled evolution goal. | FastAPI, Google ADK, Gemini, Next.js, uploaded skill content, autonomous prompt mutation, API key/cost. | **IGNORE / RESEARCH:** never authorize external code to rewrite Pine Star. Preserve inspect → change → test → compare → keep/revert → audit. | Auditor + Development |

## Codex-development skill safety

- `scope-creep-detector`: reads a supplied diff or invokes read-only Git diff; no network or writes. Safe concept, adapted rather than installed.
- `commit-archaeologist`: invokes read-only Git log/blame/show operations with timeouts; no network or writes. Useful on demand, but installing it adds little beyond targeted native Git use and PS records.
- `dependency-doctor`: reads one manifest. Its offline path is local; `--online` sends package/version queries to PyPI. It is advisory and cannot establish vulnerability or runtime safety.
- `advisor-orchestrator-worker`: requests external CLIs/APIs, API keys, parallel processes, permissive CLI flags, temp files, and model usage. Not installed.
- `project-graveyard`: read-only local Git analysis but may scan conventional directories when no target is supplied. Not installed.
- `self-improving-agent-skills`: uploads/rewrites skill material through a Gemini/ADK application and introduces a large web stack. Not installed or executed.

## Context/headroom conclusion

The repository provides no controlled evidence that its Headroom integration would improve Codex development of Pine Star or Pine Star agents. The demo's synthetic selection reduces serialized characters from 100 records to six by construction; it does not measure tokenizer output, retrieval failures, answer quality across a dataset, latency, or proxy exposure. Pine Star should first measure its existing low-risk practices: handoff size, files/lines read per Change ID, tool-output truncation, repeated reads, and report projection sizes. Any future proxy experiment must use scrubbed fixtures, an accuracy/omission benchmark, latency and token telemetry, provider-cache comparison, no credentials or private prompts, and an explicit keep/revert decision.

## Rejected actions

- No full repository merge, skill installation, dependency install, package upgrade, API call, proxy launch, code execution, credential use, account creation, publication, or spending.
- No replacement of Pine Star objectives, router, roles, reports, audit, authentication, approval, cancellation, E-stop, recurring work, Morning Brief, or Night Shift.
- No autonomous dependency upgrade or self-modification authority.

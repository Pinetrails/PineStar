# Business system direction

Pine Star should become useful and economically sustainable: **useful output + sustainable net income - unnecessary cost**. Safety, legality, privacy, user authority, and truthful reporting take priority.

## Future measurement

- Revenue and expenses.
- Provider/API, compute, and tool costs.
- Product and experiment outcomes.
- Agent usefulness and quality.
- Wasted work and return on effort.
- Social/store activity and pipeline progress.

Metrics must identify source, period, and uncertainty. Activity is not value.

Planned concepts include digital products, commerce, Pine Trail Printables/social, growth experiments, finance, an Idea Lab, performance tiers, champion/challenger evaluation, and Economy/Balanced/Deep model-use policies. Preserve lessons when weak configurations are retrained or retired.

## Implemented foundation

`PS-2026-018` adds durable digital-product project records in `pine-star.product-projects.json`. These are coordination records, not another task engine: linked objective IDs point to the existing objective lifecycle and linked report IDs point to existing shared evidence. The record exposes current linked-objective status without copying transcripts or result payloads.

The deterministic workflow is `idea → research → planned → production → qa → listing_ready → approval_required → published`, with explicit safe return paths and archival. Listing readiness requires passed QA. The authenticated safe-update API cannot transition into `published`; a future legitimate approval seam must call the internal approved transition explicitly. Unknown estimated/actual costs and revenue remain `null`, while spending authority is always `$0`.

`PS-2026-019` adds Product Idea / Idea Lab intake without a second task engine. A stable idea ID creates or reuses the product project, a Coordinator-owned parent objective, a Researcher market-validation objective, and a dependent Idea Lab concept-brief objective. A deterministic shared intake report links the project and objective graph for later Morning Brief and research use. Intake only records and routes work; normal admission, activation, cancellation, E-stop, settlement, and audit controls still own execution.

`PS-2026-021` closes the research decision gate. An authenticated decision must name completed linked Researcher and Idea Lab objectives and at least one evidence reference. It creates one idempotent shared report. `go` may advance `research → planned`; `revise` and `stop` leave the project in research with explicit blockers and no production activity. Morning Brief projects the bounded decision and next action from the existing shared-report store.

`PS-2026-022` plans production without duplicating StarNet's Workshop deliverable store, filesystem trust, or provenance. It records expected deliverable names on the product project, creates Product Designer specification/preparation objectives, and gates an independent Quality Reviewer objective on completed preparation. The workflow never claims an artifact exists; production objectives must cite real existing artifact evidence.

`PS-2026-023` finalizes QA only when the linked Quality Reviewer objective is complete and both named Workshop deliverables and shared reports exist. Failed QA holds production with blockers. Passed QA moves through the existing QA gate to `listing_ready` and stores bounded internal title, description, tags, SEO keywords, and marketplace targets. It does not publish or create marketplace state; `publicationState` remains `not_published` and the safe update API still rejects `published`.

`PS-2026-024` adds `pine-star.business-records.json` as a durable fact ledger. Commerce rows are project-linked references to planned, draft, approval-waiting, evidenced observed-publication, or archived marketplace state; writing one never performs a marketplace action. Financial rows are immutable, idempotent USD revenue, expense, or refund observations that require an amount, source, occurrence time, and evidence references. Period summaries compute only from those recorded entries, and Morning Brief retains their provenance. These APIs do not pay, refund, publish, create accounts, store credentials, or authorize spending.

`PS-2026-025` adds bounded growth experiments without a second experiment store. A listing-ready or later product can create a stable shared plan report and directly assigned economy-tier Growth Analyst objective. Results require that linked objective to be completed plus an observed value, positive sample size, outcome, and evidence references. Stable IDs reject changed plans or observations. Result reports flow into Business Morning Brief, but neither planning nor result recording performs advertising, outreach, publication, account creation, spending, or automatic scaling.

`PS-2026-026` adds a Pine Trail Printables intake preset, not a parallel product system. Supported families are planner, checklist, tracker, activity sheet, and bundle. The preset namespaces stable product IDs and adds original Pine Trail-owned asset, print-safe margin/contrast, editable-source plus PDF, and US Letter/A4 requirements before delegating to the existing Product Idea intake. All normal project, objective, specialist-routing, report, authentication, cancellation, E-stop, and audit controls remain authoritative.

`PS-2026-027` adds a pure product-portfolio snapshot to Business Morning Brief. It derives total and per-stage counts, listing readiness, protected approvals, failed QA, blockers, and evidenced observed-publication counts from existing product and commerce records. It contributes bounded attention items, next actions, and record references to the shared report. It creates no store, task, model call, publication, approval grant, payment, or external mutation.

`PS-2026-028` projects product readiness into the existing Reports UI. A read-only portfolio card shows per-stage, failed-QA, blocker, and evidenced observed-publication counts. Existing product cards now show listing state, marketplace targets, blockers, and evidence references in addition to objective progress and next actions. The UI only calls existing authenticated GET routes and contains no product, approval, publication, payment, execution, or edit control.

`PS-2026-029` adds commerce and financial inspection to Reports through the existing authenticated GET routes. Commerce cards show escaped project, marketplace, external listing reference, and evidence values as text only. The ledger section shows recorded all-time revenue, expense, refund, net, and entry totals plus source/project/evidence entry cards. It contains no external link, payment, refund, purchase, publication, or edit control.

`PS-2026-030` extends the Pine Trail preset through the existing production planner after evidence-backed research reaches `planned`. It derives family-specific editable source, US Letter PDF, A4 PDF, and optional bundle manifest expectations; supplies original-asset, clipping, legibility, margin, and no-StarNet/commercial-game-art QA checks; and delegates to existing Product Designer preparation and independent Quality Reviewer objectives. Real artifacts still require Workshop/file provenance, and the preset cannot publish, create accounts, purchase, subscribe, or spend.

`PS-2026-031` adds a user-initiated local business snapshot to Reports. Its versioned JSON contract projects only allowlisted product-readiness, commerce-reference, and evidence-backed ledger fields from the existing authenticated reads. Unknown fields—including credential-like test fields—are omitted. The bundle names no destination and records that no external write occurred; there is no automatic trigger, sync, upload, publication, payment, account, or spending path.

`PS-2026-032` derives product contribution from the existing immutable ledger. Each period summary groups only entries with a product-project link into deterministic revenue, expense, refund, and net totals. The portfolio accepts those bounded facts only for known products, carries ledger provenance, adds a recorded-contribution decision, and raises negative recorded contribution as an attention item in Business Morning Brief. It does not estimate missing costs, claim profit or ROI, mutate records, initiate financial activity, or create another store.

`PS-2026-033` projects that evidence-only contribution into the existing Reports portfolio card. It shows recorded net and evidence-entry counts only for currently known products, excludes unmatched identifiers, and visibly states that missing costs are not estimated. The view remains read-only and reuses authenticated data already loaded for the portfolio and ledger.

`PS-2026-034` makes unallocated ledger evidence visible in Business Morning Brief. When a period contains entries without a product-project link, the brief adds a bounded exception and asks for evidence review while explicitly refusing to infer a link. The immutable ledger remains unchanged.

`PS-2026-035` closes a production evidence gap in QA. A passed decision must supply an exact mapping from every expected project deliverable to an existing kept or implemented Workshop artifact; missing, extra, or unverified coverage is rejected. The bounded mapping survives the shared-report projection so later audits can reconstruct which artifact supported each deliverable. Failed QA can still record partial evidence without pretending the complete set exists.

`PS-2026-036` renders the shared QA report's expected-deliverable-to-artifact mapping in Reports. Values are escaped and read-only; the projection adds no artifact operation, navigation, approval, execution, or publication control.

`PS-2026-037` adds the request side of the protected publication boundary. A listing-ready, QA-passed product may request review only by citing a linked product QA report whose coverage includes every expected deliverable and naming target marketplaces. Pine Star creates a shared request report and an unassigned protected objective in `approval_required`, then moves the project to the same truthful waiting state. The generic update API can no longer make that transition. There is deliberately no grant, execution, account, credential, marketplace-write, or publication implementation.

`PS-2026-038` adds withdrawal, not approval. An authenticated caller may withdraw only the matching still-waiting protected request. The objective becomes `cancelled`, its approval state becomes `withdrawn`, and an `approval_withdrawn` audit event plus a shared withdrawal report preserve history. The product returns to `listing_ready` through a private workflow option; generic project updates cannot perform that transition. Repeated withdrawal is idempotent, while nonprotected or no-longer-pending objectives are refused.

`PS-2026-039` makes withdrawn request identity terminal. Reusing its stable ID is refused before any report, objective, or project mutation; a materially revised review must use a new stable request ID and creates new protected stopped work. Withdrawal also restores `publicationState: not_published`, so the project record no longer claims that a review remains pending. Neither path grants approval or performs publication.

`PS-2026-040` enforces one pending publication review per product. A different stable request ID is refused while protected review work already waits. Withdrawal checks for any legacy concurrent pending review after cancellation; when one exists, the project stays in `approval_required` and the response identifies the remaining objective rather than falsely claiming listing readiness. The last withdrawal restores the normal internal state without approving or publishing anything.

External spending authority defaults to `$0`. No real-money trading, purchase, subscription, or financial commitment may be implemented or executed without explicit approval. Future paper trading must be clearly labeled and isolated from real money.

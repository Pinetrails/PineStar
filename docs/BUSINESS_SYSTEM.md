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

External spending authority defaults to `$0`. No real-money trading, purchase, subscription, or financial commitment may be implemented or executed without explicit approval. Future paper trading must be clearly labeled and isolated from real money.

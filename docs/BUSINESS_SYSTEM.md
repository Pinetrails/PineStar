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

External spending authority defaults to `$0`. No real-money trading, purchase, subscription, or financial commitment may be implemented or executed without explicit approval. Future paper trading must be clearly labeled and isolated from real money.

# Agent Note: Magpie discovers Responses capabilities and site prices

Status: implemented

## Problem

Magpie imports Relay as a custom Responses provider and reads the ordinary `/v1/models` list. That list previously exposed only model IDs while richer capabilities were available only with Codex's `client_version` query parameter. Magpie could then borrow facts and public prices for a similarly named model instead of the model's actual route. The request detail cost table also still treated input as cache-inclusive and reasoning as a separate billable category, contradicting the server's disjoint Magpie buckets.

## Decision

Enrich the existing authorized OpenAI model list using the same trusted capability index as the Codex catalog. Publish `context_length`, `max_output_tokens`, modalities, reasoning levels and Responses endpoint declarations. Aliases keep their own display names but inherit capabilities and prices from their resolved route. Unknown facts remain absent. Publish `magpie_price` in USD per million tokens using the existing effective price snapshot, including explicit context tiers; the server continues to calculate the final bill using actual request dimensions and the served model.

The frontend renders disjoint cost rows: uncached input, cache reads, cache writes split by TTL, and output including reasoning. Stored rates already include multipliers. The 1-hour cache-write price is read from the existing log field; no schema or new pricing store is needed. Requested, routed, returned and priced models remain visible through existing request detail sections.

## Alternatives considered

Putting a fixed model list in the import URL would become stale and duplicate live key policy. Adding another discovery endpoint would require bespoke Magpie support while its existing parser already accepts these fields. Reconstructing cost rows by subtracting cached input or adding reasoning would disagree with server settlement. Treating Magpie's local estimate as the invoice would ignore request-specific rules, actual service tier and served-model pricing.

## Consequences

Catalog ETags include the enriched payload, so changed capabilities or prices invalidate ordinary list caches. Magpie can estimate default text-token costs using station rates and explicit context tiers. The final settled log remains authoritative for dimension-dependent or modality-specific charges. Contract tests cover authorized aliases, missing facts, currency conversion and tiers; the actual Magpie catalog parser was also exercised against a generated Relay response during implementation.

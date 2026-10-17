# ADR-006: On-chain Event Indexer Architecture

**Date:** 2026-10-17
**Status:** Proposed
**Deciders:** Core team
**Related:** [ADR-010](010-indexer-architecture.md), TransactionLog

## Context

`TransactionLog` only records actions the backend itself initiates. State changes made directly on-chain (another client, wallet, or contract call) are invisible to the API. We need an indexer over all five Soroban contracts (NFT/Song, Artist, Catalog, Royalty, Marketplace) that brings those events into a queryable store without inventing a second source of truth for backend-initiated actions.

## Decision

Implement a **polling indexer** with **per-contract+network cursors**, writing into `indexed_events` / projection tables, and treat `TransactionLog` as the audit trail of *backend-initiated* work only (reconciled, not replaced).

### Polling vs streaming

| Option | Why chosen / rejected |
| ------ | --------------------- |
| Horizon/Soroban RPC polling with cursors | **Chosen** — matches existing `SorobanService`, survives reconnects, easy backfill/replay |
| Websocket / streaming subscription | Rejected for v1 — harder to resume across deploys, more moving parts under k8s |
| Subgraph-only | Rejected as sole source — we still need deterministic local cursors and offline replay |

### Per-contract cursors

- One cursor row per `(contract, network)` in `indexer_cursors` (see ADR-010).
- Cursors advance only after events for that ledger are persisted.
- Reorg/backfill: reset cursor to a ledger and re-decode via `eventDecoders`.

### Relation to TransactionLog

- `TransactionLog`: backend-initiated actions (API → chain), with request IDs.
- `indexed_events`: observed chain state (any source).
- Reconciliation job compares both where a backend action should have produced a chain event; it does not delete either side.

## Consequences

### Positive

- API sees direct on-chain changes
- Per-contract cursors allow independent backfill
- TransactionLog stays a clean audit of our writes

### Negative / trade-offs

- Polling adds RPC cost and up-to-block latency
- Two related stores must stay conceptually distinct

### Neutral

- Implementation details live in ADR-010 / `docs/INDEXER_GUIDE.md`

## Alternatives considered

| Option | Why rejected |
| ------ | ------------ |
| Streaming subscriptions | Operational complexity for resume/replay |
| Dual-write only (no indexer) | Cannot see external client transactions |

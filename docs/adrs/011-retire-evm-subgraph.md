# ADR-011: Retire the EVM Subgraph

**Date:** 2026-10-18
**Status:** Accepted
**Deciders:** Backend team
**Related issues:** #836
**Supersedes:** Parts of [ADR-009](009-graphql-query-layer-spike.md) that proposed The Graph as a query layer

---

## Context

The repository ships a full [The Graph](https://thegraph.com/) EVM subgraph:

| Artifact | Description |
|---|---|
| `subgraph/` | AssemblyScript mappings, Diamond facet ABIs, schema, manifest, deploy scripts, tests |
| `docker-compose.graph.yml` | Local Graph Node stack (IPFS + postgres + graph-node) |
| `.github/workflows/subgraph-deploy-main.yml` | Auto-deploys the subgraph on every push to `main` |
| `.github/workflows/subgraph-validate-pr.yml` | Builds and validates the subgraph on every PR |
| `src/services/SubgraphQueryService.ts` | 848-line service querying The Graph's GraphQL endpoint |
| `src/routes/subgraphRoutes.ts` + `src/controllers/SubgraphController.ts` | REST endpoints at `/api/subgraph/*` |

**The Graph indexes EVM chains.** The `subgraph.yaml` manifest declares
`kind: ethereum / network: stellar` — an EVM-flavoured adapter that was never
a first-class fit for Soroban's event model.

Since [ADR-010](010-indexer-architecture.md), on-chain data is indexed by the
**Soroban indexer** (`src/workers/indexer/`), which polls Soroban RPC directly
and writes raw events into `indexed_events`. Event projections build the read
models. `SubgraphQueryService` already has an RPC fallback path via
`IndexedEventService` — meaning the Soroban indexer already delivers what the
subgraph was supposed to deliver.

**Frontend usage search:** Both frontend repositories (`AudioBlock_ListenerApp`
and `AudioBlock_ArtistDashboard`) were searched for calls to `/api/subgraph/*`.
**No calls were found.** The endpoints have never been consumed in production.

Keeping both paths adds:
- CI time on every push/PR (two extra jobs)
- Contributor confusion (two parallel query paths, neither clearly canonical)
- A second, non-native source of truth for on-chain data
- Secret rotation overhead (`GRAPH_DEPLOY_TOKEN_TESTNET/MAINNET`)

---

## Decision

**Retire the EVM subgraph entirely.**

Remove all subgraph artifacts, the Graph Node compose file, both CI workflows,
`SubgraphQueryService`, `SubgraphController`, the `/api/subgraph/*` routes, and
all related documentation.

The Soroban indexer (`src/workers/indexer/`) is the sole on-chain data source
going forward.

No frontend calls `/api/subgraph/*`, so no migration or replacement endpoint is
required before removal.

---

## Consequences

**Positive**
- ~500 lines of service/controller/route code deleted
- Two CI jobs removed (faster CI for all contributors)
- Single source of truth: Soroban indexer
- `GRAPH_SUBGRAPH_*` / `SUBGRAPH_*` env vars removed from `.env.example`
- No more deploy tokens to rotate

**Negative / trade-offs**
- Historical EVM-indexed data (if any existed on The Graph hosted service) is no
  longer queryable via this backend; no migration path is provided because no
  active deployment was confirmed
- The subgraph code is no longer in the working tree; it can be recovered from
  git history if needed

**Neutral**
- `IndexedEventService` and the Soroban indexer are unchanged
- `docker-compose.graph.yml` used an opt-in `--profile graph` flag; removing it
  has no effect on the default development stack

---

## Alternatives considered

| Option | Why rejected |
|---|---|
| Freeze as legacy (read-only, disable deploy CI) | No frontend calls the endpoints; freezing keeps dead code and maintenance burden with no consumer benefit |
| Keep subgraph, disable only the deploy CI job | AssemblyScript mappings still need updating against a Soroban chain — ongoing burden with no payoff |
| Migrate subgraph to a Soroban-native indexer | The Soroban indexer already does this; duplication is not justified |

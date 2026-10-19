# Staging and production parity audit

Audit date: 2026-10-18. Repository baseline: `0147b87`.
Scope: tracked configuration only. No live staging/production manifests,
secret-store inventories or cloud resource exports were supplied. This audit
does not certify deployed parity. Issue #374 needs the operator evidence below
before closure. Never put secret values in this document or CI artifacts.

## Observed baseline and gap disposition

| Area | Tracked production configuration | Staging evidence / disposition |
| --- | --- | --- |
| Deployment | `docker-compose.yml` + explicit `docker-compose.prod.yml`; no deployment workflow in `.github/workflows` | No staging overlay or deployed export. Open: infrastructure owner must supply both effective manifests, release digests and service inventory. Development overlays are not staging evidence. |
| Runtime | Dockerfile uses Node 20 Alpine; Postgres 15 Alpine, Redis 7 Alpine, RabbitMQ 3 management in base Compose | Open: compare actual image digests and patch versions. Floating tags do not guarantee the same image. |
| Reproducible install | Local `npm ci --ignore-scripts` failed: lockfile missing `zod@3.25.76`; installed host Node 20.20.0 also triggered the Stellar SDK's Node >=22 engine warning | Open: reconcile the dependency lock and runtime in a reviewed dependency change before claiming reproducible staging/production builds. No lockfile changes made in this audit. |
| Build gate | `tsc --noEmit` reports existing syntax errors in `AccountTypeService`, `PrivyAuthenticationMethods`, `RBACMiddleware` and `WebhookAuthMethods` test files, which are included by `tsconfig.json` | Open: repair those tests in a separate change before certifying that the Docker build can produce an artifact. |
| Environment | `.env.docker` referenced but not tracked; `.env.example`, `src/config/env.ts` and `docs/environment-variables.md` describe the contract | Open: compare key presence, non-secret settings and secret references in both deployments. Do not export raw environments into logs. |
| Sizing | Production limits: backend and DB 0.50 CPU/512M each; Redis and RabbitMQ 0.25 CPU/256M each | Open: obtain staging/production replicas, requests/limits, DB pool/connection ceilings and storage sizing. Lower staging capacity is acceptable only with a recorded load-test plan. |
| Feature flags | Runtime configuration in `src/config/authFlags.ts`, AI and indexer settings in `.env.example` | Open: compare actual auth modes, AI provider, indexer/projector flags, retries, timeouts, cache TTLs, rate limits and prefetch. Mock providers cannot validate production integrations. |
| Data/services | Separate Postgres, Redis, RabbitMQ, S3, Pinata and chain configuration | Required intentional difference: isolated credentials, buckets, vhosts, databases, signing accounts and test network. Match service behavior/topology; never share production write credentials with staging. Actual isolation still needs verification. |
| Storage | Backend bind-mounts repo and `uploads`; DB/Redis/broker use local named volumes inherited from base | Open: production overlay retains development bind mounts and local volumes. Owner must verify deployed packaging, upload sharing, persistence, backup/restore and regional recovery. Not justified as production architecture by this audit. |
| Networking/security | Explicit production CORS required; base publishes DB/Redis/broker ports with development defaults; DB client sets `ssl: false`, Redis TLS is commented out | Open: verify private networking, real credentials, TLS and ingress at deployment. Do not adopt the sample defaults on a public host. |
| Worker topology | API starts song and Redis job consumers; standalone song command now bootstraps DB/broker; no song-worker Compose service | Closed in code: standalone startup and bounded prefetch. Open operational gap: compare consumer counts, shared upload storage and supervision in both environments. |
| Observability | Compose monitoring profiles and health routes exist; indexer is a separate profiled service | Open: compare enabled profiles, metrics, alert routing, retention and synthetic upload/playback checks. |

These open gaps are not approved exceptions. No live deployment changes were
made without deployment evidence. Repository checks catch contract drift but
cannot establish matching runtime values or resource sizes.

## Operator parity checklist

Use the same immutable application image and explicit production-style config
for staging. For Compose, specify files explicitly so the automatic development
override is not included:

```bash
docker compose -f docker-compose.yml -f docker-compose.prod.yml --profile full config --quiet
npm run compose:check
npm run env:check
```

The validation command requires the deployment's env file. It does not deploy.
Full rendered Compose config may contain secrets: compare it locally in a
restricted workspace and publish only a redacted summary. Base bind mounts and
sample credentials must be replaced by the deployment owner before real use.

- [ ] Record both release digests, deployment revisions, platform and region.
- [ ] Compare service versions, enabled profiles, worker commands and replicas.
- [ ] Compare env **key sets** against the reference and runtime readers. Compare
      approved non-secret values separately; verify secrets exist, rotate, and
      grant equivalent permissions without comparing or publishing their values.
- [ ] Verify `NODE_ENV=production` in both environments, migrations match, and
      schema synchronization is disabled. The DB config synchronizes schema in
      every other mode; `NODE_ENV=staging` is not equivalent to production.
- [ ] Compare auth flags, JWT policy, CORS behavior, AI/provider behavior,
      indexer/projector settings and network-specific contract references.
- [ ] Compare CPU/memory, connection budgets, storage class/size, persistence,
      RabbitMQ queue policies, prefetch and worker upload mounts.
- [ ] Verify separate service identities, domains, buckets, databases, broker
      vhosts, Redis instances, chain networks/accounts and external webhooks.
- [ ] Exercise migrations, auth, upload, scan, HLS playback, queue retry/failure,
      provider integration and recovery against isolated staging data.
- [ ] Verify logs, health probes, metrics, alerts, backups and rollback.
- [ ] Close each mismatch or approve a time-bound exception below. Attach
      sanitized evidence, verifier and date; require independent sign-off.

## Exceptions and continuing synchronization

Expected candidates include staging domains/CORS allowlists, testnet contract
addresses, isolated secrets/storage and smaller capacity. Each must still be
verified. Smaller capacity must preserve topology and have representative load
testing before release. No actual exception is approved yet.

| Difference | Reason and risk | Owner | Evidence | Approver | Review/expiry |
| --- | --- | --- | --- | --- | --- |
| Pending runtime inventory | Deployed configuration unavailable | Infrastructure maintainer (assignment pending) | Required | Pending | Before #374 closes |

For every config, dependency, flag or sizing PR, the author updates the shared
configuration contract and this checklist, then stages the same artifact before
production promotion. CI already runs `compose:check` and `env:check`; these are
structural checks, not a runtime parity certification. The release operator
compares sanitized effective deployments and records justified differences in
the release review. Block promotion on unexplained differences. An independent
maintainer signs the comparison. Roll back by redeploying the previous image and
configuration together after checking migration compatibility.

Monthly and after emergency production changes, the infrastructure owner repeats
the comparison and reconciles staging through a reviewed configuration change.
Assign an owner and expiry to every exception; expired exceptions block the next
release until resolved or explicitly renewed. Keep secret values in the secret
manager and record only references/presence in the audit.

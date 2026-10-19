# Disaster recovery

Owner: infrastructure on-call, with the database and application maintainers.
Scope: loss of PostgreSQL, S3, Redis, RabbitMQ, or the primary region.
Baseline inspected: repository revision `0147b87`, 2026-10-18.

## Recovery objectives and prerequisites

RTO is elapsed time from incident declaration to verified service restoration.
RPO is the maximum acceptable age of recovered data. These are **proposed
operational targets**, not measured guarantees or evidence that backups exist.
The incident commander records actual recovery time and data loss separately.

| Dependency | RTO target | RPO target | Required protection |
| --- | --- | --- | --- |
| PostgreSQL | 4 hours | 15 minutes | Off-region base backups plus archived WAL/PITR; quarterly restore drill |
| S3 | 4 hours | 15 minutes | Versioning plus independent off-region copy, including originals, covers and HLS; replication-lag alert |
| Redis | 1 hour | 15 minutes for jobs; cache may be rebuilt | Off-region persistence backups; reconcile queued/in-flight jobs |
| RabbitMQ | 1 hour | 15 minutes | Broker data backups plus definitions and an application replay ledger |
| Full region | 8 hours | 15 minutes across durable dependencies | Recoverable secrets/KMS, artifacts, DNS access and capacity in a second region |

Current limitations: Compose volumes survive container replacement only, not host
or region loss. `scripts/backup.sh` produces a local compressed SQL dump and
checksum; it does not schedule backups, archive WAL, or copy off-site. It uses
`DB_*`, while the app uses `POSTGRES_*`; explicitly map the connection settings.
The script lacks `pipefail`: a checksum alone does not prove a successful dump.
No S3 replication, Redis persistence policy, RabbitMQ backup schedule, or PITR
configuration is established by this repository. Until operators supply and
test those controls, the RPO is the last verified backup (possibly all data).
RabbitMQ publishers do not consistently request persistent messages or publisher
confirms; durable queues alone cannot meet the target.

Before adopting this runbook, the infrastructure owner records in the restricted
operations inventory: account/region, dependency versions and endpoints, backup
locations and timestamps, retention, encryption keys, restore role, DNS zone,
artifact digest, secret-store references and escalation contacts. Store no secret
values here. Keep this inventory and recovery credentials accessible outside the
primary region. Test access and restoration quarterly and after storage changes.

## Incident control and recovery order

1. Declare an incident; appoint a commander, recovery operator and independent
   verifier. Record UTC timestamps, affected services, last good deploy and last
   verified backups. Notify stakeholders through the team's incident channel.
2. Stop ingress for writes/uploads and stop API, song workers, Redis job workers,
   indexers and scheduled jobs. The API starts consumers automatically. Fence the
   old region from writes and signing before enabling any replacement writers.
3. Preserve failing volumes, logs and snapshots. Restore into **new, isolated**
   resources. Do not delete the old resources or overwrite the only good backup.
4. For region loss, provision networking, firewall rules, IAM, KMS access, secrets,
   matching service versions and the last known good application image first.
   Recover DB and S3, then Redis and RabbitMQ. Restore shared `uploads` storage;
   workers require `uploads/merged/<fileId>.mp3`, not just an S3 URL.
5. Choose a common recovery cutoff. Inventory records, objects, jobs and on-chain
   effects after that cutoff; reconcile them before restarting consumers. An
   on-chain mint or payout cannot be rolled back by restoring the database.

## PostgreSQL loss

1. Verify the backup timestamp, checksum, decryption access, source database and
   server major version. For corruption, select a point before corruption began.
   Prefer the provider's tested PITR procedure into a new instance when available.
2. For a verified plain SQL gzip dump, run the following in a trusted Bash shell
   with PostgreSQL client tools. `PG*` variables refer exclusively to the new
   recovery instance; supply its password through a secret mechanism.

   ```bash
   set -euo pipefail
   sha256sum -c "$BACKUP_FILE.sha256"
   gzip -t "$BACKUP_FILE"
   # Create a fresh, empty target database first; never point this at production.
   createdb "$RECOVERY_DB"
   gzip -dc "$BACKUP_FILE" | psql -X -v ON_ERROR_STOP=1 -d "$RECOVERY_DB"
   psql -X -v ON_ERROR_STOP=1 -d "$RECOVERY_DB" -c 'SELECT count(*) FROM songs;'
   psql -X -v ON_ERROR_STOP=1 -d "$RECOVERY_DB" -c 'SELECT * FROM migrations ORDER BY id DESC LIMIT 5;'
   ```

3. Validate users, songs, versions, payout/transaction records and indexer cursors
   against the backup manifest and known records. Check foreign keys and sample
   reads with the application release that produced the backup.
4. Set `POSTGRES_HOST`, `POSTGRES_PORT`, `POSTGRES_USER`, `POSTGRES_PASSWORD`,
   `POSTGRES_DATABASE` to the new instance. Use `NODE_ENV=production` to prevent
   TypeORM automatic schema synchronization. Do not run seeders against a partial
   restore. Review any required migration before `npm run migration:run` using
   the matching built artifact.
5. Reconcile chain state before replaying mint/payout jobs. For indexer gaps use
   [the resync runbook](../indexer-resync-runbook.md) and
   [the backfill runbook](../indexer-backfill-runbook.md).

## S3 bucket or region loss

1. Stop uploads, lifecycle deletion and consumers. Capture bucket configuration,
   version inventory, replication status, last copy time and the DB cutoff.
2. Recover deleted/overwritten objects from verified versions, or restore the
   independent copy into a replacement bucket in the recovery region. Preserve
   object keys, content types, metadata and encryption access. Do not run a mirror
   command with deletion enabled against the backup.
3. Restore bucket policy, application IAM, KMS grants, CORS and lifecycle rules
   from the operations inventory. Check that originals needed to regenerate HLS
   have not expired. Validate object counts, sizes and stored checksums against
   the inventory; ETags are not universally content hashes.
4. Set `AWS_REGION` and `AWS_BUCKET_NAME` and rotate/regrant credentials as needed.
   Updating env vars does **not** rewrite stored absolute URLs: audit
   `s3OriginalUrl`, `hlsMasterUrl`, cover URLs, song versions, cached manifests and
   IPFS/on-chain metadata. Prepare and review a targeted URL migration for mutable
   DB references; immutable metadata may require continued access to the original
   location or a separate remediation. Do not declare playback restored until
   those references resolve.
5. Verify a cover, an original, every segment of a sample playlist and a fresh
   presigned playback request. Rebuild missing HLS only after checking whether
   the song was already minted; the worker also mints and is not a safe generic
   HLS rebuild tool. Rehydrate missing merged files using a verified mapping from
   original object to `fileId`; there is no automatic rehydration command.

## Redis loss

1. Stop all clients that enqueue/dequeue jobs. Redis contains durable business
   jobs as well as caches and rate limits: never treat the whole store as cache.
2. Restore the latest verified RDB/AOF backup into an isolated, version-compatible
   instance using the chosen Redis deployment's restore procedure. Restore its
   ACLs and persistence configuration; validate startup logs and `PING`.
3. Check `jobs:queue:critical`, `jobs:queue:normal`, `jobs:queue:low`,
   `jobs:record:*`, `jobs:dlq` and `jobs:stats`. Use `SCAN` for large keyspaces.
   Compare pending/processing records to actual completed business operations.
   A popped in-flight job may no longer be in a list. Re-enqueue only after
   verifying that its external effect did not already occur; preserve a replay
   ledger and original job IDs for operator review.
4. If no backup exists, provision an empty instance and explicitly account for
   lost jobs. Rebuild each job from the authoritative DB/chain/provider records
   after reconciliation. Authentication/revocation and rate-limit state may also
   be lost: review affected keys and invalidate affected sessions as appropriate.
5. Update `REDIS_HOST`, `REDIS_PORT`, `REDIS_USERNAME`, `REDIS_PASSWORD`. The current
   client has TLS commented out; a TLS-only replacement needs a client change
   before cutover. Let caches warm naturally and watch DB load; do not issue a
   blanket `FLUSHALL` against recovered job state.

## RabbitMQ loss

1. Stop publishers and consumers. Record queue depths, consumer counts, broker
   version, vhost, policies, definitions backup and broker data backup timestamps.
2. Prefer restoration through the broker platform's tested data recovery process,
   preserving the required node identity/version and data permissions. Restore
   users, vhosts, permissions, exchanges, bindings and policies. Definitions alone
   restore topology, **not messages**. Verify `song_processing` and
   `song_processing_dlq` are durable.
3. If creating a fresh broker, inventory lost jobs against DB, upload records and
   chain state. Queue payloads contain `{songId, fileId, attempt?}`; recovering a
   `fileId` from song ID alone is not guaranteed. Restore the matching merged
   audio before publishing a reviewed replay list. Record unresolvable uploads
   for user re-upload; never replay all songs indiscriminately.
4. The code declares a DLQ but no dead-letter exchange/binding. Without an
   operator policy, rejected messages are dropped. Verify actual broker policies;
   preserve failed payloads externally before retries. Retry message TTL is not
   a delayed retry scheduler, and there are no publisher confirms.
5. Update `RABBITMQ_URL`, validate credentials/TLS and start one canary consumer.
   Check successful processing before adding others. Restart worker processes
   after broker reconnection: the connection helper recreates a channel but does
   not automatically register the consumer on that new channel.

## Validation, cutover and rollback

1. Independently verify recovery timestamps meet the declared cutoff and record
   any loss exceeding the target. Check DB counts, S3 samples, Redis job counts,
   RabbitMQ topology and shared files. Back up the newly recovered state.
2. In an isolated environment, verify login, authorized reads and playback. Use
   test credentials/network for an upload-to-HLS-to-mint drill; never mint or
   pay twice to test recovery. API startup starts workers, so do not use it for
   read-only validation until replay decisions are complete.
3. Enable one API/worker canary, check `/health/ready` and `/health/worker`, error
   logs, queue depth, failed jobs and an end-to-end upload. Worker health is per
   process; the standalone worker has no HTTP listener.
4. After the verifier approves, move DNS/load-balancer traffic and resume writes
   in stages. Keep the old region fenced. Watch errors, latency, job age and DB
   load through a normal traffic cycle.
5. If verification fails before writes resume, stop the canary and retain the
   previous routing. After new writes occur, stop writes and reconcile both
   histories before switching back; do not restore an older snapshot over them.
6. Record actual RTO/RPO, lost/unresolved jobs, backup gaps and follow-up owners
   in the incident report. Test failback as a separate controlled change.

## Independent review and drills

Issue #373 remains pending independent review. The author cannot self-approve.
Ask a maintainer other than the author (the docs CODEOWNER is listed in
`.github/CODEOWNERS`) to walk through an isolated restore and record:

| Reviewer (not author) | Date | PR/review link | Drill evidence and measured RTO/RPO | Decision |
| --- | --- | --- | --- | --- |
| Pending | — | — | — | Not approved |

Quarterly, simulate loss of each dependency and a full region in isolation.
Record backup selection, elapsed restoration time, data cutoff, playback,
job reconciliation, cutover/rollback results and the verifier's sign-off.

# Data Lifecycle & Audit Log Audit

> Covers #341 (soft-delete vs hard-delete) and #342 (admin audit-log completeness).

## Soft-delete vs hard-delete decisions (#341)

### Decision matrix

| Entity | Strategy | Rationale | Code path |
|--------|----------|-----------|-----------|
| **User** | Soft-delete (`deletedAt`) | GDPR right-to-erasure requires anonymisation while preserving referential integrity. `AccountDeletionService` sets `deletedAt`, nulls identifying fields, and schedules full purge. | `AccountDeletionService.ts` |
| **Song** | Hard-delete | Songs are user-created content with no retention requirement. Cascading relations handle cleanup. | `SongService.remove()` → `songRepo.remove()` |
| **Comment** | Hard-delete | Comments are ephemeral; no moderation history requirement. | `CommentService.remove()` → `commentRepo.remove()` |
| **CommentReaction** | Hard-delete | Toggle semantics — removal is the inverse of creation. | `CommentReactionController` → `reactionRepo.remove()` |
| **Playlist** | Hard-delete | User-owned list with no retention requirement. | `PlaylistService.remove()` |
| **PlaylistFollow** | Hard-delete | Toggle semantics. | `PlaylistFollowController` → `repo.remove()` |
| **Save** | Hard-delete | Toggle semantics (save/unsave). | `SaveService.remove()` |
| **WebhookSubscription** | Hard-delete | Config entity; no history needed. | `WebhookService` → `subscriptionRepo.remove()` |
| **TweetDraft** | Hard-delete | Ephemeral draft; discard = delete. | `TweetDraftService` → `draftRepo.remove()` |
| **RoyaltyTemplate** | Hard-delete | Config entity. | `RoyaltyTemplateService` → `templateRepo.remove()` |
| **FanPerk** | Hard-delete | Config entity. | `FanPerkController` → `repo.remove()` |
| **SubscriptionTierConfig** | Hard-delete | Config entity. | `SubscriptionTierConfigController` → `repo.remove()` |

### Findings

- **Consistent**: All entities use hard-delete except `User`, which correctly uses soft-delete with a documented GDPR lifecycle (request → 30-day grace → anonymise → purge).
- **No inconsistency found**: No entity mixes both strategies. No entity hard-deletes where soft-delete is expected.
- **Recommendation**: If content-moderation history is needed for `Comment` or `Song` in the future, switch to soft-delete with a `deletedAt` column and an `isDeleted` filter on queries.

## Admin action audit-log completeness (#342)

### Audit log infrastructure

Two logging mechanisms exist:

1. **`TransactionLog`** (`entities/TransactionLog.ts`) — records on-chain and financial actions (mint, transfer, royalty payout, fund, etc.) with `userId`, `action`, `txHash`, `status`.
2. **`AuthAuditLog`** (`entities/AuthAuditLog.ts`) — records authentication events (login, logout, 2FA enable/disable, password reset).

### Admin action coverage

| Admin action | Route | Logged? | Log type | Actor | Target |
|---|---|---|---|---|---|
| Get transaction logs | `GET /admin/transaction-logs` | ✅ | N/A (read-only) | — | — |
| Get AI usage | `GET /admin/ai/usage` | ✅ | N/A (read-only) | — | — |
| List reports | `GET /admin/reports` | ✅ | N/A (read-only) | — | — |
| Resolve report | `PUT /admin/reports/:id/resolve` | ✅ | `TransactionLog` via `ReportService` | Admin | Report |
| Get jobs | `GET /admin/jobs` | ✅ | N/A (read-only) | — | — |
| Get job by ID | `GET /admin/jobs/:id` | ✅ | N/A (read-only) | — | — |
| Trigger job | `POST /admin/jobs/:id/trigger` | ✅ | `TransactionLog` via `JobController` | Admin | Job |
| Assign role | `PATCH /admin/users/:id/role` | ✅ | `TransactionLog` via `UserService` | Admin | User |
| Ban user | `PATCH /admin/users/:id/ban` | ✅ | `TransactionLog` via `UserService` | Admin | User |
| Moderate song | `PUT /admin/songs/:id/moderate` | ✅ | `TransactionLog` via `SongModerationService` | Admin | Song |
| Approve takedown | `POST /admin/takedowns/:id/approve` | ✅ | `TransactionLog` via `TakedownService` | Admin | TakedownRequest |
| Reject takedown | `POST /admin/takedowns/:id/reject` | ✅ | `TransactionLog` via `TakedownService` | Admin | TakedownRequest |

### Findings

- **All write actions are logged** with actor and target via `TransactionLogService.createLogEntry()`.
- **Read-only actions** (list/get) are not logged — this is acceptable since they don't mutate state.
- **`AuthAuditLog`** covers authentication events separately (login, logout, 2FA).
- **Recommendation**: Consider adding a dedicated `AdminAuditLog` for admin-specific metadata (reason, notes) that doesn't fit `TransactionLog`'s financial-action schema. Current coverage is sufficient for compliance.

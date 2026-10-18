# Migrating Existing Users to Privy

**Status:** Draft — part of the [Privy Authentication (Backend)](https://github.com/AudioBitsStellar/AudioBlock_Backend/issues?q=is%3Aissue+Privy) initiative
**Audience:** backend maintainers executing the migration; support/product staff preparing end-user communications
**Scope:** how accounts, sessions, and login methods that exist today move to Privy-backed authentication without data loss or lockouts

---

## 1. Why migrate

Today AudioBlock Backend implements every login method itself: nonce-challenge wallet
signatures, email + password, email verification, password reset, TOTP 2FA with
recovery codes, refresh-token rotation, and RFC 7662 introspection. Each new method
(login codes, social providers, external wallets, Stellar linking) multiplies
custom crypto and session code that must be maintained and audited.

Privy offloads identity and login-method handling (embedded wallets, email/SMS OTP,
social providers, external wallet connectors) while the backend keeps what is
domain-specific: roles, permissions, profiles, catalog and royalty data.

The migration must therefore:

- preserve every existing account (no re-registration),
- keep authorization decisions (`role` claim, RBAC) local and unchanged,
- run incrementally behind a feature flag, with a working rollback path.

## 2. Current state (legacy auth)

### 2.1 Endpoints (all under `/api/auth`)

| Endpoint                                                           | Purpose                                            |
| ------------------------------------------------------------------ | -------------------------------------------------- |
| `GET /nonce/:email`                                                | Nonce challenge for wallet-signature login         |
| `POST /register`, `POST /register-listener`                        | Registration with wallet signature + email         |
| `POST /login`                                                      | Wallet-signature login (nonce + signature)         |
| `POST /register-email`, `POST /login-email`                        | Email + password registration/login                |
| `POST /refresh`, `POST /logout`                                    | Refresh-token rotation and revocation              |
| `POST /introspect`                                                 | RFC 7662 token introspection for internal services |
| `POST /2fa/enable`, `/2fa/verify`, `/2fa/disable`, `/2fa/validate` | Local TOTP 2FA (otplib) with recovery codes        |
| `GET /verify-email/:token`                                         | Email verification                                 |
| `POST /forgot-password`, `POST /reset-password/:token`             | Password reset                                     |

### 2.2 Token model

- **Access token:** HS256 JWT signed with `JWT_SECRET`, 15-minute expiry. Claims:
  `id`, `dynamixUserId`, `email`, `walletAddress`, `stellarPublicKey`, `role`,
  `username`, `profileImage`, `name`, counters, `emailVerified`.
  See `AuthService.signToken` (`src/services/AuthService.ts`).
- **Refresh token:** JWT signed with `REFRESH_TOKEN_SECRET` (falls back to
  `JWT_SECRET`), 7-day expiry, persisted per-row in `refresh_tokens` with rotation
  and reuse detection (`revoked`, `familyId`).
- **Authorization:** `requireAuth`, `authArtistMiddleware`, `requirePermission`
  decode the access token only; `role` drives all RBAC decisions.
- **Introspection:** `POST /api/auth/introspect` validates tokens for internal
  consumers (see `docs/TOKEN_INTROSPECTION.md`).

### 2.3 User model (`users` table, `src/entities/User.ts`)

Identity-relevant columns: `email` (unique), `username` (unique),
`passwordHash`, `walletAddress` (unique), `stellarPublicKey` (unique),
`dynamixUserId`, `role` (`listener | artist | moderator | admin | super_admin`),
`twoFactorEnabled` + TOTP secret/recovery codes, `emailVerified` +
verification token/expiry.

### 2.4 External dependency

Dynamic Labs (`DYNAMIC_AUTH_TOKEN`, `DYNAMIC_ENVIRONMENT_ID`) powers wallet
connections today; Privy embedded wallets and external connectors (#613, #614)
are the replacement path.

## 3. Target state and how it maps to the roadmap

| Legacy concern                            | Privy-backed replacement                                                             | Tracking issue         |
| ----------------------------------------- | ------------------------------------------------------------------------------------ | ---------------------- |
| Manual HS256 token code                   | Privy server SDK + base config                                                       | #594, #596             |
| `JWT_SECRET` only                         | App ID, App Secret, JWT verification key in env                                      | #595                   |
| Backend-issued tokens for new logins      | Privy access-token verification (ES256, `iss=privy.io`, `aud` = App ID, `sid` claim) | #598                   |
| `requireAuth` decoding HS256              | Middleware verifying Privy tokens on protected routes                                | #597                   |
| One `users` row keyed by email/wallet     | `privy_user_id` column, linked wallet column                                         | #600, #601             |
| First-login account creation/linking      | Sync/create local user on first Privy login                                          | #602, #605             |
| Profile/wallet changes pushed from client | Webhooks: `user.created`, `user.updated`, `user.linked_account` (signature-verified) | #603, #604, #605, #606 |
| Nonce + signature wallet login            | Embedded/external wallets via Privy                                                  | #613, #614             |
| Custom email/password only                | Email/SMS OTP and social providers                                                   | #610, #611             |
| Local TOTP 2FA                            | Privy MFA                                                                            | #639                   |
| RBAC                                      | Unchanged locally, resolved from Privy identity                                      | #615                   |
| All-or-nothing cutover                    | Feature flag toggling legacy vs Privy auth                                           | #636                   |
| Failure modes                             | Malformed-token handling, key caching, downtime fallback                             | #624, #634, #635       |
| Confidence in behavior                    | Middleware unit tests, this guide, README setup                                      | #621, #637, #626       |

**Stays local (not migrated):** roles and permissions, profile/catalog/royalty
data, refresh-token revocation for legacy sessions, and every non-auth API.

## 4. User segments and migration strategy

Segments are evaluated in this order because later segments depend on earlier
linking rules being stable.

### Segment A — email + password users (`passwordHash` set)

- **Strategy:** lazy migration at next login. After the user authenticates with
  Privy email OTP (#611), the backend links the Privy user to the existing row
  using the **verified** email (exact, case-insensitive match).
- **Password:** retained until Phase 5 so rollback stays possible. End state
  depends on an open decision (see §11): keep password login, or move fully to
  OTP and drop `passwordHash`.

### Segment B — wallet users (`walletAddress` / `stellarPublicKey` set)

- **Strategy:** at first Privy login with the same wallet (embedded via #613 or
  external via #613/#614), link on **wallet-address equality**. The wallet is a
  strong factor; no email match is required, but an email match must not
  silently override a different wallet.
- Dynamic-linked accounts keep working until the legacy path is switched off;
  linking writes `privy_user_id` without touching `walletAddress`.

### Segment C — users with local TOTP 2FA enabled

- **Strategy:** migrate these **first within each cohort**, after #639 lands:
  require the user to enroll Privy MFA at next login, then clear
  `twoFactorEnabled` and the local TOTP/recovery-code columns in Phase 5.
- Until Privy MFA enrollment succeeds, keep gating login on the legacy 2FA step
  — never weaken an active second factor.

### Segment D — privileged roles (`moderator`, `admin`, `super_admin`)

- **Strategy:** migrate staff first, as an explicit, audited batch (manual
  linking + verification), because a linking error here has the largest blast
  radius. Record every link in `transaction_logs` with a distinct action type.
- RBAC continues to read `role` from the local row (#615); Privy never carries
  the role.

### Segment E — dormant users (no login within the retention window)

- **Strategy:** no proactive work. Link lazily on next login; if they never
  return before Phase 5, they are contacted per §10 and can re-verify by email.

### Linking precedence (deterministic)

1. Verified exact email match (case-insensitive).
2. Exact wallet-address match.
3. Explicit user-confirmed linking (support flow / UI prompt).

Rules:

- **Never** auto-link on an _unverified_ email claim.
- If one Privy user matches two local rows, or one local row matches two Privy
  users, stop: mark the link `conflict`, route to support, and let a human
  resolve before any write. Do not merge rows automatically.
- One local row holds at most one `privy_user_id` (unique index, #600).

## 5. Migration runbook

Each phase is independently revertible; no phase drops or rewrites legacy data.

### Phase 0 — prerequisites

- [ ] Privy app created; App ID, App Secret, and JWT verification key configured (#595).
- [ ] SDK/service module (#594, #596) and token verification (#598) merged.
- [ ] `requireAuth` middleware accepts both token types while the flag is off (#597).
- [ ] Webhooks deployed with signature verification (#603–#606).
- [ ] Feature flag added, **default OFF** (#636).
- [ ] Verification-key caching (#634) and downtime fallback (#635) in place.

### Phase 1 — schema (additive only)

- [ ] Migration adds `users.privy_user_id` (nullable, unique) (#600).
- [ ] Migration adds/aligns `users.wallet_address` linked to Privy embedded
      wallets (#601) — additive; existing `walletAddress` is not rewritten.
- [ ] `migration:run` verified against a staging snapshot; rollback = leave the
      columns in place (nullable columns are harmless).

### Phase 2 — dual running

- [ ] Flag ON for a internal/staff allowlist: new logins issue/verify Privy
      tokens; legacy endpoints remain live for everyone.
- [ ] Linking logic live (§4 precedence); conflict metric emitted.
- [ ] Legacy refresh tokens continue to work until natural expiry (≤ 7 days);
      no forced logout at flag flip.
- [ ] Introspection (`/api/auth/introspect`) documents both token types for
      internal consumers.

### Phase 3 — cohort rollout

Order: **Segment D (staff) → Segment A+B early adopters → remaining artists →
listeners**, with a soak period between cohorts.

Monitor per cohort:

- Privy token verification failures (should be ~0),
- link conflicts (target 0 unresolved),
- webhook lag/failures (replay via #606-driven retry),
- login success rate vs. the legacy baseline,
- refresh/logout behavior for sessions created on either path.

Exit criteria per cohort: login success rate ≥ baseline for 7 days, zero
unresolved conflicts, no increase in 401s on protected routes.

### Phase 4 — default on

- [ ] Flag default ON for all traffic; legacy endpoints still available.
- [ ] Segment C users enrolled in Privy MFA (#639) before their legacy 2FA
      secrets are retired.
- [ ] Deprecation notice published for nonce/signature login and local TOTP.

### Phase 5 — cleanup (destructive — schedule separately)

- [ ] Remove legacy login routes and Dynamic Labs dependency (#613/#614 replace them).
- [ ] Remove local TOTP code paths after Segment C is fully enrolled.
- [ ] Drop unused columns (`passwordHash` only if §11 decision says so; TOTP
      secret/recovery codes) in a dedicated migration with a backup taken first.
- [ ] Keep `privy_user_id` backfillable — never make it NOT NULL for rows with
      no Privy login yet.

## 6. Token and session compatibility during dual running

| Aspect     | Legacy path                 | Privy path                       | During Phases 2–4                       |
| ---------- | --------------------------- | -------------------------------- | --------------------------------------- |
| Algorithm  | HS256 (`JWT_SECRET`)        | ES256 (Privy keys, `kid` header) | Middleware branches on issuer/`alg`     |
| Issuer     | backend                     | `privy.io`                       | validate `iss` per path                 |
| Audience   | n/a                         | App ID                           | compare against App ID for Privy tokens |
| Session id | `refresh_tokens` row        | `sid` claim                      | keep local revocation for legacy rows   |
| Expiry     | 15 min access / 7 d refresh | Privy's access-token TTL         | client refresh logic must handle both   |
| Logout     | server-side revoke          | Privy session ends client-side   | revoke locally in both cases            |

Practical rules:

- Accept a token as legacy only when the signature verifies under `JWT_SECRET`;
  accept as Privy only when ES256 verifies against Privy's keys with correct
  `iss` and `aud`. Never fall through from one to the other.
- `sub` is the Privy user id; resolve the local row via `privy_user_id`.
- Prefer the existing 15-minute access-token lifetime for any tokens the backend
  still mints during dual running, so client code does not fork.

## 7. Security considerations

- **Secrets:** App Secret and verification key come from environment/secret
  storage only (#595); never log them. Compose/env parity is enforced by
  `scripts/check-env-example.js`.
- **Webhooks:** reject requests failing Privy's signature check (#606) before
  any body parsing side effects; verify timestamp/replay windows.
- **Linking:** unverified-email auto-linking is forbidden (§4); privileged-role
  links are manual and audit-logged.
- **Verification keys:** cache with rotation tolerance (#634); a key-rotation
  must not require a restart.
- **Rate limits:** new endpoints inherit the existing auth rate limiters
  (`authRateLimiter`, `nonceRateLimiter`, `twoFactorRateLimiter`).
- **Failure handling:** invalid/malformed Privy tokens produce uniform 401s
  (#624) without leaking verification details; Privy downtime falls back per
  #635 (legacy path stays available as long as Phase 5 has not run).
- **PII:** email is used for matching — restrict it to server-side linking code
  and webhook payloads; do not add it to logs or metrics.

## 8. Configuration reference (planned)

Exact names are defined by #595; expected set:

| Variable                             | Purpose                                                       |
| ------------------------------------ | ------------------------------------------------------------- |
| `PRIVY_APP_ID`                       | JWT `aud` and API app identifier                              |
| `PRIVY_APP_SECRET`                   | Server-side API authentication (Basic auth to `api.privy.io`) |
| `PRIVY_JWT_VERIFICATION_KEY`         | Verifies Privy access-token signatures                        |
| `PRIVY_AUTH_ENABLED` (or equivalent) | Feature flag from #636, default `false`                       |

Update `docs/environment-variables.md` and `.env.example` in the same PR that
introduces them.

### 8.1 `ENABLE_LEGACY_EVM_AUTH` (legacy EVM / Dynamic Labs kill switch)

| Variable                 | Default | Effect                                                                                      |
| ------------------------ | ------- | ------------------------------------------------------------------------------------------- |
| `ENABLE_LEGACY_EVM_AUTH` | `false` | When not `true`, the EVM wallet-signature endpoints and Dynamic wallet routes return `410`. |

Gated routes (each answers `410 Gone` with a hint to use Privy or email login):

- `GET /api/auth/nonce/:email`, `POST /api/auth/register`,
  `POST /api/auth/register-listener`, `POST /api/auth/login`
- `POST /api/wallet/evm/create`, `POST /api/wallet/evm/signMessage`

Email + password, Privy and Stellar flows are unaffected by the flag. With the
flag off, `ethers` and the Dynamic Labs SDK are loaded lazily and so are not
imported at startup.

Timeline: the flag ships defaulting to `false`. Set it to `true` only to roll
back while legacy usage is being confirmed. Once usage is confirmed to be zero,
a follow-up change removes the gated routes, `src/services/Dynamic/`,
`src/config/dynamic.ts`, `src/utils/dynamicUtils.ts`, the Diamond facet ABIs in
`src/abis/` and the `ethers` dependency.

## 9. Testing and validation

- [ ] Unit tests for token verification middleware, including expired, wrong
      `aud`, wrong `alg`, unknown `kid` (#621).
- [ ] Linking-rule unit tests: verified email match, wallet match, both
      conflict directions, unverified-email rejection.
- [ ] Webhook signature tests (valid, invalid, replayed) (#606).
- [ ] End-to-end: signup → verify → login → authenticated request under both
      flag states (the suite added in #638 is the template).
- [ ] Flag-toggle test: sessions issued on path A work while flag flips to path B.
- [ ] Downtime drill: Privy API unreachable → #635 behavior confirmed in staging.
- [ ] Load: login/refresh success rate during a cohort rollout matches baseline
      (see `docs/AUTH_LOAD_TESTING.md`).

## 10. Rollback and end-user communication

**Rollback:** set the feature flag OFF (#636). Because Phases 1–4 are additive,
legacy login resumes immediately; users linked during dual running keep their
row (the `privy_user_id` column is simply ignored). Only Phase 5 requires a
restore-from-backup plan.

**What end users see:**

| Segment      | During migration                      | After Phase 5                                                                |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------------- |
| Email users  | Unchanged password login              | Login code (OTP) to the same account — same email, no re-registration        |
| Wallet users | Unchanged nonce/signature login       | Connect wallet as today; embedded wallet option available                    |
| 2FA users    | Legacy TOTP still required            | Privy MFA prompt at enrollment; old codes stop working only after enrollment |
| Staff        | Same as their segment, verified first | Same roles, same permissions                                                 |

Communicate before each cohort moves: what changes, what does not (account,
content, role), and the support path for linking conflicts.

## 11. Open questions for maintainers

1. Keep email+password login after Phase 5, or move fully to OTP and retire
   `passwordHash`?
2. Refresh sessions: keep server-side `refresh_tokens` for anything Privy
   issues, or rely on Privy sessions plus the short access token?
3. Should legacy and Privy tokens both be introspectable at `/introspect`
   forever, or is introspection retired with the legacy path?
4. Dormancy window for Segment E before proactive outreach.
5. Stellar-specific linking (#614): same precedence rules, or a stricter
   manual-only flow?

## 12. Related documents

- ADR-001 [Authentication Strategy](adrs/001-authentication-strategy.md) —
  rationale for the current token model this migration supersedes.
- [Token introspection](TOKEN_INTROSPECTION.md), [Environment variables](environment-variables.md),
  [Database schema](database-schema.md), [Migrations](migrations.md).
- Sibling implementation issues: #593–#606, #610–#615, #621, #624, #626,
  #634–#636, #639.

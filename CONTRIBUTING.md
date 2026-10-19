# Contributing to AudioBlock Backend

Welcome, and thanks for contributing. This guide covers everything you need to
get a change from idea to merged PR — branching, commits, reviews, changelog
entries, and releases.

---

## Table of Contents

1. [Getting Started](#getting-started)
2. [Branch Naming](#branch-naming)
3. [Commit Style](#commit-style)
4. [Opening a Pull Request](#opening-a-pull-request)
5. [PR Labels](#pr-labels)
6. [Code Review & CODEOWNERS](#code-review--codeowners)
7. [Changelog](#changelog)
8. [Versioning & Releases](#versioning--releases)
9. [Branch Protection](#branch-protection)

---

## Getting Started

```bash
# 1. Fork or clone the repo
git clone git@github-account2:Darkvader-ship-it/AudioBlock_Backend.git
cd AudioBlock_Backend

# 2. Install dependencies
npm install

# 3. Copy environment template and fill in values
cp .env.example .env

# 4. Start dependencies (Postgres, Redis, RabbitMQ) via Docker
docker compose up -d

# 5. Run migrations
npm run migration:run

# 6. Start the dev server
npm run dev
```

Run the test suite before pushing:

```bash
# Full test suite (CI default)
npm test

# Run only tests affected by changed files (fast local iteration)
npm run test:changed
```

### Pre-commit Hooks

Husky pre-commit hooks are installed via `npm run prepare` and run automatically before each commit. The pre-commit hook enforces code quality by running:

- `npm run lint` - ESLint checks for code quality and style issues
- `npm run format:check` - Prettier checks for formatting consistency

If either check fails, the commit is blocked. To fix linting issues, run:

```bash
npm run lint:fix
npm run format
```

To bypass the hook (not recommended), use `git commit --no-verify`.

---

## Branch Naming

Create all branches off `main`. Use the prefix that matches your change type:

| Prefix | Use case | Example |
|---|---|---|
| `feat/` | New feature | `feat/artist-royalty-split` |
| `fix/` | Bug fix | `fix/upload-chunk-timeout` |
| `chore/` | Maintenance, tooling, deps | `chore/update-stellar-sdk` |
| `docs/` | Documentation only | `docs/soroban-integration` |
| `hotfix/` | Urgent production patch | `hotfix/v1.1.1` |
| `refactor/` | Code restructure, no behaviour change | `refactor/song-service` |
| `security/` | Security fix or hardening | `security/jwt-expiry` |

---

## Commit Style

Follow [Conventional Commits](https://www.conventionalcommits.org/en/v1.0.0/):

```
<type>(<scope>): <short description>

[optional body]

[optional footer: BREAKING CHANGE: ...]
```

Common types: `feat`, `fix`, `chore`, `docs`, `refactor`, `perf`, `test`, `ci`.

Examples:

```
feat(soroban): add artist registration contract call
fix(upload): handle partial chunk re-upload correctly
chore(deps): bump @stellar/stellar-sdk to 16.1.0
docs(contributing): add PR label table
```

Keep the subject line under 72 characters and use the imperative mood ("add",
not "added" or "adds").

---

## Opening a Pull Request

1. Push your branch and open a PR against `main`.
2. Fill in the PR description — what changed and why.
3. **Apply exactly one label** from the [PR Labels](#pr-labels) table below.
   This drives both the changelog draft and the automatic semver bump.
4. Ensure CI passes (Jest tests + TypeScript build).
5. Resolve all review comments before requesting a re-review.

PRs that touch sensitive areas (auth, Soroban contracts, DB migrations) will
automatically receive review requests from the mapped owners — see
[Code Review & CODEOWNERS](#code-review--codeowners).

---

## PR Labels

Apply **one** label per PR. Release Drafter uses these to categorise changelog
entries and determine the next semver version automatically.

| Label | Semver bump | Changelog section |
|---|---|---|
| `breaking-change` | **major** | _(triggers major bump)_ |
| `feature` / `enhancement` | **minor** | 🚀 Features |
| `bug` / `fix` | **patch** | 🐛 Bug Fixes |
| `performance` | **patch** | ⚡ Performance |
| `security` | **patch** | 🔒 Security |
| `blockchain` / `soroban` / `stellar` | **patch** | 🔗 Blockchain / On-Chain |
| `infrastructure` / `docker` / `ci` | **patch** | 🏗 Infrastructure |
| `documentation` / `docs` | **patch** | 📝 Documentation |
| `chore` / `dependencies` / `refactor` | **patch** | 🧹 Chores & Maintenance |
| `skip-changelog` | — | PR excluded from draft |
| `wip` | — | PR excluded from draft |

If your PR shouldn't appear in the changelog (e.g. a trivial typo fix or a
draft PR), apply `skip-changelog`.

---

## Code Review & CODEOWNERS

`.github/CODEOWNERS` maps areas of the codebase to reviewers. When your PR
touches a mapped path, GitHub automatically requests a review from the relevant
owner — you don't need to do this manually.

Key ownership areas:

| Path | Owner(s) | Why |
|---|---|---|
| `src/services/Soroban/`, `src/abis/` | @Darkvader-ship-it | On-chain / Stellar contract logic |
| `src/workers/`, `src/jobs/` | @Darkvader-ship-it | Async processing reliability |
| `src/middlewares/auth*`, `src/services/AuthService.ts` | @Darkvader-ship-it | Auth & security |
| `src/migrations/`, `src/entities/` | @Darkvader-ship-it | DB schema changes |
| `docs/`, `RELEASING.md`, `CONTRIBUTING.md` | @Darkvader-ship-it | Process documentation |
| Everything else | @Darkvader-ship-it | Global fallback |

To update ownership, edit `.github/CODEOWNERS` and open a PR — CODEOWNERS
itself requires a review from `@Darkvader-ship-it`.

**Review expectations:**
- Respond to review requests within **2 business days**.
- Approve only when you are confident the change is correct and safe.
- Use "Request changes" with specific feedback rather than silent disapproval.

---

## Changelog

`CHANGELOG.md` follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/)
conventions and is updated as part of every release.

**You do not need to edit `CHANGELOG.md` manually for normal PRs.** The
process is:

1. You label your PR (see [PR Labels](#pr-labels)).
2. When your PR merges to `main`, the **Release Drafter** GitHub Action
   automatically updates a draft GitHub Release with your PR title under the
   correct category.
3. Before each release, a maintainer reviews the draft, edits as needed, and
   publishes it — at which point `CHANGELOG.md` is updated manually to match.

**When you do need to touch `CHANGELOG.md`:**
- Correcting a historical entry.
- Adding context to a breaking change description.
- Moving `[Unreleased]` entries into a versioned section as part of the
  release process (maintainers only — see [RELEASING.md](./RELEASING.md)).

Always add new entries under `[Unreleased]`, never under an already-published
version section.

---

## Versioning & Releases

Full details are in [RELEASING.md](./RELEASING.md). Summary:

- We use [Semantic Versioning](https://semver.org/): `MAJOR.MINOR.PATCH`.
- Version bump type is determined by the PR label (see table above).
- Releases are created by a maintainer via GitHub Releases after reviewing the
  auto-generated draft.
- `package.json` version is bumped with `npm version <major|minor|patch> --no-git-tag-version`
  as part of the release commit.
- Git tags follow the format `vMAJOR.MINOR.PATCH` (e.g. `v1.2.0`).

---

## Branch Protection

`main` is protected. The full rule set is documented in
[docs/branch-protection.md](./docs/branch-protection.md).

Key rules that affect contributors:

- **No direct pushes to `main`** — all changes must come through a PR.
- **At least 1 approving review required** before merge.
- **CI must pass** (Jest + TypeScript build) before merge.
- **All review conversations must be resolved** before merge.
- **Branch must be up to date** with `main` before merging — rebase or merge
  main into your branch if it has fallen behind.

If CI fails on your PR, fix the issue before requesting review. Don't ask
reviewers to approve a red build.

## Description

Please include a summary of the change, the problem it solves, and why it is needed.

Fixes / Closes #(issue)

## Type of Change

Select all that apply and ensure the matching PR label is set per [CONTRIBUTING.md](../CONTRIBUTING.md#pr-labels):

- [ ] `bug` / `fix`: Bug fix (non-breaking change which fixes an issue)
- [ ] `feature` / `enhancement`: New feature (non-breaking change which adds functionality)
- [ ] `breaking-change`: Breaking change (fix or feature that causes existing functionality to not work as expected)
- [ ] `documentation` / `docs`: Documentation update only
- [ ] `performance`: Performance improvement
- [ ] `security`: Security hardening or fix
- [ ] `chore` / `refactor`: Refactoring, dependencies, or maintenance

## Breaking Changes Disclosure

Does this PR introduce any breaking change to APIs, database schemas, environment variables, or workflows?

- [ ] **No** breaking changes are introduced.
- [ ] **Yes**, this PR introduces breaking changes.

_If yes, describe the breaking impact, reasoning, and migration steps for consumers/operators:_
<!-- Describe breaking changes, affected endpoints, schema changes, or migration runbooks here -->

## Test Plan & Verification

Explain how you tested these changes. Provide commands executed, automated test files run, and manual verification results.

### Automated Tests
- Command(s) run: `npm test` / `npm run test:changed` / `npm run lint`
- Relevant test file(s):

### Manual Verification
- Steps taken to verify in local or staging environment:
- Verification results / evidence:

## Checklist

- [ ] My code follows the repository's coding style and conventions (`npm run lint`, `npm run format:check`)
- [ ] I have performed a self-review of my own code
- [ ] I have added or updated tests that prove my fix is effective or that my feature works
- [ ] New and existing unit tests pass locally with my changes
- [ ] I have commented my code, particularly in hard-to-understand or security-sensitive areas
- [ ] I have updated corresponding documentation (`README.md`, `docs/`, `openapi.yaml`) where applicable
- [ ] I have confirmed no secrets, private keys, or credentials are committed
- [ ] I have applied the appropriate PR label per [CONTRIBUTING.md](../CONTRIBUTING.md#pr-labels)

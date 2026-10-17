# AI Data Retention Controls (#291)

## Overview

When AI features process user/artist content (cover art prompts, descriptions, lyrics, etc.), that content is sent to third-party AI providers. This document describes the retention and opt-out controls.

## Opt-Out Flag

Set `AI_DATA_RETENTION_OPT_OUT=true` to skip all AI calls that would send content off-platform.

```bash
AI_DATA_RETENTION_OPT_OUT=true
```

When enabled:
- All AI call sites check `isAiDataRetentionOptOut()` before processing
- The AI step is skipped with an audit log entry
- The request continues normally (AI is optional)

## Retention Configuration

| Provider | Retention Setting | Documentation |
|----------|------------------|---------------|
| OpenAI | Zero data retention (ZDR) | https://platform.openai.com/docs/guides/zero-data-retention |
| Anthropic | Data not used for training | https://www.anthropic.com/privacy |
| Noop | No data sent | N/A |

## Audit Trail

All AI generation calls are logged to `ai_generation_records` table with:
- `provider` — which AI provider was used
- `userId` — who triggered the call
- `feature` — which AI feature was called
- `createdAt` — when the call happened

## Related

- ADR-007: AI Integration
- Issue #291: Data retention controls

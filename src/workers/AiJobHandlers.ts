/**
 * Registers JobQueueWorker handlers for the async AI jobs enqueued by
 * AiGenerationService (cover art / description generation). A generation
 * record only flips to "failed" — and only then fires the
 * ai.generation.completed webhook — once JobQueueService has exhausted all
 * retries; earlier attempt failures just let the queue's own backoff/retry
 * do its job.
 */
import { Job } from '../services/JobQueueService';
import {
  AI_JOB_TYPE,
  AiGenerationFeature,
  AiGenerationJobPayload,
  AiGenerationService,
} from '../services/ai/AiGenerationService';
import { registerJobHandler } from './JobQueueWorker';

export function registerAiJobHandlers(): void {
  const aiGenerationService = new AiGenerationService();

  const handle = (feature: AiGenerationFeature) => async (job: Job<AiGenerationJobPayload>) => {
    try {
      await aiGenerationService.generate(feature, job.payload.recordId);
    } catch (err) {
      if (job.attempts >= job.maxAttempts) {
        await aiGenerationService.markFailed(
          job.payload.recordId,
          err instanceof Error ? err.message : String(err),
        );
      }
      throw err;
    }
  };

  registerJobHandler(AI_JOB_TYPE.coverArt, handle('coverArt'));
  registerJobHandler(AI_JOB_TYPE.descriptions, handle('descriptions'));
  registerJobHandler(AI_JOB_TYPE.lyricsTranscription, handle('lyricsTranscription'));
}

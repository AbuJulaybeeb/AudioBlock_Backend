/**
 * Tests for AiJobHandlers (#833).
 *
 * The handlers are thin glue between the job queue and AiGenerationService.
 * We verify the retry/failure routing logic without touching real AI providers,
 * the database, or Redis.
 */

import 'reflect-metadata';

// ─── mock AiGenerationService before importing the handlers ───────────────────

const mockGenerate = jest.fn();
const mockMarkFailed = jest.fn();

jest.mock('../../services/ai/AiGenerationService', () => {
  const original = jest.requireActual('../../services/ai/AiGenerationService');
  return {
    ...original,
    AiGenerationService: jest.fn().mockImplementation(() => ({
      generate: mockGenerate,
      markFailed: mockMarkFailed,
    })),
  };
});

// Capture registered handlers instead of running a real worker loop
const registeredHandlers = new Map<string, (job: any) => Promise<void>>();
jest.mock('../JobQueueWorker', () => ({
  registerJobHandler: (type: string, handler: (job: any) => Promise<void>) => {
    registeredHandlers.set(type, handler);
  },
}));

// ─── imports (after mocks) ────────────────────────────────────────────────────

import { registerAiJobHandlers } from '../AiJobHandlers';
import { AI_JOB_TYPE } from '../../services/ai/AiGenerationService';

// ─── helpers ──────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<{
  type: string;
  recordId: string;
  attempts: number;
  maxAttempts: number;
}> = {}) {
  return {
    id: 'job-1',
    type: AI_JOB_TYPE.coverArt,
    payload: { recordId: overrides.recordId ?? 'record-1' },
    priority: 'low' as const,
    status: 'processing' as const,
    attempts: overrides.attempts ?? 1,
    maxAttempts: overrides.maxAttempts ?? 3,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

// ─── setup ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  jest.clearAllMocks();
  registeredHandlers.clear();
  registerAiJobHandlers();
});

// ─── registration ─────────────────────────────────────────────────────────────

describe('registerAiJobHandlers — handler registration', () => {
  it('registers a handler for every AI job type', () => {
    expect(registeredHandlers.has(AI_JOB_TYPE.coverArt)).toBe(true);
    expect(registeredHandlers.has(AI_JOB_TYPE.descriptions)).toBe(true);
    expect(registeredHandlers.has(AI_JOB_TYPE.lyricsTranscription)).toBe(true);
  });
});

// ─── successful job ────────────────────────────────────────────────────────────

describe('successful job', () => {
  it('calls generate() with the correct feature and recordId', async () => {
    mockGenerate.mockResolvedValue(undefined);
    const job = makeJob({ recordId: 'record-abc' });

    await registeredHandlers.get(AI_JOB_TYPE.coverArt)!(job);

    expect(mockGenerate).toHaveBeenCalledWith('coverArt', 'record-abc');
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('calls generate() with the descriptions feature', async () => {
    mockGenerate.mockResolvedValue(undefined);
    const job = makeJob({ recordId: 'record-desc' });

    await registeredHandlers.get(AI_JOB_TYPE.descriptions)!(job);

    expect(mockGenerate).toHaveBeenCalledWith('descriptions', 'record-desc');
  });

  it('calls generate() with the lyricsTranscription feature', async () => {
    mockGenerate.mockResolvedValue(undefined);
    const job = makeJob({ recordId: 'record-lyrics' });

    await registeredHandlers.get(AI_JOB_TYPE.lyricsTranscription)!(job);

    expect(mockGenerate).toHaveBeenCalledWith('lyricsTranscription', 'record-lyrics');
  });
});

// ─── retryable failure (not yet at max attempts) ──────────────────────────────

describe('retryable failure — attempts < maxAttempts', () => {
  it('rethrows the error so the queue worker retries with backoff', async () => {
    const providerError = new Error('provider temporarily unavailable');
    mockGenerate.mockRejectedValue(providerError);

    const job = makeJob({ attempts: 1, maxAttempts: 3 });

    await expect(
      registeredHandlers.get(AI_JOB_TYPE.coverArt)!(job),
    ).rejects.toThrow('provider temporarily unavailable');

    // markFailed must NOT be called — only the final attempt does that
    expect(mockMarkFailed).not.toHaveBeenCalled();
  });

  it('does not call markFailed on the second of three attempts', async () => {
    mockGenerate.mockRejectedValue(new Error('timeout'));

    const job = makeJob({ attempts: 2, maxAttempts: 3 });

    await expect(
      registeredHandlers.get(AI_JOB_TYPE.descriptions)!(job),
    ).rejects.toThrow();

    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});

// ─── non-retryable failure (max attempts reached) ────────────────────────────

describe('non-retryable failure — attempts >= maxAttempts', () => {
  it('calls markFailed with the error message and still rethrows', async () => {
    const budgetError = new Error('budget exceeded');
    mockGenerate.mockRejectedValue(budgetError);
    mockMarkFailed.mockResolvedValue(undefined);

    const job = makeJob({ attempts: 3, maxAttempts: 3 });

    await expect(
      registeredHandlers.get(AI_JOB_TYPE.coverArt)!(job),
    ).rejects.toThrow('budget exceeded');

    expect(mockMarkFailed).toHaveBeenCalledTimes(1);
    expect(mockMarkFailed).toHaveBeenCalledWith('record-1', 'budget exceeded');
  });

  it('converts non-Error thrown values to a string for markFailed', async () => {
    mockGenerate.mockRejectedValue('string error from provider');
    mockMarkFailed.mockResolvedValue(undefined);

    const job = makeJob({ attempts: 3, maxAttempts: 3 });

    await expect(
      registeredHandlers.get(AI_JOB_TYPE.descriptions)!(job),
    ).rejects.toBe('string error from provider');

    expect(mockMarkFailed).toHaveBeenCalledWith('record-1', 'string error from provider');
  });
});

// ─── deleted record (no-op) ────────────────────────────────────────────────────

describe('target record deleted — no-op', () => {
  it('completes without throwing when generate() resolves (record skipped internally)', async () => {
    // AiGenerationService.generate() returns without throwing when the record
    // is missing — the handler should propagate that clean exit.
    mockGenerate.mockResolvedValue(undefined);

    const job = makeJob({ recordId: 'deleted-record' });

    await expect(
      registeredHandlers.get(AI_JOB_TYPE.coverArt)!(job),
    ).resolves.toBeUndefined();

    expect(mockMarkFailed).not.toHaveBeenCalled();
  });
});

// ─── privacy — no user content logged ────────────────────────────────────────

describe('privacy — no user content at info level', () => {
  it('does not log any job payload properties (recordId, songId, prompts)', async () => {
    const infoSpy = jest.spyOn(console, 'info').mockImplementation(() => {});
    const logSpy = jest.spyOn(console, 'log').mockImplementation(() => {});
    mockGenerate.mockResolvedValue(undefined);

    const sensitiveRecordId = 'user-private-record-xyz';
    const job = makeJob({ recordId: sensitiveRecordId });

    await registeredHandlers.get(AI_JOB_TYPE.coverArt)!(job);

    const infoOutput = infoSpy.mock.calls.map((c) => JSON.stringify(c)).join('');
    const logOutput = logSpy.mock.calls.map((c) => JSON.stringify(c)).join('');

    expect(infoOutput).not.toContain(sensitiveRecordId);
    expect(logOutput).not.toContain(sensitiveRecordId);

    infoSpy.mockRestore();
    logSpy.mockRestore();
  });
});

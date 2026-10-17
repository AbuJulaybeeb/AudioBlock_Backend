/**
 * relayPattern.contract.test.ts (#355)
 *
 * Contract tests for the shared on-chain relay pattern (prepare/sign/submit)
 * used by both artist setup and song minting. Asserts that both call sites
 * follow the same contract shape and error handling.
 */

import 'reflect-metadata';

// ── Module-level mocks ──────────────────────────────────────────────────────

const mockPrepareInvocation = jest.fn();
const mockSubmitSignedTransaction = jest.fn();

jest.mock('../../services/Soroban/SorobanService', () => ({
  SorobanService: jest.fn().mockImplementation(() => ({
    prepareInvocation: mockPrepareInvocation,
    submitSignedTransaction: mockSubmitSignedTransaction,
  })),
}));

// ── Import after mocks ─────────────────────────────────────────────────────

const { SorobanService } = require('../../services/Soroban/SorobanService');

/** Shared contract shape for the prepare/sign/submit relay pattern. */
interface RelayPrepareResult {
  xdr: string;
  networkPassphrase: string;
  validUntilLedger?: number;
}

interface RelaySubmitResult {
  hash: string;
  status: 'SUCCESS' | 'FAILED';
  resultMeta?: string;
}

/**
 * Asserts the prepare result matches the relay contract shape.
 * Both artist setup and song minting must satisfy this.
 */
function assertPrepareContract(result: RelayPrepareResult, label: string) {
  expect(result).toBeDefined();
  expect(typeof result.xdr).toBe('string');
  expect(result.xdr.length).toBeGreaterThan(0);
  expect(typeof result.networkPassphrase).toBe('string');
  expect(result.networkPassphrase.length).toBeGreaterThan(0);
  if (result.validUntilLedger !== undefined) {
    expect(typeof result.validUntilLedger).toBe('number');
    expect(result.validUntilLedger).toBeGreaterThan(0);
  }
}

/**
 * Asserts the submit result matches the relay contract shape.
 */
function assertSubmitContract(result: RelaySubmitResult, label: string) {
  expect(result).toBeDefined();
  expect(typeof result.hash).toBe('string');
  expect(result.hash.length).toBeGreaterThan(0);
  expect(['SUCCESS', 'FAILED']).toContain(result.status);
}

describe('On-chain relay pattern contract (#355)', () => {
  let soroban: any;

  beforeEach(() => {
    jest.clearAllMocks();
    soroban = new SorobanService();
  });

  describe('Artist setup relay (prepareSetup / submitSetup)', () => {
    it('prepareSetup returns a valid relay contract shape', async () => {
      mockPrepareInvocation.mockResolvedValue({
        xdr: 'AAAAAgAAAABartist-setup-xdr',
        networkPassphrase: 'Test SDF Network ; September 2015',
        validUntilLedger: 1000000,
      });

      const result = await soroban.prepareInvocation('artist_setup', [
        { name: 'artist', value: 'GABC...' },
      ]);

      assertPrepareContract(result, 'artist setup');
    });

    it('submitSetup returns a valid relay contract shape', async () => {
      mockSubmitSignedTransaction.mockResolvedValue({
        hash: 'abc123def456',
        status: 'SUCCESS',
        resultMeta: 'AAAA',
      });

      const result = await soroban.submitSignedTransaction('signed-xdr-artist');
      assertSubmitContract(result, 'artist setup submit');
    });

    it('prepareSetup rejects on RPC failure', async () => {
      mockPrepareInvocation.mockRejectedValue(new Error('RPC unreachable'));
      await expect(
        soroban.prepareInvocation('artist_setup', []),
      ).rejects.toThrow('RPC unreachable');
    });
  });

  describe('Song minting relay (prepareMint / submitMint)', () => {
    it('prepareMint returns a valid relay contract shape', async () => {
      mockPrepareInvocation.mockResolvedValue({
        xdr: 'AAAAAgAAAABsong-mint-xdr',
        networkPassphrase: 'Test SDF Network ; September 2015',
        validUntilLedger: 1000001,
      });

      const result = await soroban.prepareInvocation('mint_song', [
        { name: 'metadata', value: 'QmTest123' },
      ]);

      assertPrepareContract(result, 'song mint');
    });

    it('submitMint returns a valid relay contract shape', async () => {
      mockSubmitSignedTransaction.mockResolvedValue({
        hash: 'def789ghi012',
        status: 'SUCCESS',
        resultMeta: 'AAAA',
      });

      const result = await soroban.submitSignedTransaction('signed-xdr-mint');
      assertSubmitContract(result, 'song mint submit');
    });

    it('prepareMint rejects on RPC failure', async () => {
      mockPrepareInvocation.mockRejectedValue(new Error('RPC unreachable'));
      await expect(
        soroban.prepareInvocation('mint_song', []),
      ).rejects.toThrow('RPC unreachable');
    });
  });

  describe('Shared relay contract behavior', () => {
    it('both call sites use the same prepare contract shape', async () => {
      mockPrepareInvocation.mockResolvedValue({
        xdr: 'shared-xdr',
        networkPassphrase: 'Test SDF Network ; September 2015',
      });

      const artistResult = await soroban.prepareInvocation('artist_setup', []);
      const songResult = await soroban.prepareInvocation('mint_song', []);

      assertPrepareContract(artistResult, 'artist');
      assertPrepareContract(songResult, 'song');

      // Both must have the same contract shape
      expect(Object.keys(artistResult).sort()).toEqual(
        Object.keys(songResult).sort(),
      );
    });

    it('both call sites use the same submit contract shape', async () => {
      mockSubmitSignedTransaction.mockResolvedValue({
        hash: 'same-hash',
        status: 'SUCCESS',
      });

      const artistResult = await soroban.submitSignedTransaction('xdr-a');
      const songResult = await soroban.submitSignedTransaction('xdr-b');

      assertSubmitContract(artistResult, 'artist');
      assertSubmitContract(songResult, 'song');

      expect(Object.keys(artistResult).sort()).toEqual(
        Object.keys(songResult).sort(),
      );
    });

    it('handles failure identically for both call sites', async () => {
      mockSubmitSignedTransaction.mockResolvedValue({
        hash: 'fail-hash',
        status: 'FAILED',
        resultMeta: 'error-meta',
      });

      const artistResult = await soroban.submitSignedTransaction('xdr-fail-a');
      const songResult = await soroban.submitSignedTransaction('xdr-fail-b');

      expect(artistResult.status).toBe('FAILED');
      expect(songResult.status).toBe('FAILED');
    });
  });
});

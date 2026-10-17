/**
 * Opt-in integration test (Issue #249): a mocked SorobanEventReader can't
 * catch real event-shape mismatches against testnet. Polls the live RPC for
 * a configured contract and asserts the decoded shape.
 *
 * Skipped by default — set RUN_INDEXER_INTEGRATION_TEST=true to run it.
 * See docs/INDEXER_GUIDE.md "Testing" for setup. Never runs in default `npm test`.
 */
import { SorobanEventReader } from '../services/Soroban/SorobanEventReader';
import { buildIndexerContracts } from '../services/Soroban/IndexerContractRegistry';

const RUN = process.env.RUN_INDEXER_INTEGRATION_TEST === 'true';
const describeMaybe = RUN ? describe : describe.skip;

describeMaybe('IndexerWorker integration (testnet)', () => {
  jest.setTimeout(30000);

  it('fetches and decodes real events for a configured contract', async () => {
    const reader = new SorobanEventReader();
    const [contract] = buildIndexerContracts();
    expect(contract.contractId).toBeTruthy();

    const latestLedger = await reader.getLatestLedger();
    expect(latestLedger).toBeGreaterThan(0);

    const page = await reader.fetchEvents({
      contractIds: [contract.contractId],
      startLedger: Math.max(1, latestLedger - 5000),
      endLedger: latestLedger,
      limit: 10,
    });

    for (const event of page.events) {
      // A real event must decode to either a known DTO shape or null
      // (unrecognized event type) — it must never throw.
      const dto = contract.decoder.decode(event);
      expect(dto === null || typeof dto === 'object').toBe(true);
    }
  });
});

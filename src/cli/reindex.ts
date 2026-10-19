#!/usr/bin/env ts-node
import { IndexedEventService, InsertIndexedEventDTO } from '../services/IndexedEventService';
import AppDataSource from '../config/db';
import logger from '../config/logger';
import {
  SorobanEventReader,
  NormalizedContractEvent,
} from '../services/Soroban/SorobanEventReader';
import {
  buildIndexerContracts,
  IndexerContract,
} from '../services/Soroban/IndexerContractRegistry';

interface ReindexOptions {
  contract: string;
  network: string;
  from: number;
  to: number;
  dryRun?: boolean;
}

export interface ReindexSummary {
  fetched: number;
  inserted: number;
  alreadyPresent: number;
  failed: number;
  skipped: number;
  perType: Record<string, number>;
}

function createReindexContext(options: ReindexOptions) {
  const { contract, network, from, to } = options;
  if (!Number.isSafeInteger(from) || from < 0)
    throw new Error('Start ledger (--from) must be >= 0 and an integer');
  if (!Number.isSafeInteger(to) || to < from || to === Number.MAX_SAFE_INTEGER)
    throw new Error('End ledger (--to) must be >= start ledger (--from) and an integer');
  if (network !== 'testnet' && network !== 'mainnet')
    throw new Error('Network must be testnet or mainnet');
  // Config getters resolve the requested network. Restore the environment before any await.
  const previous = process.env.SOROBAN_NETWORK;
  let reader: SorobanEventReader;
  let registered;
  try {
    process.env.SOROBAN_NETWORK = network;
    registered = buildIndexerContracts().find((entry) => entry.contractId === contract);
    if (!registered) throw new Error('Contract is not in IndexerContractRegistry');
    reader = new SorobanEventReader();
    return { reader, registered };
  } finally {
    if (previous === undefined) delete process.env.SOROBAN_NETWORK;
    else process.env.SOROBAN_NETWORK = previous;
  }
}

async function processReindexEvent(
  event: NormalizedContractEvent,
  options: ReindexOptions,
  registered: IndexerContract,
  service: IndexedEventService,
  summary: ReindexSummary,
): Promise<void> {
  const { network, dryRun } = options;
  summary.fetched++;
  try {
    const dto: InsertIndexedEventDTO | null = registered.decoder.decode(event);
    if (!dto) {
      summary.skipped++;
      return;
    }
    summary.perType[dto.eventType] = (summary.perType[dto.eventType] || 0) + 1;
    if (!dryRun)
      await service.upsertEvent({ ...dto, network }, (inserted) => {
        if (inserted) summary.inserted++;
        else summary.alreadyPresent++;
      });
  } catch (err) {
    summary.failed++;
    logger.error({ err, eventId: event.id }, 'Failed to reindex event');
  }
}

async function reindexRange(options: ReindexOptions): Promise<ReindexSummary> {
  const { contract, network, from, to, dryRun } = options;
  const { reader, registered } = createReindexContext(options);
  const summary: ReindexSummary = {
    fetched: 0,
    inserted: 0,
    alreadyPresent: 0,
    failed: 0,
    skipped: 0,
    perType: {},
  };
  const ownsConnection = !dryRun && !AppDataSource.isInitialized;
  if (ownsConnection) await AppDataSource.initialize();
  const service = new IndexedEventService();
  let cursor: string | undefined;
  const cursors = new Set<string>();
  try {
    while (true) {
      const page = await reader.fetchEvents({
        contractIds: [contract],
        ...(cursor ? { cursor } : { startLedger: from, endLedger: to + 1 }),
        limit: 200,
      });
      let pastEnd = false;
      for (const event of page.events) {
        if (event.ledger > to) {
          pastEnd = true;
          continue;
        }
        if (event.ledger < from) continue;
        await processReindexEvent(event, options, registered, service, summary);
      }
      if (pastEnd || !page.cursor) break;
      if (cursors.has(page.cursor)) {
        if (page.events.length === 0) break; // RPC reached its current tip.
        throw new Error('RPC pagination cursor did not advance');
      }
      cursors.add(page.cursor);
      cursor = page.cursor;
    }
    return summary;
  } finally {
    logger.info({ contract, network, from, to, dryRun: !!dryRun, ...summary }, 'Reindex summary');
    if (ownsConnection) await AppDataSource.destroy();
  }
}

export { reindexRange };

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  if (args.includes('--help') || args.includes('-h')) {
    console.log(
      'Usage: npm run cli:reindex -- --contract ID --network testnet|mainnet --from LEDGER --to LEDGER [--dry-run]',
    );
    return;
  }
  const values: Record<string, string> = {};
  let dryRun = false;
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }
    if (
      !['--contract', '--network', '--from', '--to'].includes(arg) ||
      !args[i + 1] ||
      args[i + 1].startsWith('--')
    )
      throw new Error('Unknown or incomplete argument: ' + arg);
    values[arg] = args[++i];
  }
  if (['--contract', '--network', '--from', '--to'].some((key) => !values[key]))
    throw new Error('Required: --contract --network --from --to');
  const summary = await reindexRange({
    contract: values['--contract'],
    network: values['--network'],
    from: Number(values['--from']),
    to: Number(values['--to']),
    dryRun,
  });
  process.exitCode = summary.failed ? 1 : 0;
}

if (require.main === module) {
  main().catch((err) => {
    logger.error({ err }, 'Reindex failed');
    process.exitCode = 1;
  });
}

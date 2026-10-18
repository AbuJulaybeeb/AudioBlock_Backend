import 'reflect-metadata';
import 'dotenv/config';
import AppDataSource from '../config/db';
import { initRabbitMQ } from '../config/rabbitmq';
import { startSongWorker } from './SongProcessorWorker';
import logger from '../config/logger';

async function main(): Promise<void> {
  await AppDataSource.initialize();
  await initRabbitMQ();
  if (!(await startSongWorker())) throw new Error('Song consumer did not start');
  logger.info('Standalone song worker started');
}

main().catch((err) => {
  logger.error({ err }, 'Standalone song worker startup failed');
  process.exit(1);
});

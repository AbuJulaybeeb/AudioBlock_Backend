import 'reflect-metadata';
import { DataSource } from 'typeorm';
import dotenv from 'dotenv';
import { User } from '../entities/User';
import { Song } from '../entities/Song';
import { TransactionLog } from '../entities/TransactionLog';
import { Genre } from '../entities/Genre';
import { Album } from '../entities/Album';
import { RoyaltyPayout } from '../entities/RoyaltyPayout';
import { WebhookSubscription } from '../entities/WebhookSubscription';
import { TakedownRequest } from '../entities/TakedownRequest';
import { ApiKey } from '../entities/ApiKey';
import { AiGenerationRecord } from '../entities/AiGenerationRecord';
import { TweetDraft } from '../entities/TweetDraft';
import { IndexerCursor } from '../entities/IndexerCursor';
import { BackfillStatus } from '../entities/BackfillStatus';
import { IndexedEvent } from '../entities/IndexedEvent';
import { AccountDeletionRequest } from '../entities/AccountDeletionRequest';
import { ProjectionCheckpoint } from '../entities/ProjectionCheckpoint';
import { OnChainEventCount } from '../entities/OnChainEventCount';
import { Notification } from '../entities/Notification';
import { DeviceToken } from '../entities/DeviceToken';

dotenv.config();

const AppDataSource = new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5321),
  username: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '1234',
  database: process.env.POSTGRES_DATABASE || 'audioblocks',
  synchronize: process.env.NODE_ENV !== 'production',
  dropSchema: false,
  ssl: false,
  logging: true,
  entities: [
    User,
    Song,
    TransactionLog,
    Genre,
    Album,
    RoyaltyPayout,
    WebhookSubscription,
    TakedownRequest,
    ApiKey,
    AiGenerationRecord,
    TweetDraft,
    IndexerCursor,
    BackfillStatus,
    IndexedEvent,
    AccountDeletionRequest,
    ProjectionCheckpoint,
    OnChainEventCount,
    Notification,
    DeviceToken,
  ],
  migrations: [__dirname + '/../migrations/*.{js,ts}'],
  migrationsTableName: 'migrations',
});

export default AppDataSource;

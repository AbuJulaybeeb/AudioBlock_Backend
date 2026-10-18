import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { User } from './User';

/**
 * Webhook subscription for third-party event delivery.
 * Stores the subscriber's endpoint and secret used for HMAC signing.
 * Event types: e.g. "song.minted", "sale.completed", "mint_status_changed"
 */
@Entity('webhook_subscriptions')
export class WebhookSubscription {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  userId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'userId' })
  user!: User;

  @Column()
  endpoint!: string;

  /** HMAC secret for signing payloads — returned once on creation, stored hashed? For simplicity stored plain. */
  @Column()
  secret!: string;

  /** Postgres text[]; empty or ["*"] means all events (GIN-indexed in the migration) */
  @Column({ type: 'text', array: true, nullable: true })
  eventTypes!: string[];

  @Column({ default: true })
  isActive!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

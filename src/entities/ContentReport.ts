import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
  Index,
  Unique,
} from 'typeorm';
import { Song } from './Song';
import { User } from './User';

/** Why a listener flagged a song (Issue #88). */
export enum ReportReason {
  COPYRIGHT = 'copyright',
  EXPLICIT = 'explicit',
  SPAM = 'spam',
  OTHER = 'other',
}

/** Lifecycle of a report in the moderation queue. */
export enum ReportStatus {
  PENDING = 'pending',
  RESOLVED = 'resolved',
}

/** What the moderator did about the report. */
export enum ReportAction {
  NO_ACTION = 'no_action',
  SONG_FLAGGED = 'song_flagged',
  SONG_REMOVED = 'song_removed',
  DISMISSED = 'dismissed',
}

/**
 * A user-submitted content report against a song (Issue #88).
 *
 * The `(songId, reporterId)` unique constraint enforces one report per user
 * per song so a single account cannot inflate the report count.
 */
@Entity('content_reports')
@Unique('UQ_content_report_reporter_song', ['songId', 'reporterId'])
export class ContentReport {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => Song, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'songId' })
  song!: Song;

  @Index()
  @Column()
  songId!: string;

  @ManyToOne(() => User, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'reporterId' })
  reporter!: User;

  @Index()
  @Column()
  reporterId!: string;

  @Column({ type: 'varchar', default: ReportReason.OTHER })
  reason!: ReportReason;

  @Column({ type: 'text', nullable: true })
  description?: string | null;

  @Index()
  @Column({ type: 'varchar', default: ReportStatus.PENDING })
  status!: ReportStatus;

  @Column({ type: 'varchar', nullable: true })
  actionTaken?: ReportAction | null;

  /** Moderator who resolved the report. */
  @Column({ nullable: true })
  resolvedBy?: string | null;

  @Column({ type: 'timestamp', nullable: true })
  resolvedAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  resolutionNote?: string | null;

  /** Issue #273: AI-generated severity score (0-100, advisory only) */
  @Column({ type: 'int', nullable: true })
  aiSeverityScore?: number | null;

  /** Issue #273: AI-suggested priority (advisory only, never auto-actioned) */
  @Column({ type: 'varchar', nullable: true })
  aiSuggestedPriority?: 'low' | 'medium' | 'high' | 'critical' | null;

  /** Issue #273: AI-identified categories (JSON array, advisory only) */
  @Column({ type: 'simple-json', nullable: true })
  aiCategories?: string[] | null;

  /** Issue #273: AI reasoning for the score (optional explanation) */
  @Column({ type: 'text', nullable: true })
  aiReasoning?: string | null;

  /** Issue #273: Which AI provider generated the score */
  @Column({ type: 'varchar', nullable: true })
  aiProvider?: string | null;

  /**
   * Explicit reporter consent for third-party AI pre-scoring (#295).
   * Defaults to false (consent withheld). AI triage is skipped when false;
   * the report itself is still filed normally.
   */
  @Column({ type: 'boolean', default: false })
  aiConsent!: boolean;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

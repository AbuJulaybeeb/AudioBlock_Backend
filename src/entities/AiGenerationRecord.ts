import { Entity, PrimaryGeneratedColumn, Column, CreateDateColumn } from 'typeorm';

/**
 * A minimal record of one AI generation request (ADR-007, point 3: "each AI
 * feature records, in its own table, a minimal event: the provider used,
 * what was sent (kind/scope descriptor, not the raw content), the date").
 *
 * This does NOT store raw song audio, lyrics, or files — only the generated
 * output (a description string or a result image URI) and enough metadata
 * to track and notify completion of the async job that produced it. Lyric
 * transcriptions (issue #285) are written to the Song itself, never here.
 */
@Entity('ai_generation_records')
export class AiGenerationRecord {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column()
  songId!: string;

  @Column()
  userId!: string;

  /** Which AI feature produced this record — matches `AiFeature` in aiFeatureFlags.ts. */
  @Column()
  feature!: 'coverArt' | 'descriptions' | 'lyricsTranscription';

  @Column({ default: 'pending' })
  status!: 'pending' | 'completed' | 'failed';

  @Column({ nullable: true })
  provider?: string;

  @Column({ type: 'text', nullable: true })
  resultText?: string;

  @Column({ nullable: true })
  resultUrl?: string;

  @Column({ type: 'text', nullable: true })
  errorMessage?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @Column({ type: 'timestamp', nullable: true })
  completedAt?: Date;
}

  /**
   * Estimated cost of this AI call in USD (issue #277). Set at request time
   * from provider pricing so per-artist usage can be aggregated without
   * vendor dashboards.
   */
  @Column({ type: 'decimal', precision: 12, scale: 6, nullable: true })
  estimatedCostUsd?: string | null;

  /** Approximate tokens consumed (issue #277), when the provider reports it. */
  @Column({ type: 'int', nullable: true })
  estimatedTokens?: number | null;
}

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
import { Genre } from './Genre';
import { TemplateSplit } from './RoyaltyTemplate';

@Entity('songs') // pluralize for convention
export class Song {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @ManyToOne(() => User, (user) => user.songs, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'artistId' }) // foreign key column
  user!: User;

  @Column()
  artistId!: string;

  @Column()
  coverArtPath!: string;

  @Column({ nullable: true })
  coverArtIpfsHash!: string;

  @Column({ type: 'simple-json', nullable: true })
  coverArtThumbnails!: { [key: string]: string } | null;

  @Column()
  title!: string;

  @Column({ nullable: true })
  description!: string;

  @Column({ nullable: true })
  genre!: string;

  @Column({ nullable: true })
  genreId!: string;

  @ManyToOne(() => Genre, (genre) => genre.songs, { nullable: true, onDelete: 'SET NULL' })
  @JoinColumn({ name: 'genreId' })
  genreEntity?: Genre;

  @Column({ nullable: true })
  artistAddress!: string;

  @Column({ nullable: true })
  s3OriginalUrl!: string;

  @Column({ nullable: true })
  hlsMasterUrl!: string;

  @Column({ nullable: true })
  ipfsCid!: string;

  @Column({ nullable: true })
  duration!: number;

  @Column({ nullable: true })
  loudness!: number; // LUFS

  @Column({ default: 'processing' })
  status!: 'processing' | 'ready' | 'failed';

  @Column({ type: 'text', nullable: true })
  errorReason!: string | null;

  @Column({ default: 0 })
  playCount!: number;

  @Column({ nullable: true })
  metadataCid!: string;

  /** On-chain minting state, independent of streaming readiness above. */
  @Column({ default: 'not_minted' })
  mintStatus!: 'not_minted' | 'pending' | 'minted' | 'failed';

  /** song_id returned by the catalog Soroban contract once minting succeeds. */
  @Column({ nullable: true })
  onChainSongId?: string;

  /** token_id of the song NFT, minted by the catalog Soroban contract. */
  @Column({ nullable: true })
  onChainTokenId?: string;

  @Column({ type: 'simple-json', nullable: true })
  metadata: any;

  @Column({ nullable: true })
  composers?: string;

  @Column({ default: false })
  flagged!: boolean;

  @Column({ type: 'timestamp', nullable: true })
  flaggedAt?: Date | null;

  @Column({ type: 'text', nullable: true })
  flaggedBy?: string | null;

  @Column({ type: 'text', nullable: true })
  flagReason?: string | null;

  @Column('simple-json', { nullable: true })
  royaltySplits?: TemplateSplit[];

  @Column({ type: 'text', nullable: true })
  lyrics?: string;

  @Column({ nullable: true })
  language?: string;

  /** Issue #284: Cached translations keyed by language code (#284). */
  @Column({ type: 'simple-json', nullable: true })
  translations?: Record<string, { title: string; description: string; artistName: string }>;

  /** Issue #269: AI-generated description draft for artist approval */
  @Column({ type: 'text', nullable: true })
  aiGeneratedDescription?: string | null;

  /** Issue #269: Whether artist approved the AI description for NFT metadata */
  @Column({ default: false })
  aiDescriptionApproved!: boolean;

  /** Issue #271: AI-generated cover art URL (before artist approval) */
  @Column({ type: 'text', nullable: true })
  aiGeneratedCoverUrl?: string | null;

  /**
   * Issue #285: AI lyric transcription draft. Kept separate from `lyrics` so
   * a transcription never overwrites lyrics the artist entered themselves.
   */
  @Column({ type: 'text', nullable: true })
  aiLyricsTranscription?: string | null;

  /** Issue #285: When the artist confirmed they hold the rights to transcribe these lyrics. */
  @Column({ type: 'timestamp', nullable: true })
  lyricsRightsConfirmedAt?: Date | null;

  /** Issue #285: User who confirmed the lyric rights. */
  @Column({ type: 'varchar', nullable: true })
  lyricsRightsConfirmedBy?: string | null;

  /** Issue #285: When the current transcription draft was produced. */
  @Column({ type: 'timestamp', nullable: true })
  aiLyricsTranscribedAt?: Date | null;

  /** Issue #272: Acoustic audio fingerprint for duplicate/plagiarism detection */
  @Column({ type: 'text', nullable: true })
  fingerprint?: string | null;

  /** Issue #272: Flag indicating track was detected as near-duplicate */
  @Column({ default: false })
  isNearDuplicate!: boolean;

  /** Issue #272: ID of the existing song this track is similar to */
  @Column({ nullable: true })
  duplicateOfSongId?: string | null;

  /** Issue #272: Similarity score (0.0 - 1.0) with matched song */
  @Column({ type: 'float', nullable: true })
  duplicateSimilarityScore?: number | null;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;
}

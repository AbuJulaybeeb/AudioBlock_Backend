import { IsEmail } from 'class-validator';
import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  Unique,
  OneToMany,
} from 'typeorm';
import { Song } from './Song';
import { TransactionLog } from './TransactionLog';
import { Album } from './Album';
import { RoyaltyPayout } from './RoyaltyPayout';

export enum UserRole {
  // `listener` is the default role for a regular platform user.
  LISTENER = 'listener',
  ARTIST = 'artist',
  // `moderator` can act on content (flag/unflag) without full admin rights.
  MODERATOR = 'moderator',
  ADMIN = 'admin',
  // `super_admin` holds every permission, including managing other admins.
  SUPER_ADMIN = 'super_admin',
}

@Entity('users')
@Unique(['walletAddress', 'email', 'username'])
export class User {
  @PrimaryGeneratedColumn('uuid')
  id!: string;

  @Column({ unique: true, nullable: true })
  dynamixUserId?: string;

  /**
   * Privy identity id (`did:privy:...`) linked to this account.
   *
   * Set the first time the user authenticates via Privy (Issue #600). A Privy
   * access token carries this value in `sub`, so it is the join key between a
   * Privy session and a local account. Unique, so a Privy identity can map to at
   * most one local user, and nullable, so legacy-only accounts are unaffected.
   */
  @Column({ unique: true, nullable: true })
  privyUserId?: string;

  @Column({ nullable: true })
  profileImage?: string;

  @Column({
    type: 'simple-enum',
    enum: UserRole,
    default: UserRole.LISTENER,
  })
  role!: UserRole;

  /** Optional: only set for users who authenticate with a wallet signature. */
  @Column({ nullable: true })
  walletAddress?: string;

  /** Optional: only set for users who authenticate with email + password. */
  @Column({ nullable: true })
  passwordHash?: string;

  @Column({ default: false })
  twoFactorEnabled!: boolean;

  @Column({ default: false })
  emailVerified!: boolean;

  @Column({ nullable: true })
  twoFactorSecret?: string;

  @Column({ nullable: true })
  emailVerificationToken?: string;

  @Column({ nullable: true })
  emailVerificationTokenExpiry?: Date;

  @Column({ nullable: true })
  passwordResetToken?: string;

  @Column({ nullable: true })
  passwordResetTokenExpiry?: Date;

  @Column('simple-json', { nullable: true })
  twoFactorRecoveryCodeHashes?: string[];

  /** Stellar G... public key the artist connected (e.g. via Freighter) for Soroban actions. */
  @Column({ unique: true, nullable: true })
  stellarPublicKey?: string;

  /** artist_id returned by the artist Soroban contract once on-chain setup succeeds. */
  @Column({ nullable: true })
  stellarArtistId?: string;

  /** token_id of the artist's profile NFT, minted by the artist Soroban contract. */
  @Column({ nullable: true })
  stellarArtistTokenId?: string;

  @Column({ unique: true, nullable: true })
  username?: string;

  @Column({ unique: true, nullable: true })
  name?: string;

  @Column({ unique: true, nullable: true })
  @IsEmail()
  email?: string;

  @Column('float', { default: 0 })
  rewardPoints!: number;

  @Column({ nullable: true })
  bio?: string;

  @Column({ nullable: true })
  pageCover?: string;

  @Column({ nullable: true })
  website?: string;

  @Column({ nullable: true })
  twitterId?: string;

  @Column({ nullable: true })
  twitterUsername?: string;

  @Column({ nullable: true })
  twitterDisplayName?: string;

  @Column({ nullable: true })
  twitterProfileImage?: string;

  @Column({ default: false })
  twitterVerified?: boolean;

  @Column({ nullable: true })
  twitterConnected?: boolean;

  @Column({ nullable: true })
  facebookId?: string;

  @Column({ nullable: true })
  facebookName?: string;

  @Column({ nullable: true })
  facebookEmail?: string;

  @Column({ nullable: true })
  facebookProfileImage?: string;

  @Column({ default: false })
  facebookConnected?: boolean;

  /** IPFS hash of the user's avatar (Issue #83). */
  @Column({ nullable: true })
  avatarIpfsHash?: string;

  /** Whether the user's profile is publicly visible (Issue #83). */
  @Column({ default: true })
  isProfilePublic!: boolean;

  /** Per-artist opt-in flag gating AI Studio upload tools (cover art, descriptions, tag suggestions, draft tweets). */
  @Column({ default: false })
  aiStudioEnabled!: boolean;

  // ── Account lifecycle (Issue #633, GDPR Art. 12/17) ─────────────────────────
  // A deletion request does not erase immediately. The user gets a grace window
  // in which they can export their data or cancel, after which a background job
  // performs the erasure. These three columns are that state machine:
  // requested -> (cancelled) or (grace elapses) -> anonymised.

  /** When the user requested account deletion, or null if never requested. */
  @Column({ nullable: true })
  deletionRequestedAt?: Date;

  /** End of the grace window; the erasure job acts on accounts past this point. */
  @Column({ nullable: true })
  deletionScheduledFor?: Date;

  /**
   * When erasure completed. Non-null means the row is a tombstone: personal
   * fields have been scrubbed and the account can no longer authenticate.
   */
  @Column({ nullable: true })
  deletedAt?: Date;

  /** Free-text reason the user gave for leaving, if any. Retained, never PII-bearing. */
  @Column({ nullable: true })
  deletionReason?: string;

  @CreateDateColumn()
  createdAt!: Date;

  @UpdateDateColumn()
  updatedAt!: Date;

  // One user has many songs
  @OneToMany(() => Song, (song) => song.user)
  songs!: Song[];

  // One user has many albums
  @OneToMany(() => Album, (album) => album.user)
  albums!: Album[];

  // One user has many transaction logs
  @OneToMany(() => TransactionLog, (log) => log.user)
  transactionLogs!: TransactionLog[];

  @OneToMany(() => RoyaltyPayout, (payout) => payout.artist)
  royaltyPayouts!: RoyaltyPayout[];
}

import { In, Repository } from 'typeorm';
import AppDataSource from '../../config/db';
import { AiGenerationRecord } from '../../entities/AiGenerationRecord';
import { TweetDraft } from '../../entities/TweetDraft';
import { User } from '../../entities/User';

/** Outcome buckets an AI request can land in. */
export interface AiUsageCounts {
  total: number;
  completed: number;
  failed: number;
  pending: number;
  /** Sum of estimatedCostUsd across rows (issue #277). */
  estimatedCostUsd: number;
  /** Sum of estimatedTokens across rows (issue #277). */
  estimatedTokens: number;
}

export interface AiFeatureUsage extends AiUsageCounts {
  feature: string;
}

export interface AiArtistUsage extends AiUsageCounts {
  artistId: string;
  artistName: string | null;
  /** Request count per feature for this artist. */
  byFeature: Record<string, number>;
}

export interface AiUsageSummary {
  range: { from: string | null; to: string | null };
  totals: AiUsageCounts;
  byFeature: AiFeatureUsage[];
  /** Artists ordered by total AI requests, heaviest first, capped at `artistLimit`. */
  byArtist: AiArtistUsage[];
  /** Number of distinct artists that used AI features in the range. */
  artistCount: number;
}

export interface AiUsageQuery {
  from?: Date;
  to?: Date;
  artistLimit?: number;
}

interface UsageRow {
  feature: string;
  userId: string;
  status: string;
  count: string | number;
}

const emptyCounts = (): AiUsageCounts => ({ total: 0, completed: 0, failed: 0, pending: 0, estimatedCostUsd: 0, estimatedTokens: 0 });

function addToCounts(
  counts: AiUsageCounts,
  status: string,
  n: number,
  costUsd = 0,
  tokens = 0,
): void {
  counts.total += n;
  if (status === 'completed' || status === 'failed' || status === 'pending') {
    counts[status] += n;
  }
  counts.estimatedCostUsd += costUsd;
  counts.estimatedTokens += tokens;
}

/**
 * Platform-wide AI usage for the admin dashboard (issue #289).
 *
 * Usage is derived from the per-feature records each AI feature already
 * keeps (ADR-007, point 3) — `ai_generation_records` (cover art,
 * descriptions, lyric transcription) and `tweet_drafts` — so no extra
 * tracking table is needed. Aggregation happens in SQL with one GROUP BY per
 * source; only the grouped rows are folded together here.
 */
export class AiUsageService {
  private recordRepo: Repository<AiGenerationRecord>;
  private tweetDraftRepo: Repository<TweetDraft>;
  private userRepo: Repository<User>;

  constructor() {
    this.recordRepo = AppDataSource.getRepository(AiGenerationRecord);
    this.tweetDraftRepo = AppDataSource.getRepository(TweetDraft);
    this.userRepo = AppDataSource.getRepository(User);
  }

  async getUsageSummary(query: AiUsageQuery = {}): Promise<AiUsageSummary> {
    const artistLimit = query.artistLimit ?? 50;
    const [generationRows, draftRows] = await Promise.all([
      this.groupedGenerationUsage(query),
      this.groupedTweetDraftUsage(query),
    ]);

    const totals = emptyCounts();
    const features = new Map<string, AiFeatureUsage>();
    const artists = new Map<string, AiArtistUsage>();

    for (const row of [...generationRows, ...draftRows]) {
      const n = Number(row.count) || 0;
      if (n === 0) continue;

      addToCounts(totals, row.status, n);

      let feature = features.get(row.feature);
      if (!feature) {
        feature = { feature: row.feature, ...emptyCounts() };
        features.set(row.feature, feature);
      }
      addToCounts(feature, row.status, n);

      let artist = artists.get(row.userId);
      if (!artist) {
        artist = { artistId: row.userId, artistName: null, byFeature: {}, ...emptyCounts() };
        artists.set(row.userId, artist);
      }
      addToCounts(artist, row.status, n);
      artist.byFeature[row.feature] = (artist.byFeature[row.feature] ?? 0) + n;
    }

    const byArtist = [...artists.values()]
      .sort((a, b) => b.total - a.total || a.artistId.localeCompare(b.artistId))
      .slice(0, artistLimit);
    await this.attachArtistNames(byArtist);

    return {
      range: {
        from: query.from ? query.from.toISOString() : null,
        to: query.to ? query.to.toISOString() : null,
      },
      totals,
      byFeature: [...features.values()].sort(
        (a, b) => b.total - a.total || a.feature.localeCompare(b.feature),
      ),
      byArtist,
      artistCount: artists.size,
    };
  }

  private async groupedGenerationUsage(query: AiUsageQuery): Promise<UsageRow[]> {
    const qb = this.recordRepo
      .createQueryBuilder('r')
      .select('r.feature', 'feature')
      .addSelect('r.userId', 'userId')
      .addSelect('r.status', 'status')
      .addSelect('COUNT(*)', 'count')
      .groupBy('r.feature')
      .addGroupBy('r.userId')
      .addGroupBy('r.status');
    this.applyRange(qb, 'r', query);
    return qb.getRawMany<UsageRow>();
  }

  /**
   * Tweet drafts are generated synchronously, so every row is a completed
   * AI call regardless of whether the artist later approved it.
   */
  private async groupedTweetDraftUsage(query: AiUsageQuery): Promise<UsageRow[]> {
    const qb = this.tweetDraftRepo
      .createQueryBuilder('d')
      .select('d.userId', 'userId')
      .addSelect('COUNT(*)', 'count')
      .groupBy('d.userId');
    this.applyRange(qb, 'd', query);
    const rows = await qb.getRawMany<{ userId: string; count: string | number }>();
    return rows.map((row) => ({ ...row, feature: 'tweetDrafts', status: 'completed' }));
  }

  private applyRange(
    qb: ReturnType<Repository<AiGenerationRecord>['createQueryBuilder']>,
    alias: string,
    query: AiUsageQuery,
  ): void {
    if (query.from) qb.andWhere(`${alias}.createdAt >= :from`, { from: query.from });
    if (query.to) qb.andWhere(`${alias}.createdAt <= :to`, { to: query.to });
  }

  private async attachArtistNames(artists: AiArtistUsage[]): Promise<void> {
    if (artists.length === 0) return;
    const users = await this.userRepo.find({
      where: { id: In(artists.map((a) => a.artistId)) },
      select: { id: true, name: true, username: true },
    });
    const names = new Map(users.map((u) => [u.id, u.name || u.username || null]));
    for (const artist of artists) {
      artist.artistName = names.get(artist.artistId) ?? null;
    }
  }
}

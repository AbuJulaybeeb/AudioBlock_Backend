import { Repository } from 'typeorm';
import AppDataSource from '../../config/db';
import { Song } from '../../entities/Song';
import { SongPlayEvent } from '../../entities/SongPlayEvent';
import { SongSave } from '../../entities/SongSave';
import { RoyaltyPayout } from '../../entities/RoyaltyPayout';
import { AppError } from '../../errors/AppError';
import { CacheService } from '../CacheService';

/** Supported statistics time windows (Issue #87). */
export type StatsWindow = '7d' | '30d' | '90d' | 'all-time';

export const STATS_WINDOWS: StatsWindow[] = ['7d', '30d', '90d', 'all-time'];

/** Cache lifetime for computed statistics — 5 minutes per the acceptance criteria. */
export const STATS_CACHE_TTL_MS = 5 * 60 * 1000;

const WINDOW_DAYS: Record<Exclude<StatsWindow, 'all-time'>, number> = {
  '7d': 7,
  '30d': 30,
  '90d': 90,
};

/** Aggregated counters for one period. */
export interface StatsTotals {
  plays: number;
  saves: number;
  revenueStroops: string;
  uniqueListeners: number;
}

/** Percentage deltas of the current period against the immediately previous one. */
export interface StatsComparison {
  plays: number | null;
  saves: number | null;
  revenue: number | null;
  uniqueListeners: number | null;
}

export interface SongStats {
  songId: string;
  window: StatsWindow;
  periodStart: string | null;
  periodEnd: string;
  totals: StatsTotals;
  previous: StatsTotals | null;
  comparison: StatsComparison | null;
  generatedAt: string;
}

export interface ArtistStats {
  artistId: string;
  window: StatsWindow;
  periodStart: string | null;
  periodEnd: string;
  songCount: number;
  totals: StatsTotals;
  previous: StatsTotals | null;
  comparison: StatsComparison | null;
  topSongs: { songId: string; title: string; plays: number }[];
  generatedAt: string;
}

/** Lifetime stream figures for an artist, derived from play events. */
export interface ArtistLifetimeTotals {
  totalStreams: number;
  /** Sum of the played songs' durations (seconds), one full duration per play. */
  totalStreamTime: number;
  uniqueListeners: number;
}

/** Parse and validate a `window` query parameter, defaulting to 30d. */
export function parseWindow(raw: unknown): StatsWindow {
  if (raw === undefined || raw === null || raw === '') return '30d';
  const value = String(raw);
  if (!STATS_WINDOWS.includes(value as StatsWindow)) {
    throw AppError.validation(
      `Invalid window. Supported values: ${STATS_WINDOWS.join(', ')}`,
      { field: 'window', value },
      'INVALID_STATS_WINDOW',
    );
  }
  return value as StatsWindow;
}

/**
 * Percentage change from `previous` to `current`, rounded to one decimal.
 *
 * Returns null when there is no baseline to compare against (previous is 0),
 * so callers can render "n/a" rather than a misleading 0% or infinity.
 */
function percentChange(current: number, previous: number): number | null {
  if (previous === 0) return current === 0 ? 0 : null;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function comparisonOf(current: StatsTotals, previous: StatsTotals): StatsComparison {
  return {
    plays: percentChange(current.plays, previous.plays),
    saves: percentChange(current.saves, previous.saves),
    revenue: percentChange(Number(current.revenueStroops), Number(previous.revenueStroops)),
    uniqueListeners: percentChange(current.uniqueListeners, previous.uniqueListeners),
  };
}

/** Inclusive start / exclusive end boundaries for a window and its predecessor. */
interface Period {
  start: Date | null;
  end: Date;
  prevStart: Date | null;
  prevEnd: Date | null;
}

function resolvePeriod(window: StatsWindow, now: Date): Period {
  if (window === 'all-time') {
    return { start: null, end: now, prevStart: null, prevEnd: null };
  }
  const days = WINDOW_DAYS[window];
  const ms = days * 24 * 60 * 60 * 1000;
  const start = new Date(now.getTime() - ms);
  return {
    start,
    end: now,
    prevStart: new Date(start.getTime() - ms),
    prevEnd: start,
  };
}

/**
 * Aggregated play / save / revenue analytics for songs and artists (Issue #87).
 *
 * Results are cached for {@link STATS_CACHE_TTL_MS} keyed by entity and window
 * so repeated dashboard polling does not re-run the aggregation queries.
 */
export class SongStatsService {
  private songRepo: Repository<Song>;
  private playRepo: Repository<SongPlayEvent>;
  private saveRepo: Repository<SongSave>;
  private payoutRepo: Repository<RoyaltyPayout>;

  constructor() {
    this.songRepo = AppDataSource.getRepository(Song);
    this.playRepo = AppDataSource.getRepository(SongPlayEvent);
    this.saveRepo = AppDataSource.getRepository(SongSave);
    this.payoutRepo = AppDataSource.getRepository(RoyaltyPayout);
  }

  /**
   * Aggregated statistics for a single song over `window`.
   *
   * @param songId - ID of the song.
   * @param window - One of 7d / 30d / 90d / all-time.
   * @throws {AppError} 404 when the song does not exist.
   */
  async getSongStats(songId: string, window: StatsWindow): Promise<SongStats> {
    const cacheKey = `stats:song:${songId}:${window}`;
    const cached = await CacheService.get<SongStats>(cacheKey);
    if (cached) return cached;

    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }

    const now = new Date();
    const period = resolvePeriod(window, now);

    const totals = await this.totalsForSongs([songId], period.start, period.end);
    const previous =
      period.prevStart && period.prevEnd
        ? await this.totalsForSongs([songId], period.prevStart, period.prevEnd)
        : null;

    const stats: SongStats = {
      songId,
      window,
      periodStart: period.start ? period.start.toISOString() : null,
      periodEnd: period.end.toISOString(),
      totals,
      previous,
      comparison: previous ? comparisonOf(totals, previous) : null,
      generatedAt: now.toISOString(),
    };

    await CacheService.set(cacheKey, stats, STATS_CACHE_TTL_MS);
    return stats;
  }

  /**
   * Artist-level aggregation across every song the artist owns, plus their
   * top 5 songs by plays inside the window.
   *
   * @param artistId - ID of the artist User.
   * @param window - One of 7d / 30d / 90d / all-time.
   * @throws {AppError} 404 when the artist owns no songs.
   */
  async getArtistStats(artistId: string, window: StatsWindow): Promise<ArtistStats> {
    const cacheKey = `stats:artist:${artistId}:${window}`;
    const cached = await CacheService.get<ArtistStats>(cacheKey);
    if (cached) return cached;

    const songs = await this.songRepo.find({
      where: { artistId },
      select: ['id', 'title'],
    });
    if (songs.length === 0) {
      throw AppError.notFound('No songs found for this artist', undefined, 'ARTIST_HAS_NO_SONGS');
    }

    const songIds = songs.map((s) => s.id);
    const now = new Date();
    const period = resolvePeriod(window, now);

    const totals = await this.totalsForSongs(songIds, period.start, period.end);
    const previous =
      period.prevStart && period.prevEnd
        ? await this.totalsForSongs(songIds, period.prevStart, period.prevEnd)
        : null;

    const playsBySong = await this.playsPerSong(songIds, period.start, period.end);
    const titles = new Map(songs.map((s) => [s.id, s.title]));
    const topSongs = [...playsBySong.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([songId, plays]) => ({ songId, title: titles.get(songId) ?? '', plays }));

    const stats: ArtistStats = {
      artistId,
      window,
      periodStart: period.start ? period.start.toISOString() : null,
      periodEnd: period.end.toISOString(),
      songCount: songs.length,
      totals,
      previous,
      comparison: previous ? comparisonOf(totals, previous) : null,
      topSongs,
      generatedAt: now.toISOString(),
    };

    await CacheService.set(cacheKey, stats, STATS_CACHE_TTL_MS);
    return stats;
  }

  /**
   * Lifetime plays, listening time and unique listeners across every song the
   * artist owns, computed from `song_play_events` (Issue #807). An artist with
   * no songs gets zeros rather than a 404.
   *
   * @param artistId - ID of the artist User.
   */
  async getArtistLifetimeTotals(artistId: string): Promise<ArtistLifetimeTotals> {
    const cacheKey = `stats:artist:${artistId}:lifetime`;
    const cached = await CacheService.get<ArtistLifetimeTotals>(cacheKey);
    if (cached) return cached;

    const songs = await this.songRepo.find({ where: { artistId }, select: ['id'] });
    const songIds = songs.map((s) => s.id);

    let totals: ArtistLifetimeTotals = { totalStreams: 0, totalStreamTime: 0, uniqueListeners: 0 };
    if (songIds.length > 0) {
      const end = new Date();
      const [totalStreams, uniqueListeners, timeRow] = await Promise.all([
        this.countPlays(songIds, null, end),
        this.countUniqueListeners(songIds, null, end),
        this.playRepo
          .createQueryBuilder('play')
          .innerJoin('play.song', 'song')
          .select('COALESCE(SUM(song.duration), 0)', 'total')
          .where('play.songId IN (:...songIds)', { songIds })
          .andWhere('play.playedAt < :end', { end })
          .getRawOne<{ total: string | number | null }>(),
      ]);
      totals = { totalStreams, totalStreamTime: Number(timeRow?.total ?? 0), uniqueListeners };
    }

    await CacheService.set(cacheKey, totals, STATS_CACHE_TTL_MS);
    return totals;
  }

  /** Drop cached statistics for a song and its artist after a data change. */
  async invalidateSong(songId: string, artistId?: string): Promise<void> {
    await CacheService.invalidatePattern(`stats:song:${songId}:*`);
    if (artistId) {
      await CacheService.invalidatePattern(`stats:artist:${artistId}:*`);
    }
  }

  /** Sum plays, saves, revenue, and unique listeners for a set of songs. */
  private async totalsForSongs(
    songIds: string[],
    start: Date | null,
    end: Date,
  ): Promise<StatsTotals> {
    const [plays, saves, revenueStroops, uniqueListeners] = await Promise.all([
      this.countPlays(songIds, start, end),
      this.countSaves(songIds, start, end),
      this.sumRevenue(songIds, start, end),
      this.countUniqueListeners(songIds, start, end),
    ]);

    return { plays, saves, revenueStroops, uniqueListeners };
  }

  private async countPlays(songIds: string[], start: Date | null, end: Date): Promise<number> {
    const qb = this.playRepo
      .createQueryBuilder('play')
      .where('play.songId IN (:...songIds)', { songIds })
      .andWhere('play.playedAt < :end', { end });
    if (start) qb.andWhere('play.playedAt >= :start', { start });
    return qb.getCount();
  }

  private async countSaves(songIds: string[], start: Date | null, end: Date): Promise<number> {
    const qb = this.saveRepo
      .createQueryBuilder('save')
      .where('save.songId IN (:...songIds)', { songIds })
      .andWhere('save.savedAt < :end', { end });
    if (start) qb.andWhere('save.savedAt >= :start', { start });
    return qb.getCount();
  }

  /**
   * Gross revenue in stroops attributed to the given songs. RoyaltyPayout is
   * the settled-sale record, so it is the authoritative revenue source.
   */
  private async sumRevenue(songIds: string[], start: Date | null, end: Date): Promise<string> {
    const qb = this.payoutRepo
      .createQueryBuilder('payout')
      .select('COALESCE(SUM(payout.grossAmountStroops), 0)', 'total')
      .where('payout.songId IN (:...songIds)', { songIds })
      .andWhere('payout.createdAt < :end', { end });
    if (start) qb.andWhere('payout.createdAt >= :start', { start });

    const row = await qb.getRawOne<{ total: string | number | null }>();
    // SUM over bigint comes back as a string in postgres; normalise to string
    // so large stroop totals never lose precision through a JS number.
    return String(row?.total ?? 0);
  }

  /**
   * Distinct listeners in the period. Authenticated plays are counted by
   * `listenerId`; anonymous plays fall back to the hashed `listenerKey`.
   */
  private async countUniqueListeners(
    songIds: string[],
    start: Date | null,
    end: Date,
  ): Promise<number> {
    const qb = this.playRepo
      .createQueryBuilder('play')
      .select('play.listenerId', 'listenerId')
      .addSelect('play.listenerKey', 'listenerKey')
      .where('play.songId IN (:...songIds)', { songIds })
      .andWhere('play.playedAt < :end', { end })
      .andWhere('(play.listenerId IS NOT NULL OR play.listenerKey IS NOT NULL)');
    if (start) qb.andWhere('play.playedAt >= :start', { start });

    const rows = await qb.getRawMany<{
      listenerId: string | null;
      listenerKey: string | null;
    }>();

    const identities = new Set<string>();
    for (const row of rows) {
      if (row.listenerId) identities.add(`u:${row.listenerId}`);
      else if (row.listenerKey) identities.add(`k:${row.listenerKey}`);
    }
    return identities.size;
  }

  /** Play counts keyed by song id, used for the artist's top-songs list. */
  private async playsPerSong(
    songIds: string[],
    start: Date | null,
    end: Date,
  ): Promise<Map<string, number>> {
    const qb = this.playRepo
      .createQueryBuilder('play')
      .select('play.songId', 'songId')
      .addSelect('COUNT(*)', 'plays')
      .where('play.songId IN (:...songIds)', { songIds })
      .andWhere('play.playedAt < :end', { end })
      .groupBy('play.songId');
    if (start) qb.andWhere('play.playedAt >= :start', { start });

    const rows = await qb.getRawMany<{ songId: string; plays: string | number }>();
    return new Map(rows.map((r) => [r.songId, Number(r.plays)]));
  }
}

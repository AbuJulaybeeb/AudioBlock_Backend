/**
 * Unit tests for the precomputed search index (Issue #135).
 * Backed by a small in-memory Redis mock so the inverted-index logic is
 * exercised end-to-end without a live Redis.
 */
import 'reflect-metadata';

jest.mock('../config/redis', () => {
  const sets = new Map<string, Set<string>>();
  const strings = new Map<string, string>();

  const _sadd = (k: string, m: string) => {
    if (!sets.has(k)) sets.set(k, new Set());
    sets.get(k)!.add(m);
    return 1;
  };
  const _srem = (k: string, m: string) => {
    sets.get(k)?.delete(m);
    return 1;
  };
  const _smembers = (k: string) => Array.from(sets.get(k) ?? []);
  const _set = (k: string, v: string) => {
    strings.set(k, v);
    return 'OK';
  };
  const _get = (k: string) => (strings.has(k) ? strings.get(k)! : null);
  const _del = (k: string) => {
    strings.delete(k);
    sets.delete(k);
    return 1;
  };

  const pipeline = () => {
    const ops: Array<() => any> = [];
    const api: any = {
      sadd: (k: string, m: string) => (ops.push(() => _sadd(k, m)), api),
      srem: (k: string, m: string) => (ops.push(() => _srem(k, m)), api),
      set: (k: string, v: string) => (ops.push(() => _set(k, v)), api),
      del: (k: string) => (ops.push(() => _del(k)), api),
      smembers: (k: string) => (ops.push(() => _smembers(k)), api),
      exec: async () => ops.map((fn) => [null, fn()]),
    };
    return api;
  };

  return {
    __esModule: true,
    default: {
      pipeline,
      get: async (k: string) => _get(k),
      smembers: async (k: string) => _smembers(k),
      set: async (k: string, v: string) => _set(k, v),
      del: async (k: string) => _del(k),
      srem: async (k: string, m: string) => _srem(k, m),
      __reset: () => {
        sets.clear();
        strings.clear();
      },
    },
  };
});

import redis from '../config/redis';
import { SearchIndexService, tokenize } from '../services/SearchIndexService';
import { installFakeAi } from '../../tests/helpers/fakeAi';

beforeEach(() => {
  (redis as any).__reset();
  // indexSong stores an embedding via the AI provider (#274) — keep it on the shared fake.
  installFakeAi();
});

describe('tokenize', () => {
  it('lowercases, splits on non-alphanumerics and dedupes', () => {
    expect(tokenize('Hello, WORLD! hello')).toEqual(['hello', 'world']);
  });

  it('drops single-character tokens and empties', () => {
    expect(tokenize('a big I O song')).toEqual(['big', 'song']);
  });
});

describe('SearchIndexService', () => {
  const songA = {
    id: 'a',
    title: 'Midnight Dreams',
    genre: 'lofi',
    user: { name: 'Luna' },
  };
  const songB = {
    id: 'b',
    title: 'Midnight City',
    genre: 'synthwave',
    user: { name: 'Neon' },
  };

  it('indexes a song and finds it by a title token', async () => {
    await SearchIndexService.indexSong(songA);
    const ids = await SearchIndexService.search('dreams');
    expect(ids).toEqual(['a']);
  });

  it('ranks songs matching more query tokens higher', async () => {
    await SearchIndexService.indexSong(songA); // "midnight dreams"
    await SearchIndexService.indexSong(songB); // "midnight city"

    // Both match "midnight"; only A matches "dreams" → A ranks first.
    const ids = await SearchIndexService.search('midnight dreams');
    expect(ids[0]).toBe('a');
    expect(ids).toContain('b');
  });

  it('returns an empty array on an index miss (caller falls back to DB)', async () => {
    await SearchIndexService.indexSong(songA);
    expect(await SearchIndexService.search('nonexistentterm')).toEqual([]);
  });

  it('removes a song from the index', async () => {
    await SearchIndexService.indexSong(songA);
    await SearchIndexService.removeSong('a');
    expect(await SearchIndexService.search('dreams')).toEqual([]);
  });

  it('re-indexing drops stale tokens from a previous version', async () => {
    await SearchIndexService.indexSong(songA); // "midnight dreams"
    await SearchIndexService.indexSong({ ...songA, title: 'Sunrise' }); // retitled

    expect(await SearchIndexService.search('dreams')).toEqual([]);
    expect(await SearchIndexService.search('sunrise')).toEqual(['a']);
  });
});

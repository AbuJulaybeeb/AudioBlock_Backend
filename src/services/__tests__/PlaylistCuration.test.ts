import { PlaylistService } from '../PlaylistService';
import { FakeAIAdapter, installFakeAi } from '../../../tests/helpers/fakeAi';
import { Song } from '../../entities/Song';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: {
    getRepository: jest.fn(),
  },
}));

describe('AI Mood/Prompt-based Playlist Curation (Issue #275)', () => {
  let playlistService: PlaylistService;
  let mockSongRepo: any;
  let mockPlaylistRepo: any;
  let mockPlaylistSongRepo: any;
  let mockCollaboratorRepo: any;
  let mockFollowRepo: any;
  let mockAiAdapter: FakeAIAdapter;

  const sampleTracks: Partial<Song>[] = [
    {
      id: 'song-1',
      title: 'Midnight Lo-Fi Chill',
      genre: 'Lo-Fi',
      playCount: 1500,
      status: 'ready',
    },
    {
      id: 'song-2',
      title: 'Deep Focus Coding Beats',
      genre: 'Ambient',
      playCount: 950,
      status: 'ready',
    },
    {
      id: 'song-3',
      title: 'Coffee Shop Rain',
      genre: 'Lo-Fi',
      playCount: 800,
      status: 'ready',
    },
  ];

  beforeEach(() => {
    // PlaylistService resolves the getAIProviderService() singleton, so the
    // shared fake is installed globally rather than injected.
    mockAiAdapter = installFakeAi().adapter;
    mockAiAdapter.textResponse = JSON.stringify({
      playlistName: 'Chill Coding Flow',
      description: 'Soothing beats and ambient textures for deep work',
      targetGenres: ['Lo-Fi', 'Ambient'],
      targetTags: ['chill', 'focus', 'study'],
    });

    mockPlaylistRepo = {
      create: jest.fn(),
      save: jest.fn(),
      findOneBy: jest.fn(),
    };

    mockPlaylistSongRepo = {
      save: jest.fn(),
    };

    mockCollaboratorRepo = {
      findOneBy: jest.fn(),
    };

    mockFollowRepo = {
      countBy: jest.fn(),
    };

    mockSongRepo = {
      find: jest.fn().mockResolvedValue(sampleTracks),
      createQueryBuilder: jest.fn().mockReturnValue({
        leftJoinAndSelect: jest.fn().mockReturnThis(),
        where: jest.fn().mockReturnThis(),
        andWhere: jest.fn().mockReturnThis(),
        orderBy: jest.fn().mockReturnThis(),
        take: jest.fn().mockReturnThis(),
        getMany: jest.fn().mockResolvedValue(sampleTracks),
      }),
    };

    const AppDataSource = require('../../config/db').default;
    AppDataSource.getRepository.mockImplementation((entity: any) => {
      const name = entity?.name || (typeof entity === 'function' ? entity.name : '');
      if (name === 'Song') return mockSongRepo;
      if (name === 'PlaylistSong') return mockPlaylistSongRepo;
      if (name === 'PlaylistCollaborator') return mockCollaboratorRepo;
      if (name === 'PlaylistFollow') return mockFollowRepo;
      return mockPlaylistRepo;
    });

    playlistService = new PlaylistService();
  });

  it('should return candidate tracks without creating a playlist in the database', async () => {
    const result = await playlistService.curateCandidatePlaylist('user-123', {
      prompt: 'chill focus music for late night coding',
      limit: 10,
    });

    // Verification of Acceptance Criteria:
    // 1. Returns a candidate list with suggested title and description
    expect(result.prompt).toBe('chill focus music for late night coding');
    expect(result.suggestedName).toBe('Chill Coding Flow');
    expect(result.suggestedDescription).toBe('Soothing beats and ambient textures for deep work');
    expect(result.candidateTracks).toHaveLength(3);
    expect(result.matchedGenres).toEqual(['Lo-Fi', 'Ambient']);
    expect(result.matchedTags).toEqual(['chill', 'focus', 'study']);

    // 2. Does NOT silently create/save a playlist entity
    expect(mockPlaylistRepo.create).not.toHaveBeenCalled();
    expect(mockPlaylistRepo.save).not.toHaveBeenCalled();
    expect(mockPlaylistSongRepo.save).not.toHaveBeenCalled();
  });

  it('should reject requests with empty or whitespace prompt', async () => {
    await expect(
      playlistService.curateCandidatePlaylist('user-123', { prompt: '   ' }),
    ).rejects.toThrow('A curation prompt is required');
  });

  it('should fall back gracefully to prompt keywords if AI provider fails', async () => {
    mockAiAdapter.configure({ failWith: new Error('AI provider connection timeout') });

    const result = await playlistService.curateCandidatePlaylist('user-123', {
      prompt: 'cyberpunk synthwave workout',
    });

    expect(result.candidateTracks).toBeDefined();
    expect(result.matchedTags).toContain('cyberpunk');
    expect(result.matchedGenres).toContain('synthwave');
    // Ensure no playlist is created even on fallback
    expect(mockPlaylistRepo.save).not.toHaveBeenCalled();
  });
});

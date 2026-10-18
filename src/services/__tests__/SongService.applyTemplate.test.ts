import 'reflect-metadata';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../../config/s3', () => ({ s3: {} }));
jest.mock('../../config/rabbitmq', () => ({ getChannel: jest.fn() }));
jest.mock('../Soroban/SorobanService', () => ({
  SorobanService: jest.fn(),
  addressArg: jest.fn(),
  stringArg: jest.fn(),
  u64Arg: jest.fn(),
}));

import AppDataSource from '../../config/db';
import { SongService } from '../SongService';

describe('SongService.applyTemplate', () => {
  const songRepo = { findOneBy: jest.fn(), save: jest.fn((s) => Promise.resolve(s)) };
  const templateRepo = { findOneBy: jest.fn() };
  const splits = [{ userId: 'artist-1', role: 'primary', percentage: 100 }];

  beforeEach(() => {
    jest.clearAllMocks();
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: { name: string }) =>
      entity.name === 'RoyaltyTemplate' ? templateRepo : songRepo,
    );
    templateRepo.findOneBy.mockResolvedValue({ id: 't1', userId: 'artist-1', splits });
  });

  it('applies the template splits before minting', async () => {
    songRepo.findOneBy.mockResolvedValue({
      id: 's1',
      artistId: 'artist-1',
      mintStatus: 'not_minted',
    });

    const song = await new SongService().applyTemplate('s1', 't1', 'artist-1');

    expect(song.royaltySplits).toEqual(splits);
  });

  it.each(['pending', 'minted'])('returns 409 once mintStatus is %s', async (mintStatus) => {
    songRepo.findOneBy.mockResolvedValue({ id: 's1', artistId: 'artist-1', mintStatus });

    await expect(new SongService().applyTemplate('s1', 't1', 'artist-1')).rejects.toMatchObject({
      statusCode: 409,
    });
    expect(songRepo.save).not.toHaveBeenCalled();
  });
});

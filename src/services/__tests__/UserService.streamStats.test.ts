import 'reflect-metadata';
import { getMetadataArgsStorage } from 'typeorm';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../../config/redis', () => ({
  __esModule: true,
  default: { set: jest.fn(), get: jest.fn(), del: jest.fn() },
}));

const mockGetArtistLifetimeTotals = jest.fn();
jest.mock('../Song/SongStatsService', () => ({
  SongStatsService: jest.fn().mockImplementation(() => ({
    getArtistLifetimeTotals: mockGetArtistLifetimeTotals,
  })),
}));

import AppDataSource from '../../config/db';
import { UserService } from '../UserService';
import { User, UserRole } from '../../entities/User';
import { CreateUserDTO } from '../../dtos/CreateUserDTO';
import { UpdateUserDTO } from '../../dtos/UpdateUserDTO';
import { validateDTO } from '../../middlewares/validate';

const mockUserRepo = { findOneBy: jest.fn() };

beforeEach(() => {
  jest.clearAllMocks();
  (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockUserRepo);
});

describe('artist profile stream stats (#807)', () => {
  const totals = { totalStreams: 12, totalStreamTime: 3600, uniqueListeners: 4 };

  it('public profile reports stats from play events', async () => {
    mockUserRepo.findOneBy.mockResolvedValue({ id: 'artist-1', isProfilePublic: true });
    mockGetArtistLifetimeTotals.mockResolvedValue(totals);

    const profile = await new UserService().getPublicProfile('artist-1');

    expect(mockGetArtistLifetimeTotals).toHaveBeenCalledWith('artist-1');
    expect(profile).toMatchObject(totals);
  });

  it('own profile reports stats from play events', async () => {
    mockUserRepo.findOneBy.mockResolvedValue({ id: 'artist-1' });
    mockGetArtistLifetimeTotals.mockResolvedValue(totals);

    const profile = await new UserService().getOwnProfile('artist-1');

    expect(profile).toMatchObject(totals);
  });

  it('ignores stored values on the user record', async () => {
    mockUserRepo.findOneBy.mockResolvedValue({
      id: 'artist-1',
      isProfilePublic: true,
      totalStreams: 999999,
    });
    mockGetArtistLifetimeTotals.mockResolvedValue(totals);

    const profile = await new UserService().getPublicProfile('artist-1');

    expect(profile).toMatchObject({ totalStreams: 12 });
  });
});

describe('client-supplied stream stats (#807)', () => {
  const stats = { totalStreams: 999, totalStreamTime: 999, uniqueListeners: 999 };

  async function runValidation(DTO: new () => object, body: Record<string, unknown>) {
    const req: any = { body };
    const next = jest.fn();
    await validateDTO(DTO)(req, {}, next);
    expect(next).toHaveBeenCalled();
    return req.body;
  }

  it('are stripped from the create body', async () => {
    const body = await runValidation(CreateUserDTO, {
      dynamixUserId: 'dyn-1',
      role: UserRole.ARTIST,
      walletAddress: '0xabc',
      email: 'a@b.co',
      signature: 'sig',
      message: 'msg',
      ...stats,
    });

    expect(body).not.toHaveProperty('totalStreams');
    expect(body).not.toHaveProperty('totalStreamTime');
    expect(body).not.toHaveProperty('uniqueListeners');
  });

  it('are stripped from the update body', async () => {
    const body = await runValidation(UpdateUserDTO, {
      walletAddress: '0xabc',
      name: 'x',
      ...stats,
    });

    expect(body).toMatchObject({ name: 'x' });
    expect(body).not.toHaveProperty('totalStreams');
    expect(body).not.toHaveProperty('totalStreamTime');
    expect(body).not.toHaveProperty('uniqueListeners');
  });

  it('are not columns on the User entity', () => {
    const columns = getMetadataArgsStorage()
      .columns.filter((c) => c.target === User)
      .map((c) => c.propertyName);

    expect(columns).not.toContain('totalStreams');
    expect(columns).not.toContain('totalStreamTime');
    expect(columns).not.toContain('uniqueListeners');
  });
});

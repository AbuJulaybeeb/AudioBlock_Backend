import 'reflect-metadata';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

jest.mock('../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));
jest.mock('../../config/logger', () => ({
  __esModule: true,
  default: { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() },
}));

const mockNotify = jest.fn();
jest.mock('../NotificationService', () => ({
  NotificationService: jest.fn().mockImplementation(() => ({ create: mockNotify })),
}));

import AppDataSource from '../../config/db';
import { AddCollaboratorDTO } from '../../dtos/AddCollaboratorDTO';
import { CollaboratorRole, CollaboratorStatus } from '../../entities/SongCollaborator';
import { CollaborationService } from '../CollaborationService';

const SONG_ID = 'song-1';
const OWNER = 'artist-1';
const GUEST = 'user-2';

const songRepo = { findOneBy: jest.fn() };
const collabRepo = {
  find: jest.fn(),
  findOneBy: jest.fn(),
  create: jest.fn((e) => e),
  save: jest.fn((e) => Promise.resolve(e)),
};

describe('CollaborationService collaborator management', () => {
  let service: CollaborationService;

  beforeEach(() => {
    jest.clearAllMocks();
    (AppDataSource.getRepository as jest.Mock).mockImplementation((entity: { name: string }) =>
      entity.name === 'Song' ? songRepo : collabRepo,
    );
    songRepo.findOneBy.mockResolvedValue({
      id: SONG_ID,
      title: 'Track',
      artistId: OWNER,
      mintStatus: 'not_minted',
    });
    collabRepo.find.mockResolvedValue([]);
    collabRepo.findOneBy.mockResolvedValue(null);
    service = new CollaborationService();
  });

  const input = { userId: GUEST, role: CollaboratorRole.PRODUCER, royaltyShare: 30 };

  it('lets the owner add a collaborator and notifies them', async () => {
    const result = await service.addCollaborator(SONG_ID, OWNER, input);

    expect(result).toMatchObject({ songId: SONG_ID, userId: GUEST, royaltyShare: 30 });
    expect(mockNotify).toHaveBeenCalledWith(expect.objectContaining({ userId: GUEST }));
  });

  it('still adds the collaborator when the notification fails', async () => {
    mockNotify.mockRejectedValue(new Error('boom'));

    await expect(service.addCollaborator(SONG_ID, OWNER, input)).resolves.toMatchObject({
      userId: GUEST,
    });
  });

  it('rejects non-owners with 403', async () => {
    await expect(service.addCollaborator(SONG_ID, 'someone', input)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it('rejects a duplicate active collaborator with 409', async () => {
    collabRepo.findOneBy.mockResolvedValue({ status: CollaboratorStatus.ACTIVE });

    await expect(service.addCollaborator(SONG_ID, OWNER, input)).rejects.toMatchObject({
      statusCode: 409,
    });
  });

  it('rejects splits that would exceed 100%', async () => {
    collabRepo.find.mockResolvedValue([{ userId: 'x', royaltyShare: 80 }]);

    await expect(service.addCollaborator(SONG_ID, OWNER, input)).rejects.toMatchObject({
      statusCode: 400,
    });
    expect(collabRepo.save).not.toHaveBeenCalled();
  });

  it('allows splits that total less than 100%', async () => {
    collabRepo.find.mockResolvedValue([{ userId: 'x', royaltyShare: 50 }]);

    await expect(service.addCollaborator(SONG_ID, OWNER, input)).resolves.toBeDefined();
  });

  it.each(['pending', 'minted'])(
    'blocks adding a collaborator once mintStatus is %s',
    async (m) => {
      songRepo.findOneBy.mockResolvedValue({ id: SONG_ID, artistId: OWNER, mintStatus: m });

      await expect(service.addCollaborator(SONG_ID, OWNER, input)).rejects.toMatchObject({
        statusCode: 409,
      });
      expect(collabRepo.save).not.toHaveBeenCalled();
      expect(mockNotify).not.toHaveBeenCalled();
    },
  );

  it('lets the owner update a collaborator and rejects over-100% updates', async () => {
    const existing = { userId: GUEST, royaltyShare: 30, role: CollaboratorRole.WRITER };
    collabRepo.findOneBy.mockResolvedValue(existing);
    collabRepo.find.mockResolvedValue([existing, { userId: 'x', royaltyShare: 60 }]);

    await expect(
      service.updateCollaborator(SONG_ID, GUEST, OWNER, { royaltyShare: 40 }),
    ).resolves.toMatchObject({ royaltyShare: 40 });
    await expect(
      service.updateCollaborator(SONG_ID, GUEST, OWNER, { royaltyShare: 41 }),
    ).rejects.toMatchObject({ statusCode: 400 });
  });

  it('blocks updating a collaborator after minting', async () => {
    songRepo.findOneBy.mockResolvedValue({ id: SONG_ID, artistId: OWNER, mintStatus: 'minted' });

    await expect(
      service.updateCollaborator(SONG_ID, GUEST, OWNER, { royaltyShare: 10 }),
    ).rejects.toMatchObject({ statusCode: 409 });
  });

  it('lists collaborators for a song', async () => {
    collabRepo.find.mockResolvedValue([{ userId: GUEST }]);

    await expect(service.listCollaborators(SONG_ID)).resolves.toEqual([{ userId: GUEST }]);
  });

  it('AddCollaboratorDTO rejects an invalid role and an out-of-range share', async () => {
    const dto = plainToInstance(AddCollaboratorDTO, {
      userId: '3f2b8c1e-6d1a-4c1b-9a64-1f2f6f3d9b11',
      role: 'drummer',
      royaltyShare: 101,
    });

    const errors = await validate(dto);

    expect(errors.map((e) => e.property).sort()).toEqual(['role', 'royaltyShare']);
  });
});

import 'reflect-metadata';

jest.mock('../../../config/db', () => ({
  __esModule: true,
  default: { getRepository: jest.fn() },
}));

jest.mock('../../../config/soroban', () => ({
  SorobanContracts: { artist: 'ARTIST_CONTRACT' },
}));

const mockPrepareInvocation = jest.fn();
const mockSubmitSignedTransaction = jest.fn();
jest.mock('../../Soroban/SorobanService', () => ({
  SorobanService: jest.fn().mockImplementation(() => ({
    prepareInvocation: mockPrepareInvocation,
    submitSignedTransaction: mockSubmitSignedTransaction,
  })),
  addressArg: jest.fn((v: string) => `addr:${v}`),
  stringArg: jest.fn((v: string) => `str:${v}`),
}));

import AppDataSource from '../../../config/db';
import { AppError } from '../../../errors/AppError';
import { User } from '../../../entities/User';
import { mapToOnChainError, OnChainErrorCode } from '../../../types/OnChainErrorCodes';
import { ArtistService } from '../ArtistService';

const USER_ID = '11111111-1111-4111-8111-111111111111';
const OWN_KEY = 'GOWNKEY';

const mockUserRepo = {
  findOneBy: jest.fn(),
  save: jest.fn((u: User) => Promise.resolve(u)),
};

function makeUser(overrides: Partial<User> = {}): User {
  const user = new User();
  user.id = USER_ID;
  user.stellarPublicKey = OWN_KEY;
  Object.assign(user, overrides);
  return user;
}

describe('ArtistService on-chain artist setup', () => {
  let service: ArtistService;

  beforeEach(() => {
    jest.clearAllMocks();
    (AppDataSource.getRepository as jest.Mock).mockReturnValue(mockUserRepo);
    service = new ArtistService();
  });

  describe('connectStellarWallet', () => {
    it('stores the public key on the user', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(makeUser({ stellarPublicKey: undefined }));

      const user = await service.connectStellarWallet(USER_ID, OWN_KEY);

      expect(user.stellarPublicKey).toBe(OWN_KEY);
      expect(mockUserRepo.save).toHaveBeenCalledTimes(1);
    });

    it('throws when the user does not exist', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(null);

      await expect(service.connectStellarWallet(USER_ID, OWN_KEY)).rejects.toThrow(
        'User not found',
      );
    });
  });

  describe('prepareArtistOnChainSetup', () => {
    it('throws when the user does not exist', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(null);

      await expect(service.prepareArtistOnChainSetup(USER_ID, 'cid')).rejects.toThrow(
        'User not found',
      );
    });

    it('requires a cid', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(makeUser());

      await expect(service.prepareArtistOnChainSetup(USER_ID, '')).rejects.toThrow(
        'cid is required',
      );
    });

    it('rejects a user without a connected wallet with a 400', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(makeUser({ stellarPublicKey: undefined }));

      const err = await service.prepareArtistOnChainSetup(USER_ID, 'cid').catch((e) => e);

      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(400);
      expect(mockPrepareInvocation).not.toHaveBeenCalled();
    });

    it('rejects an already-registered artist with a 409', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(makeUser({ stellarArtistId: '7' }));

      const err = await service.prepareArtistOnChainSetup(USER_ID, 'cid').catch((e) => e);

      expect(err).toBeInstanceOf(AppError);
      expect(err.statusCode).toBe(409);
      expect(mockPrepareInvocation).not.toHaveBeenCalled();
    });

    it("builds the invocation for the user's own stellarPublicKey", async () => {
      mockUserRepo.findOneBy.mockResolvedValue(makeUser());
      mockPrepareInvocation.mockResolvedValue('XDR');

      const result = await service.prepareArtistOnChainSetup(USER_ID, 'bafycid');

      expect(mockUserRepo.findOneBy).toHaveBeenCalledWith({ id: USER_ID });
      expect(mockPrepareInvocation).toHaveBeenCalledWith(
        OWN_KEY,
        'ARTIST_CONTRACT',
        'setup_artist_profile',
        [`addr:${OWN_KEY}`, 'str:bafycid'],
      );
      expect(result.xdr).toBe('XDR');
    });
  });

  describe('submitArtistOnChainSetup', () => {
    it('throws when the user does not exist', async () => {
      mockUserRepo.findOneBy.mockResolvedValue(null);

      await expect(service.submitArtistOnChainSetup(USER_ID, 'signed')).rejects.toThrow(
        'User not found',
      );
      expect(mockSubmitSignedTransaction).not.toHaveBeenCalled();
    });

    it('persists the artist and token ids on success', async () => {
      const user = makeUser();
      mockUserRepo.findOneBy.mockResolvedValue(user);
      mockSubmitSignedTransaction.mockResolvedValue({ hash: 'h1', returnValue: [5n, 9n] });

      const result = await service.submitArtistOnChainSetup(USER_ID, 'signed');

      expect(result).toEqual({ txHash: 'h1', artistId: '5', tokenId: '9' });
      expect(mockUserRepo.save).toHaveBeenCalledTimes(1);
      expect(mockUserRepo.save).toHaveBeenCalledWith(
        expect.objectContaining({ stellarArtistId: '5', stellarArtistTokenId: '9' }),
      );
    });

    it('is idempotent when the same transaction is submitted again', async () => {
      const user = makeUser();
      mockUserRepo.findOneBy.mockResolvedValue(user);
      mockSubmitSignedTransaction.mockResolvedValue({ hash: 'h1', returnValue: [5n, 9n] });

      const first = await service.submitArtistOnChainSetup(USER_ID, 'signed');
      const retry = await service.submitArtistOnChainSetup(USER_ID, 'signed');

      expect(retry).toEqual(first);
      expect(mockUserRepo.save).toHaveBeenCalledTimes(1);
    });

    it.each([
      ['Soroban transaction rejected: {}', OnChainErrorCode.SOROBAN_NETWORK_ERROR],
      ['Timed out waiting for Soroban transaction abc', OnChainErrorCode.SOROBAN_TIMEOUT],
      ['transaction has expired', OnChainErrorCode.TRANSACTION_EXPIRED],
    ])('propagates "%s" so it maps to %s without saving', async (message, code) => {
      mockUserRepo.findOneBy.mockResolvedValue(makeUser());
      mockSubmitSignedTransaction.mockRejectedValue(new Error(message));

      const err = await service.submitArtistOnChainSetup(USER_ID, 'signed').catch((e) => e);

      expect(mapToOnChainError(err).errorCode).toBe(code);
      expect(mockUserRepo.save).not.toHaveBeenCalled();
    });
  });
});

import { PrivyMfaController } from '../controllers/PrivyMfaController';
import { privySessionService } from '../services/privy/PrivySessionService';
import { handleError } from '../utils/helpers';
jest.mock('../services/PrivyService', () => ({ privyService: {} }));
jest.mock('../services/privy/PrivySessionService', () => ({
  privySessionService: { revokeUserSessions: jest.fn() },
}));
jest.mock('../utils/helpers', () => ({ handleError: jest.fn() }));
jest.mock('../config/logger', () => ({ __esModule: true, default: { info: jest.fn() } }));
beforeEach(() => jest.clearAllMocks());
function setup() {
  const remote = jest.fn().mockResolvedValue(undefined);
  const controller = new PrivyMfaController({
    verifyAccessToken: () => ({ sub: 'user' }),
    revokeAllSessions: remote,
  } as any);
  const req = { headers: { authorization: 'Bearer token' } } as any;
  const res = { status: jest.fn().mockReturnThis(), json: jest.fn() } as any;
  return { controller, req, res, remote };
}
it('waits for shared revocation storage before responding successfully', async () => {
  let finish!: () => void;
  jest.mocked(privySessionService.revokeUserSessions).mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  const { controller, req, res, remote } = setup();
  const result = controller.revokeSessions(req, res);
  await Promise.resolve();
  expect(remote).toHaveBeenCalledWith('user');
  expect(privySessionService.revokeUserSessions).toHaveBeenCalledWith('user');
  expect(res.status).not.toHaveBeenCalled();
  finish();
  await result;
  expect(res.status).toHaveBeenCalledWith(200);
});
it('surfaces storage errors instead of reporting a successful revocation', async () => {
  const error = new Error('Redis unavailable');
  jest.mocked(privySessionService.revokeUserSessions).mockRejectedValue(error);
  const { controller, req, res } = setup();
  await controller.revokeSessions(req, res);
  expect(handleError).toHaveBeenCalledWith(req, res, error);
  expect(res.status).not.toHaveBeenCalledWith(200);
});

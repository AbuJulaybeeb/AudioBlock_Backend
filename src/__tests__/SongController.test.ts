import { Request, Response } from 'express';
import { SongController } from '../../src/controllers/SongController';
import { SongService } from '../../src/services/SongService';
import * as utils from '../../src/utils/helpers';
import { AppError } from '../../src/errors/AppError';

// Mock the SongService class
jest.mock('../../src/services/SongService');

describe('SongController CRUD operations', () => {
  let req: Partial<Request>;
  let res: Partial<Response>;
  let mockGetSong: jest.Mock;
  let mockUpdateSong: jest.Mock;
  let mockDeleteSong: jest.Mock;
  let mockListSongs: jest.Mock;

  beforeEach(() => {
    mockGetSong = jest.fn();
    mockUpdateSong = jest.fn();
    mockDeleteSong = jest.fn();
    mockListSongs = jest.fn();

    (SongService.prototype.getSongView as jest.Mock) = mockGetSong;
    (SongService.prototype.updateSong as jest.Mock) = mockUpdateSong;
    (SongService.prototype.deleteSong as jest.Mock) = mockDeleteSong;
    (SongService.prototype.listSongs as jest.Mock) = mockListSongs;

    req = {
      params: { id: 'song-123' },
      body: { title: 'New Song' },
      query: { page: '1' },
      user: { id: 'user-1' } as any,
    } as any;

    res = {
      status: jest.fn().mockReturnThis(),
      json: jest.fn(),
    };

    jest.spyOn(utils, 'handleError').mockImplementation((req, res, err) => {
      const error = err as any;
      if (error.statusCode === 404) res.status(404).json({ error: 'Not Found' });
      else if (error.statusCode === 400) res.status(400).json({ error: 'Bad Request' });
      else if (error.statusCode === 401) res.status(401).json({ error: 'Unauthorized' });
      else res.status(500).json({ error: 'Server Error' });
    });
  });

  afterEach(() => {
    jest.clearAllMocks();
  });

  // --- getSong ---
  describe('getSong', () => {
    it('success path', async () => {
      mockGetSong.mockResolvedValue({ id: 'song-123', title: 'Test' });
      await SongController.getSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);
      expect(res.json).toHaveBeenCalledWith({
        success: true,
        data: { id: 'song-123', title: 'Test' },
      });
    });

    it('not found (404)', async () => {
      mockGetSong.mockRejectedValue(AppError.notFound('Not found'));
      await SongController.getSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('validation error (400)', async () => {
      mockGetSong.mockRejectedValue(AppError.validation('Invalid id'));
      await SongController.getSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('unauthorized (401)', async () => {
      mockGetSong.mockRejectedValue(AppError.authentication('Unauthorized'));
      await SongController.getSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // --- updateSong ---
  describe('updateSong', () => {
    it('success path', async () => {
      mockUpdateSong.mockResolvedValue({ id: 'song-123', title: 'Updated Song' });
      await SongController.updateSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('not found (404)', async () => {
      mockUpdateSong.mockRejectedValue(AppError.notFound('Song not found'));
      await SongController.updateSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('validation error (400)', async () => {
      mockUpdateSong.mockRejectedValue(AppError.validation('Bad input'));
      await SongController.updateSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('unauthorized (401)', async () => {
      mockUpdateSong.mockRejectedValue(AppError.authentication('Unauthorized'));
      await SongController.updateSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // --- deleteSong ---
  describe('deleteSong', () => {
    it('success path', async () => {
      mockDeleteSong.mockResolvedValue({ success: true });
      await SongController.deleteSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('not found (404)', async () => {
      mockDeleteSong.mockRejectedValue(AppError.notFound('Song not found'));
      await SongController.deleteSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('validation error (400)', async () => {
      mockDeleteSong.mockRejectedValue(AppError.validation('Bad request'));
      await SongController.deleteSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('unauthorized (401)', async () => {
      mockDeleteSong.mockRejectedValue(AppError.authentication('Unauthorized'));
      await SongController.deleteSong(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });

  // --- listSongs ---
  describe('listSongs', () => {
    it('success path', async () => {
      mockListSongs.mockResolvedValue([{ id: 'song-1' }]);
      await SongController.listSongs(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(200);
    });

    it('not found (404)', async () => {
      mockListSongs.mockRejectedValue(AppError.notFound('Not found'));
      await SongController.listSongs(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(404);
    });

    it('validation error (400)', async () => {
      mockListSongs.mockRejectedValue(AppError.validation('Bad request'));
      await SongController.listSongs(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(400);
    });

    it('unauthorized (401)', async () => {
      mockListSongs.mockRejectedValue(AppError.authentication('Unauthorized'));
      await SongController.listSongs(req as Request, res as Response);
      expect(res.status).toHaveBeenCalledWith(401);
    });
  });
});

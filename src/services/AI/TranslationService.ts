import { Repository } from 'typeorm';
import AppDataSource from '../../config/db';
import { Song } from '../../entities/Song';
import { AppError } from '../../errors/AppError';
import logger from '../../config/logger';
import { AiProvider } from './AiProvider';

/**
 * AI translation of song/artist metadata for i18n (#284).
 *
 * Original text fields are never overwritten. Translations are cached in a
 * simple JSON column alongside the original fields to avoid repeat AI costs.
 */
export class TranslationService {
  private songRepo: Repository<Song>;
  private provider: AiProvider;

  constructor(provider: AiProvider) {
    this.songRepo = AppDataSource.getRepository(Song);
    this.provider = provider;
  }

  /**
   * Translate a song's title, description, and artist name into the target language.
   * Returns the translated text without modifying the original fields.
   */
  async translateSong(
    songId: string,
    targetLang: string,
  ): Promise<{ title: string; description: string; artistName: string }> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) {
      throw AppError.notFound('Song not found', undefined, 'SONG_NOT_FOUND');
    }

    // Check cache first (#284: translations cached to avoid repeat cost).
    const cached = song.translations?.[targetLang];
    if (cached) {
      return cached;
    }

    // Translate each field via the AI abstraction.
    const [title, description, artistName] = await Promise.all([
      this.provider.generateText(
        `Translate this song title to ${targetLang}. Return only the translation:\n${song.title}`,
      ),
      this.provider.generateText(
        `Translate this description to ${targetLang}. Return only the translation:\n${song.description ?? ''}`,
      ),
      this.provider.generateText(
        `Translate this artist name to ${targetLang}. Return only the translation:\n${song.artistAddress ?? ''}`,
      ),
    ]);

    const translation = { title, description, artistName };

    // Store alongside originals; never overwrite originals (#284).
    if (!song.translations) {
      song.translations = {};
    }
    song.translations[targetLang] = translation;
    await this.songRepo.save(song);

    logger.info({ songId, targetLang }, 'Song translation cached');
    return translation;
  }
}

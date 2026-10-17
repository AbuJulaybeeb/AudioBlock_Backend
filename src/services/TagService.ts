import { In, Repository } from 'typeorm';
import AppDataSource from '../config/db';
import { Tag } from '../entities/Tag';
import { SongTag } from '../entities/SongTag';
import { Song } from '../entities/Song';
import { AppError } from '../errors/AppError';

const MAX_TAGS_PER_SONG = 10;

function slugify(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

export class TagService {
  private tagRepo: Repository<Tag>;
  private songTagRepo: Repository<SongTag>;
  private songRepo: Repository<Song>;

  constructor() {
    this.tagRepo = AppDataSource.getRepository(Tag);
    this.songTagRepo = AppDataSource.getRepository(SongTag);
    this.songRepo = AppDataSource.getRepository(Song);
  }

  async listAllGroupedByCategory(): Promise<Record<string, Tag[]>> {
    const tags = await this.tagRepo.find({ order: { name: 'ASC' } });
    return tags.reduce<Record<string, Tag[]>>((groups, tag) => {
      const category = tag.category || 'uncategorized';
      groups[category] = groups[category] || [];
      groups[category].push(tag);
      return groups;
    }, {});
  }

  async getSongsByTagSlug(slug: string): Promise<Song[]> {
    // Single joined query instead of find-then-findByIds (avoids N+1, #332).
    return this.songRepo
      .createQueryBuilder('song')
      .innerJoin('song_tags', 'st', 'st.songId = song.id')
      .innerJoin('tags', 'tag', 'tag.id = st.tagId')
      .where('tag.slug = :slug', { slug })
      .getMany();
  }

  /**
   * Add tags to a song by name, creating any tags that don't yet exist.
   * Names are case-insensitive and stored lowercase; duplicates on the
   * song are ignored. Enforces a max of 10 tags per song.
   */
  async addTagsToSong(songId: string, names: string[], category?: string): Promise<Tag[]> {
    const song = await this.songRepo.findOneBy({ id: songId });
    if (!song) throw AppError.notFound('Song not found');

    const normalizedNames = [...new Set(names.map((n) => n.toLowerCase().trim()).filter(Boolean))];
    if (normalizedNames.length === 0) {
      throw AppError.validation('At least one tag name is required');
    }

    const existingSongTags = await this.songTagRepo.find({ where: { songId } });
    const existingTagIds = new Set(existingSongTags.map((st) => st.tagId));

    // Batch lookup existing tags instead of one query per name (#332).
    const existingTags = await this.tagRepo.find({ where: { name: In(normalizedNames) } });
    const existingByName = new Map(existingTags.map((t) => [t.name, t]));

    const tags: Tag[] = [];
    for (const name of normalizedNames) {
      let tag = existingByName.get(name);
      if (!tag) {
        tag = this.tagRepo.create({ name, slug: slugify(name), category });
        tag = await this.tagRepo.save(tag);
      }
      tags.push(tag);
    }

    const newTagIds = tags.map((t) => t.id).filter((id) => !existingTagIds.has(id));
    const totalAfter = existingTagIds.size + newTagIds.length;
    if (totalAfter > MAX_TAGS_PER_SONG) {
      throw AppError.validation(`A song may have at most ${MAX_TAGS_PER_SONG} tags`);
    }

    // Batch insert new song-tag links (#332).
    if (newTagIds.length > 0) {
      await this.songTagRepo.save(newTagIds.map((tagId) => this.songTagRepo.create({ songId, tagId })));
    }

    return tags;
  }
}

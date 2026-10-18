import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Issue #776: song search used leading-wildcard ILIKE across several columns,
 * which cannot use a B-tree index and scanned the whole songs table. pg_trgm
 * GIN indexes on every searched column let Postgres serve `ILIKE '%term%'` with
 * a BitmapOr of index scans, and provide similarity() for ranking.
 */
export class AddSongSearchTrigramIndexes1757700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('CREATE EXTENSION IF NOT EXISTS pg_trgm');
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_songs_title_trgm" ON "songs" USING GIN ("title" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_songs_genre_trgm" ON "songs" USING GIN ("genre" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_songs_composers_trgm" ON "songs" USING GIN ("composers" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_songs_description_trgm" ON "songs" USING GIN ("description" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_users_name_trgm" ON "users" USING GIN ("name" gin_trgm_ops)',
    );
    await queryRunner.query(
      'CREATE INDEX IF NOT EXISTS "IDX_users_username_trgm" ON "users" USING GIN ("username" gin_trgm_ops)',
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_users_username_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_users_name_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_songs_description_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_songs_composers_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_songs_genre_trgm"');
    await queryRunner.query('DROP INDEX IF EXISTS "IDX_songs_title_trgm"');
  }
}

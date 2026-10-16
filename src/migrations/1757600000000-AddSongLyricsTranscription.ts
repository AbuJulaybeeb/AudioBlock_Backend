import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Issue #285: opt-in, license-aware lyric transcription. Stores the AI
 * transcription draft on the song plus the artist's rights confirmation.
 */
export class AddSongLyricsTranscription1757600000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.addColumns('songs', [
      new TableColumn({ name: 'aiLyricsTranscription', type: 'text', isNullable: true }),
      new TableColumn({ name: 'lyricsRightsConfirmedAt', type: 'timestamp', isNullable: true }),
      new TableColumn({ name: 'lyricsRightsConfirmedBy', type: 'varchar', isNullable: true }),
      new TableColumn({ name: 'aiLyricsTranscribedAt', type: 'timestamp', isNullable: true }),
    ]);
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('songs', 'aiLyricsTranscribedAt');
    await queryRunner.dropColumn('songs', 'lyricsRightsConfirmedBy');
    await queryRunner.dropColumn('songs', 'lyricsRightsConfirmedAt');
    await queryRunner.dropColumn('songs', 'aiLyricsTranscription');
  }
}

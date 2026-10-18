import { MigrationInterface, QueryRunner, TableColumn } from 'typeorm';

/**
 * Drops the denormalized `totalStreams`, `totalStreamTime` and `uniqueListeners`
 * columns from `users`. Nothing kept them current, so they were zero or
 * client-supplied; the figures are now computed from `song_play_events`.
 */
export class DropUserStreamStatColumns1757700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    await queryRunner.dropColumn('users', 'totalStreams');
    await queryRunner.dropColumn('users', 'totalStreamTime');
    await queryRunner.dropColumn('users', 'uniqueListeners');
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    for (const name of ['totalStreams', 'totalStreamTime', 'uniqueListeners']) {
      await queryRunner.addColumn(
        'users',
        new TableColumn({ name, type: 'int', default: 0 }),
      );
    }
  }
}

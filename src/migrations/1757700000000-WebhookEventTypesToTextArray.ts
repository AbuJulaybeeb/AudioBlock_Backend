import { MigrationInterface, QueryRunner } from 'typeorm';

/**
 * Converts `webhook_subscriptions.eventTypes` from a comma-joined `simple-array`
 * string to a Postgres `text[]` and adds a GIN index so `WebhookService.publish`
 * can match subscriptions in SQL instead of loading every active row.
 *
 * Values are preserved in both directions. `NULL` stays `NULL` and an empty
 * string becomes an empty array; both still mean "all events".
 */
export class WebhookEventTypesToTextArray1757700000000 implements MigrationInterface {
  public async up(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('webhook_subscriptions'))) return;

    await queryRunner.query(`
      ALTER TABLE "webhook_subscriptions"
      ALTER COLUMN "eventTypes" TYPE text[]
      USING CASE
        WHEN "eventTypes" IS NULL THEN NULL
        WHEN "eventTypes" = '' THEN ARRAY[]::text[]
        ELSE string_to_array("eventTypes", ',')
      END
    `);
    await queryRunner.query(
      `CREATE INDEX IF NOT EXISTS "IDX_webhook_subscriptions_eventTypes" ON "webhook_subscriptions" USING GIN ("eventTypes")`,
    );
  }

  public async down(queryRunner: QueryRunner): Promise<void> {
    if (!(await queryRunner.hasTable('webhook_subscriptions'))) return;

    await queryRunner.query(`DROP INDEX IF EXISTS "IDX_webhook_subscriptions_eventTypes"`);
    await queryRunner.query(`
      ALTER TABLE "webhook_subscriptions"
      ALTER COLUMN "eventTypes" TYPE text
      USING array_to_string("eventTypes", ',')
    `);
  }
}

ALTER TABLE "instance" DROP CONSTRAINT "instance_slug_unique";--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "storage_key" text;--> statement-breakpoint
UPDATE "instance" SET "storage_key" = "slug";--> statement-breakpoint
ALTER TABLE "instance" ALTER COLUMN "storage_key" SET DEFAULT replace(gen_random_uuid()::text, '-', '');--> statement-breakpoint
ALTER TABLE "instance" ALTER COLUMN "storage_key" SET NOT NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "deleted_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "instance_slug_unique" ON "instance" USING btree ("slug") WHERE "instance"."deleted_at" IS NULL;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_storage_key_unique" UNIQUE("storage_key");
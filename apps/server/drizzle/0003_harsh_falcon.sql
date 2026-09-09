ALTER TABLE "instance" ADD COLUMN "disk_mb" integer DEFAULT 10240 NOT NULL;--> statement-breakpoint
ALTER TABLE "instance_metric" ADD COLUMN "disk_used_mb" integer DEFAULT 0 NOT NULL;
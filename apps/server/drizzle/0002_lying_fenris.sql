CREATE TABLE "instance_metric" (
	"id" text PRIMARY KEY NOT NULL,
	"instance_id" text NOT NULL,
	"sampled_at" timestamp with time zone DEFAULT now() NOT NULL,
	"cpu_percent" real NOT NULL,
	"mem_mb" integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE "instance" ADD COLUMN "stopped_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "instance_metric" ADD CONSTRAINT "instance_metric_instance_id_instance_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instance"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "instance_metric_instance_sampled_idx" ON "instance_metric" USING btree ("instance_id","sampled_at");
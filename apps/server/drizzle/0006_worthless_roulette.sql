CREATE TABLE "image_release" (
	"id" text PRIMARY KEY NOT NULL,
	"ref" text NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"published_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "image_release_ref_unique" UNIQUE("ref")
);
--> statement-breakpoint
CREATE UNIQUE INDEX "image_release_default_unique" ON "image_release" USING btree ("is_default") WHERE "image_release"."is_default";
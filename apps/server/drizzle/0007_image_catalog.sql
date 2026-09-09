CREATE TABLE "image_catalog" (
	"ref" text PRIMARY KEY NOT NULL,
	"digest" text NOT NULL,
	"synced_at" timestamp with time zone DEFAULT now() NOT NULL
);

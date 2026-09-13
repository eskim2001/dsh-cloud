CREATE TABLE "platform_setting" (
	"id" text PRIMARY KEY NOT NULL,
	"base_domain" text DEFAULT '' NOT NULL,
	"console_domain" text DEFAULT '' NOT NULL,
	"configured_at" timestamp with time zone
);

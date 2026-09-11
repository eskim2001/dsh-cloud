ALTER TABLE "instance" ADD COLUMN "host_port" integer;--> statement-breakpoint
ALTER TABLE "instance" ADD CONSTRAINT "instance_host_port_unique" UNIQUE("host_port");
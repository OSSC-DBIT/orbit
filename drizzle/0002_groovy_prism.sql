CREATE TABLE "infra_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"host_id" integer NOT NULL,
	"severity" varchar(12) DEFAULT 'info' NOT NULL,
	"message" text NOT NULL,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"announced_at" timestamp with time zone,
	"announced_channel_id" varchar(32)
);
--> statement-breakpoint
ALTER TABLE "infrastructure_hosts" ADD COLUMN "home_url" varchar(300);--> statement-breakpoint
ALTER TABLE "infrastructure_hosts" ADD COLUMN "notify_channel_id" varchar(32);--> statement-breakpoint
ALTER TABLE "infrastructure_hosts" ADD COLUMN "sla_minutes" integer DEFAULT 60 NOT NULL;--> statement-breakpoint
ALTER TABLE "infrastructure_hosts" ADD COLUMN "added_by" varchar(32);--> statement-breakpoint
CREATE INDEX "infra_events_guild_time_idx" ON "infra_events" USING btree ("guild_id","occurred_at");--> statement-breakpoint
CREATE INDEX "infra_events_host_time_idx" ON "infra_events" USING btree ("host_id","occurred_at");--> statement-breakpoint
CREATE INDEX "infra_events_unannounced_idx" ON "infra_events" USING btree ("announced_at");--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_hosts_name_unique" ON "infrastructure_hosts" USING btree ("guild_id","name");
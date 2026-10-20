CREATE TABLE "github_installations" (
	"id" serial PRIMARY KEY NOT NULL,
	"installation_id" varchar(32) NOT NULL,
	"account_login" varchar(300) NOT NULL,
	"access_token_enc" text,
	"access_token_expires_at" timestamp with time zone,
	"permissions" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "github_webhook_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"delivery_id" varchar(64) NOT NULL,
	"repository_full_name" varchar(300) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"status" varchar(24) DEFAULT 'received' NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "infrastructure_hosts" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"name" varchar(128) NOT NULL,
	"enrol_token_hash" varchar(128) NOT NULL,
	"status" varchar(24) DEFAULT 'pending' NOT NULL,
	"last_heartbeat_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_sources" (
	"id" varchar(64) PRIMARY KEY NOT NULL,
	"kind" varchar(24) NOT NULL,
	"config" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"enabled" integer DEFAULT 1 NOT NULL,
	"owner_guild_id" varchar(32),
	"interval_minutes" integer DEFAULT 90 NOT NULL,
	"categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"last_run_at" timestamp with time zone,
	"last_success_at" timestamp with time zone,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"last_error" text
);
--> statement-breakpoint
CREATE TABLE "opportunity_tags" (
	"id" serial PRIMARY KEY NOT NULL,
	"tag" varchar(64) NOT NULL,
	"opportunity_id" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "scheduled_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"job_type" varchar(64) NOT NULL,
	"idempotency_key" varchar(160),
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"run_at" timestamp with time zone NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"locked_by" varchar(64),
	"locked_at" timestamp with time zone,
	"last_error" text,
	"correlation_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user_preferences" (
	"discord_user_id" varchar(32) PRIMARY KEY NOT NULL,
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"interests" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notify_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"personal_subscribed" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"discord_user_id" varchar(32) PRIMARY KEY NOT NULL,
	"username" varchar(128),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"actor_id" varchar(32) NOT NULL,
	"action" varchar(64) NOT NULL,
	"target" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"correlation_id" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "deadline_notifications" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"opportunity_id" integer NOT NULL,
	"offset_minutes" integer NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"sent_at" timestamp with time zone,
	"failed" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "discord_guilds" (
	"guild_id" varchar(32) PRIMARY KEY NOT NULL,
	"name" varchar(128),
	"locale" varchar(16),
	"timezone" varchar(64) DEFAULT 'UTC' NOT NULL,
	"max_daily_notifications" integer DEFAULT 20 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "guild_authorized_roles" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"role_or_user_id" varchar(32) NOT NULL,
	"added_by" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "guild_channels" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"kind" varchar(32) NOT NULL,
	"channel_id" varchar(32) NOT NULL,
	"mention_role_id" varchar(32),
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "guild_feature_settings" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"feature" varchar(48) NOT NULL,
	"enabled" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "guild_preferences" (
	"guild_id" varchar(32) PRIMARY KEY NOT NULL,
	"enabled_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"include_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"exclude_keywords" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"locations" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"remote_only" integer DEFAULT 0 NOT NULL,
	"paid_only" integer DEFAULT 0 NOT NULL,
	"students_only" integer DEFAULT 0 NOT NULL,
	"min_compensation" integer,
	"allowed_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"blocked_sources" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"reminder_offsets" jsonb DEFAULT '[4320,1440,360]'::jsonb NOT NULL,
	"digest_hours" jsonb DEFAULT '[9]'::jsonb NOT NULL,
	"min_confidence" integer DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" varchar(32)
);
--> statement-breakpoint
CREATE TABLE "guild_projects" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"repository_full_name" varchar(300) NOT NULL,
	"alert_categories" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"notify_activity" integer DEFAULT 0 NOT NULL,
	"installation_id" varchar(32),
	"verified" integer DEFAULT 0 NOT NULL,
	"quiet_hours_start" integer,
	"quiet_hours_end" integer,
	"added_by" varchar(32),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_deliveries" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"opportunity_id" integer NOT NULL,
	"channel_id" varchar(32) NOT NULL,
	"delivery_kind" varchar(16) DEFAULT 'instant' NOT NULL,
	"delivered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"message_id" varchar(32),
	"failed" integer DEFAULT 0 NOT NULL,
	"error" text
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" serial PRIMARY KEY NOT NULL,
	"guild_id" varchar(32) NOT NULL,
	"repository_full_name" varchar(300) NOT NULL,
	"event_type" varchar(64) NOT NULL,
	"event_fingerprint" varchar(80) NOT NULL,
	"delivery_id" varchar(64),
	"payload" jsonb NOT NULL,
	"occurred_at" timestamp with time zone NOT NULL,
	"announced_at" timestamp with time zone,
	"severity" varchar(12) DEFAULT 'activity' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "workflow_runs" (
	"id" serial PRIMARY KEY NOT NULL,
	"repository_full_name" varchar(300) NOT NULL,
	"run_id" varchar(32) NOT NULL,
	"workflow_name" varchar(300),
	"head_branch" varchar(300),
	"head_sha" varchar(64),
	"event" varchar(64),
	"status" varchar(32),
	"conclusion" varchar(32),
	"html_url" text,
	"actor" varchar(200),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "bot_metrics" (
	"id" serial PRIMARY KEY NOT NULL,
	"metric" varchar(80) NOT NULL,
	"value" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunities" (
	"id" serial PRIMARY KEY NOT NULL,
	"dedup_key" varchar(80) NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"external_id" varchar(300) NOT NULL,
	"title" varchar(300) NOT NULL,
	"organization" varchar(200),
	"category" varchar(32) NOT NULL,
	"description" text,
	"description_html" text,
	"application_url" text,
	"source_url" text,
	"location" varchar(200),
	"remote_status" varchar(12),
	"compensation" jsonb,
	"required_skills" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"eligibility" jsonb,
	"opens_at" timestamp with time zone,
	"application_deadline" timestamp with time zone,
	"event_starts_at" timestamp with time zone,
	"event_ends_at" timestamp with time zone,
	"status" varchar(16) DEFAULT 'discovered' NOT NULL,
	"closing_soon_at" timestamp with time zone,
	"first_discovered_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_verified_at" timestamp with time zone,
	"source_published_at" timestamp with time zone,
	"source_updated_at" timestamp with time zone,
	"content_fingerprint" varchar(80) NOT NULL,
	"ai_summary" text,
	"confidence" real,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "opportunity_source_records" (
	"id" serial PRIMARY KEY NOT NULL,
	"opportunity_id" integer NOT NULL,
	"source_id" varchar(64) NOT NULL,
	"source_external_id" varchar(300) NOT NULL,
	"raw_url" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_sync_status" varchar(12) DEFAULT 'present' NOT NULL,
	"last_sync_at" timestamp with time zone
);
--> statement-breakpoint
CREATE UNIQUE INDEX "github_installations_unique" ON "github_installations" USING btree ("installation_id");--> statement-breakpoint
CREATE UNIQUE INDEX "github_webhook_deliveries_unique" ON "github_webhook_deliveries" USING btree ("delivery_id");--> statement-breakpoint
CREATE INDEX "github_webhook_deliveries_repo_idx" ON "github_webhook_deliveries" USING btree ("repository_full_name");--> statement-breakpoint
CREATE INDEX "infrastructure_hosts_guild_idx" ON "infrastructure_hosts" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "infrastructure_hosts_token_unique" ON "infrastructure_hosts" USING btree ("enrol_token_hash");--> statement-breakpoint
CREATE INDEX "opportunity_sources_owner_idx" ON "opportunity_sources" USING btree ("owner_guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_tags_unique" ON "opportunity_tags" USING btree ("tag","opportunity_id");--> statement-breakpoint
CREATE INDEX "opportunity_tags_opportunity_idx" ON "opportunity_tags" USING btree ("opportunity_id");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_claim_idx" ON "scheduled_jobs" USING btree ("status","run_at");--> statement-breakpoint
CREATE INDEX "scheduled_jobs_type_idx" ON "scheduled_jobs" USING btree ("job_type","status");--> statement-breakpoint
CREATE UNIQUE INDEX "scheduled_jobs_idempotency_unique" ON "scheduled_jobs" USING btree ("idempotency_key") WHERE idempotency_key is not null and status != 'cancelled';--> statement-breakpoint
CREATE INDEX "user_preferences_subscribed_idx" ON "user_preferences" USING btree ("personal_subscribed");--> statement-breakpoint
CREATE INDEX "audit_logs_guild_idx" ON "audit_logs" USING btree ("guild_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "deadline_notifications_unique" ON "deadline_notifications" USING btree ("guild_id","opportunity_id","offset_minutes");--> statement-breakpoint
CREATE INDEX "deadline_notifications_due_idx" ON "deadline_notifications" USING btree ("scheduled_for","sent_at");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_authorized_roles_unique" ON "guild_authorized_roles" USING btree ("guild_id","role_or_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_channels_unique" ON "guild_channels" USING btree ("guild_id","kind");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_feature_settings_unique" ON "guild_feature_settings" USING btree ("guild_id","feature");--> statement-breakpoint
CREATE INDEX "guild_preferences_guild_idx" ON "guild_preferences" USING btree ("guild_id");--> statement-breakpoint
CREATE UNIQUE INDEX "guild_projects_unique" ON "guild_projects" USING btree ("guild_id","repository_full_name");--> statement-breakpoint
CREATE INDEX "guild_projects_repo_idx" ON "guild_projects" USING btree ("repository_full_name");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_deliveries_unique" ON "opportunity_deliveries" USING btree ("guild_id","opportunity_id","channel_id","delivery_kind");--> statement-breakpoint
CREATE INDEX "opportunity_deliveries_guild_time_idx" ON "opportunity_deliveries" USING btree ("guild_id","delivered_at");--> statement-breakpoint
CREATE UNIQUE INDEX "project_events_fingerprint_unique" ON "project_events" USING btree ("guild_id","event_fingerprint") WHERE 1=1;--> statement-breakpoint
CREATE INDEX "project_events_repo_time_idx" ON "project_events" USING btree ("repository_full_name","occurred_at");--> statement-breakpoint
CREATE INDEX "project_events_guild_time_idx" ON "project_events" USING btree ("guild_id","occurred_at");--> statement-breakpoint
CREATE UNIQUE INDEX "workflow_runs_unique" ON "workflow_runs" USING btree ("repository_full_name","run_id");--> statement-breakpoint
CREATE INDEX "workflow_runs_conclusion_idx" ON "workflow_runs" USING btree ("conclusion");--> statement-breakpoint
CREATE UNIQUE INDEX "bot_metrics_metric_unique" ON "bot_metrics" USING btree ("metric");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_dedup_unique" ON "opportunities" USING btree ("dedup_key");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunities_source_external_unique" ON "opportunities" USING btree ("source_id","external_id");--> statement-breakpoint
CREATE INDEX "opportunities_category_idx" ON "opportunities" USING btree ("category","status");--> statement-breakpoint
CREATE INDEX "opportunities_deadline_idx" ON "opportunities" USING btree ("application_deadline");--> statement-breakpoint
CREATE INDEX "opportunities_event_idx" ON "opportunities" USING btree ("event_starts_at");--> statement-breakpoint
CREATE INDEX "opportunities_fingerprint_idx" ON "opportunities" USING btree ("content_fingerprint");--> statement-breakpoint
CREATE UNIQUE INDEX "opportunity_source_records_unique" ON "opportunity_source_records" USING btree ("source_id","source_external_id");--> statement-breakpoint
CREATE INDEX "opportunity_source_records_opportunity_idx" ON "opportunity_source_records" USING btree ("opportunity_id");
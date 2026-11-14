CREATE TABLE `runtime_chef_usage` (
	`mode` text NOT NULL,
	`household_id` text NOT NULL,
	`window_kind` text NOT NULL,
	`window_start` integer NOT NULL,
	`used` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`attempt_token` text NOT NULL,
	PRIMARY KEY(`mode`, `household_id`, `window_kind`, `window_start`),
	CONSTRAINT "runtime_chef_usage_mode_check" CHECK("runtime_chef_usage"."mode" IN ('local','hosted')),
	CONSTRAINT "runtime_chef_usage_window_check" CHECK("runtime_chef_usage"."window_kind" IN ('minute','day')),
	CONSTRAINT "runtime_chef_usage_count_check" CHECK("runtime_chef_usage"."used" > 0 AND "runtime_chef_usage"."expires_at" > "runtime_chef_usage"."window_start")
);
--> statement-breakpoint
CREATE INDEX `runtime_chef_usage_expiry_idx` ON `runtime_chef_usage` (`expires_at`);--> statement-breakpoint
CREATE TABLE `runtime_model_permits` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`request_id` text,
	`expires_at` integer NOT NULL,
	`created_at` integer NOT NULL,
	CONSTRAINT "runtime_model_permits_provider_check" CHECK("runtime_model_permits"."provider" IN ('ollama','openai')),
	CONSTRAINT "runtime_model_permits_expiry_check" CHECK("runtime_model_permits"."expires_at" > "runtime_model_permits"."created_at")
);
--> statement-breakpoint
CREATE INDEX `runtime_model_permits_provider_idx` ON `runtime_model_permits` (`provider`,`expires_at`);
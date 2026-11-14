CREATE TABLE `catalog_jobs` (
	`id` text PRIMARY KEY NOT NULL,
	`actor_id` text NOT NULL,
	`actor_mode` text NOT NULL,
	`request_id` text NOT NULL,
	`kind` text NOT NULL,
	`request_hash` text NOT NULL,
	`payload_json` text NOT NULL,
	`status` text NOT NULL,
	`attempts` integer DEFAULT 0 NOT NULL,
	`max_attempts` integer DEFAULT 3 NOT NULL,
	`available_at` integer NOT NULL,
	`lease_token` text,
	`lease_version` integer DEFAULT 0 NOT NULL,
	`lease_until` integer,
	`progress_json` text,
	`result_json` text,
	`error_code` text,
	`error_message` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`started_at` integer,
	`finished_at` integer,
	CONSTRAINT "catalog_jobs_mode_check" CHECK("catalog_jobs"."actor_mode" IN ('local','hosted')),
	CONSTRAINT "catalog_jobs_kind_check" CHECK("catalog_jobs"."kind" IN ('demo','sync','embeddings','import')),
	CONSTRAINT "catalog_jobs_status_check" CHECK("catalog_jobs"."status" IN ('queued','running','succeeded','failed')),
	CONSTRAINT "catalog_jobs_attempts_check" CHECK("catalog_jobs"."attempts" >= 0 AND "catalog_jobs"."max_attempts" BETWEEN 1 AND 3)
);
--> statement-breakpoint
CREATE UNIQUE INDEX `catalog_jobs_request_uidx` ON `catalog_jobs` (`actor_mode`,`actor_id`,`request_id`);--> statement-breakpoint
CREATE INDEX `catalog_jobs_claim_idx` ON `catalog_jobs` (`status`,`available_at`,`lease_until`);
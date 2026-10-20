CREATE TABLE `recipe_embeddings` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` text NOT NULL,
	`recipe_version` integer NOT NULL,
	`kind` text DEFAULT 'recipe' NOT NULL,
	`chunk_index` integer DEFAULT 0 NOT NULL,
	`model` text NOT NULL,
	`dimensions` integer NOT NULL,
	`content_sha256` text NOT NULL,
	`vector_json` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_embeddings_identity_uidx` ON `recipe_embeddings` (`recipe_id`,`model`,`kind`,`chunk_index`);--> statement-breakpoint
CREATE INDEX `recipe_embeddings_model_idx` ON `recipe_embeddings` (`model`);--> statement-breakpoint
CREATE INDEX `recipe_embeddings_recipe_version_idx` ON `recipe_embeddings` (`recipe_id`,`recipe_version`);--> statement-breakpoint
CREATE TABLE `recipe_ingredients` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` text NOT NULL,
	`position` integer NOT NULL,
	`section_title` text,
	`original_name` text NOT NULL,
	`normalized_name` text NOT NULL,
	`original_measure` text DEFAULT '' NOT NULL,
	`quantity_value` real,
	`quantity_min` real,
	`quantity_max` real,
	`unit` text,
	`preparation` text,
	`optional` integer DEFAULT false NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_ingredients_recipe_position_uidx` ON `recipe_ingredients` (`recipe_id`,`position`);--> statement-breakpoint
CREATE INDEX `recipe_ingredients_normalized_name_idx` ON `recipe_ingredients` (`normalized_name`);--> statement-breakpoint
CREATE TABLE `recipe_instruction_sections` (
	`id` text PRIMARY KEY NOT NULL,
	`recipe_id` text NOT NULL,
	`position` integer NOT NULL,
	`title` text,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_instruction_sections_recipe_position_uidx` ON `recipe_instruction_sections` (`recipe_id`,`position`);--> statement-breakpoint
CREATE TABLE `recipe_instruction_steps` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`recipe_id` text NOT NULL,
	`section_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`duration_seconds` integer,
	`temperature_celsius` real,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`section_id`) REFERENCES `recipe_instruction_sections`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_instruction_steps_section_position_uidx` ON `recipe_instruction_steps` (`section_id`,`position`);--> statement-breakpoint
CREATE INDEX `recipe_instruction_steps_recipe_idx` ON `recipe_instruction_steps` (`recipe_id`);--> statement-breakpoint
CREATE TABLE `recipe_sources` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`url` text NOT NULL,
	`license_id` text NOT NULL,
	`license_url` text,
	`attribution_text` text,
	`terms_url` text,
	`terms_snapshot_sha256` text,
	`permission_basis` text NOT NULL,
	`permission_document_ref` text,
	`approval_status` text DEFAULT 'pending' NOT NULL,
	`approved_by` text,
	`approved_at` integer,
	`approval_notes` text,
	`allow_display` integer DEFAULT false NOT NULL,
	`allow_cache` integer DEFAULT false NOT NULL,
	`allow_index_text` integer DEFAULT false NOT NULL,
	`allow_embed` integer DEFAULT false NOT NULL,
	`allow_derive` integer DEFAULT false NOT NULL,
	`allow_commercial` integer DEFAULT false NOT NULL,
	`allow_images` integer DEFAULT false NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
);
--> statement-breakpoint
CREATE INDEX `recipe_sources_approval_idx` ON `recipe_sources` (`approval_status`);--> statement-breakpoint
CREATE TABLE `recipe_sync_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`status` text DEFAULT 'running' NOT NULL,
	`cursor` text,
	`records_seen` integer DEFAULT 0 NOT NULL,
	`records_upserted` integer DEFAULT 0 NOT NULL,
	`records_quarantined` integer DEFAULT 0 NOT NULL,
	`error_message` text,
	`started_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`source_id`) REFERENCES `recipe_sources`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `recipe_sync_runs_source_started_idx` ON `recipe_sync_runs` (`source_id`,`started_at`);--> statement-breakpoint
CREATE TABLE `recipes` (
	`id` text PRIMARY KEY NOT NULL,
	`source_id` text NOT NULL,
	`source_record_id` text NOT NULL,
	`source_url` text NOT NULL,
	`source_updated_at` integer,
	`sync_run_id` text,
	`title` text NOT NULL,
	`image_url` text,
	`category` text DEFAULT 'Other' NOT NULL,
	`cuisine` text DEFAULT 'International' NOT NULL,
	`language` text DEFAULT 'en' NOT NULL,
	`tags_json` text DEFAULT '[]' NOT NULL,
	`search_text` text NOT NULL,
	`raw_snapshot_sha256` text,
	`normalized_content_sha256` text NOT NULL,
	`version` integer DEFAULT 1 NOT NULL,
	`status` text DEFAULT 'active' NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`last_seen_at` integer NOT NULL,
	FOREIGN KEY (`source_id`) REFERENCES `recipe_sources`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`sync_run_id`) REFERENCES `recipe_sync_runs`(`id`) ON UPDATE no action ON DELETE set null
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipes_source_record_uidx` ON `recipes` (`source_id`,`source_record_id`);--> statement-breakpoint
CREATE INDEX `recipes_source_status_idx` ON `recipes` (`source_id`,`status`);--> statement-breakpoint
CREATE INDEX `recipes_updated_idx` ON `recipes` (`updated_at`);
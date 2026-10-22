CREATE TABLE `recipe_metadata` (
	`recipe_id` text NOT NULL,
	`revision` integer NOT NULL,
	`source_content_sha256` text NOT NULL,
	`payload_json` text NOT NULL,
	`reviewed_by` text NOT NULL,
	`reviewed_at` text NOT NULL,
	FOREIGN KEY (`recipe_id`) REFERENCES `recipes`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `recipe_metadata_recipe_revision_uidx` ON `recipe_metadata` (`recipe_id`,`revision`);--> statement-breakpoint
CREATE INDEX `recipe_metadata_hash_idx` ON `recipe_metadata` (`recipe_id`,`source_content_sha256`);
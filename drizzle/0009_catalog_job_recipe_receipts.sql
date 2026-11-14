CREATE TABLE `catalog_job_recipe_receipts` (
	`job_id` text NOT NULL,
	`catalog_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`content_hash` text NOT NULL,
	`recipe_version` integer NOT NULL,
	`result_json` text NOT NULL,
	`created_at` integer NOT NULL,
	PRIMARY KEY(`job_id`, `catalog_id`),
	FOREIGN KEY (`job_id`) REFERENCES `catalog_jobs`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "catalog_job_recipe_receipt_version_check" CHECK("catalog_job_recipe_receipts"."recipe_version" > 0)
);
--> statement-breakpoint
-- Earlier attempts have no per-recipe receipts. Replaying their text writes
-- after an upgrade could revert a newer review, so require explicit review.
-- Never-started and embedding-only jobs can safely keep their existing queue.
UPDATE catalog_jobs
SET status='failed', error_code='CATALOG_REVIEW_REQUIRED',
    error_message='This job started before recipe retry protection was installed. Review the saved recipes before submitting a new catalog job.',
    lease_token=NULL, lease_until=NULL,
    updated_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER),
    finished_at=CAST((julianday('now')-2440587.5)*86400000 AS INTEGER)
WHERE status IN ('queued','running') AND attempts>0
  AND (kind IN ('demo','sync') OR (kind='import' AND COALESCE(json_extract(payload_json,'$.retryEmbeddingsOnly'),0)<>1));

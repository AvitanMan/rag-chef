CREATE TABLE `local_auth_attempts` (
	`id` integer PRIMARY KEY NOT NULL,
	`credential_version` text NOT NULL,
	`window_started` integer NOT NULL,
	`failures` integer NOT NULL,
	CONSTRAINT "local_auth_attempts_singleton" CHECK("local_auth_attempts"."id"=1)
);
--> statement-breakpoint
CREATE TABLE `local_auth_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`token_hash` text NOT NULL,
	`origin` text NOT NULL,
	`credential_version` text NOT NULL,
	`created_at` integer NOT NULL,
	`expires_at` integer NOT NULL,
	`remembered` integer DEFAULT false NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `local_auth_sessions_token_hash_unique` ON `local_auth_sessions` (`token_hash`);--> statement-breakpoint
CREATE INDEX `local_auth_sessions_expiry_idx` ON `local_auth_sessions` (`expires_at`);
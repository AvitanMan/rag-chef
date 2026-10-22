CREATE TABLE `kitchen_state` (
	`id` text PRIMARY KEY NOT NULL,
	`state_json` text NOT NULL,
	`revision` integer NOT NULL,
	`updated_at` text NOT NULL
);

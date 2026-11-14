CREATE TABLE `kitchen_command_receipt` (
	`household_id` text NOT NULL,
	`actor_id` text NOT NULL,
	`command_id` text NOT NULL,
	`request_hash` text NOT NULL,
	`document_json` text NOT NULL,
	`applied` integer NOT NULL,
	`attempt_token` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`household_id`, `actor_id`, `command_id`),
	CONSTRAINT "kitchen_command_receipt_applied_check" CHECK("kitchen_command_receipt"."applied" IN (0,1))
);
--> statement-breakpoint
CREATE INDEX `kitchen_command_receipt_actor_idx` ON `kitchen_command_receipt` (`actor_id`);
--> statement-breakpoint
-- Standalone sentinel IDs cannot reference hosted organization/user rows.
CREATE TRIGGER household_command_receipt_cleanup AFTER DELETE ON organization BEGIN DELETE FROM kitchen_command_receipt WHERE household_id=OLD.id; END;
--> statement-breakpoint
CREATE TRIGGER user_command_receipt_cleanup AFTER DELETE ON user BEGIN DELETE FROM kitchen_command_receipt WHERE actor_id=OLD.id; END;

PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_ticket_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`ticket_tier_id` integer,
	`user_id` integer NOT NULL,
	`ticket_name` text,
	`amount_minor` integer NOT NULL,
	`currency` text DEFAULT 'RUB' NOT NULL,
	`status` text DEFAULT 'awaiting_payment' NOT NULL,
	`expires_at` integer NOT NULL,
	`paid_at` integer,
	`fulfilled_at` integer,
	`canceled_at` integer,
	`refunded_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`ticket_tier_id`) REFERENCES `ticket_tiers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
INSERT INTO `__new_ticket_orders`("id", "event_id", "ticket_tier_id", "user_id", "ticket_name", "amount_minor", "currency", "status", "expires_at", "paid_at", "fulfilled_at", "canceled_at", "refunded_at", "created_at", "updated_at") SELECT "id", "event_id", "ticket_tier_id", "user_id", "ticket_name", "amount_minor", "currency", "status", "expires_at", "paid_at", "fulfilled_at", "canceled_at", "refunded_at", "created_at", "updated_at" FROM `ticket_orders`;--> statement-breakpoint
DROP TABLE `ticket_orders`;--> statement-breakpoint
ALTER TABLE `__new_ticket_orders` RENAME TO `ticket_orders`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `ticket_orders_event_status_idx` ON `ticket_orders` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `ticket_orders_user_created_idx` ON `ticket_orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_orders_unsettled_event_user_unique` ON `ticket_orders` (`event_id`,`user_id`) WHERE "ticket_orders"."status" IN ('awaiting_payment', 'payment_succeeded', 'cancel_pending');
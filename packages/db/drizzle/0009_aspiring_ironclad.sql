CREATE TABLE `payment_attempts` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`provider` text DEFAULT 'yookassa' NOT NULL,
	`provider_payment_id` text,
	`idempotence_key` text NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`confirmation_url` text,
	`provider_created_at` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ticket_orders`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `payment_attempts_order_id_idx` ON `payment_attempts` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_provider_payment_id_unique` ON `payment_attempts` (`provider_payment_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `payment_attempts_idempotence_key_unique` ON `payment_attempts` (`idempotence_key`);--> statement-breakpoint
CREATE TABLE `refunds` (
	`id` text PRIMARY KEY NOT NULL,
	`order_id` text NOT NULL,
	`payment_attempt_id` text NOT NULL,
	`provider_refund_id` text,
	`idempotence_key` text NOT NULL,
	`amount_minor` integer NOT NULL,
	`status` text DEFAULT 'pending' NOT NULL,
	`reason` text NOT NULL,
	`failure_reason` text,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ticket_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`payment_attempt_id`) REFERENCES `payment_attempts`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `refunds_order_id_idx` ON `refunds` (`order_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_provider_refund_id_unique` ON `refunds` (`provider_refund_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `refunds_idempotence_key_unique` ON `refunds` (`idempotence_key`);--> statement-breakpoint
CREATE TABLE `ticket_orders` (
	`id` text PRIMARY KEY NOT NULL,
	`event_id` integer NOT NULL,
	`ticket_tier_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`ticket_name` text NOT NULL,
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
CREATE INDEX `ticket_orders_event_status_idx` ON `ticket_orders` (`event_id`,`status`);--> statement-breakpoint
CREATE INDEX `ticket_orders_user_created_idx` ON `ticket_orders` (`user_id`,`created_at`);--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_orders_active_event_user_unique` ON `ticket_orders` (`event_id`,`user_id`) WHERE "ticket_orders"."status" NOT IN ('canceled', 'refunded');--> statement-breakpoint
CREATE TABLE `ticket_tiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
	`name` text NOT NULL,
	`price_minor` integer NOT NULL,
	`quota` integer,
	`sales_start_at` integer,
	`sales_end_at` integer,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `ticket_tiers_event_id_sort_order_idx` ON `ticket_tiers` (`event_id`,`sort_order`,`id`);
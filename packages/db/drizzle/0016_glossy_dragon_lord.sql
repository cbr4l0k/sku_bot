CREATE TABLE `event_series` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`city` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`location` text NOT NULL,
	`location_url` text,
	`capacity` integer,
	`waitlist_enabled` integer DEFAULT true NOT NULL,
	`home_chat_id` integer,
	`next_starts_at` integer,
	`cadence_days` integer,
	`lead_days` integer DEFAULT 14 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`created_by` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`created_by`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `series_chats` (
	`series_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	PRIMARY KEY(`series_id`, `chat_id`),
	FOREIGN KEY (`series_id`) REFERENCES `event_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `series_organizers` (
	`series_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	PRIMARY KEY(`series_id`, `user_id`),
	FOREIGN KEY (`series_id`) REFERENCES `event_series`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `series_product_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`name` text NOT NULL,
	`stock` integer,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `series_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `series_product_variants_product_id_sort_order_idx` ON `series_product_variants` (`product_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `series_product_variants_active_product_id_name_unique` ON `series_product_variants` (`product_id`,`name`) WHERE "series_product_variants"."active" = true;--> statement-breakpoint
CREATE TABLE `series_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`kind` text DEFAULT 'merchandise' NOT NULL,
	`name` text NOT NULL,
	`description` text,
	`price_minor` integer NOT NULL,
	`stock` integer,
	`max_per_order` integer DEFAULT 1 NOT NULL,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `event_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `series_products_series_id_sort_order_idx` ON `series_products` (`series_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `series_ticket_tiers` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`series_id` integer NOT NULL,
	`name` text NOT NULL,
	`price_minor` integer NOT NULL,
	`quota` integer,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`series_id`) REFERENCES `event_series`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `series_ticket_tiers_series_id_sort_order_idx` ON `series_ticket_tiers` (`series_id`,`sort_order`,`id`);--> statement-breakpoint
ALTER TABLE `events` ADD `series_id` integer REFERENCES event_series(id) ON DELETE SET NULL;--> statement-breakpoint
CREATE INDEX `events_series_id_starts_at_idx` ON `events` (`series_id`,`starts_at`);

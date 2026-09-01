CREATE TABLE `event_products` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`event_id` integer NOT NULL,
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
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_products_event_id_sort_order_idx` ON `event_products` (`event_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE TABLE `order_items` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`order_id` text NOT NULL,
	`ticket_tier_id` integer,
	`event_product_id` integer,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`unit_amount_minor` integer NOT NULL,
	`quantity` integer NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`order_id`) REFERENCES `ticket_orders`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`ticket_tier_id`) REFERENCES `ticket_tiers`(`id`) ON UPDATE no action ON DELETE restrict,
	FOREIGN KEY (`event_product_id`) REFERENCES `event_products`(`id`) ON UPDATE no action ON DELETE restrict
);
--> statement-breakpoint
CREATE INDEX `order_items_order_id_idx` ON `order_items` (`order_id`);--> statement-breakpoint
CREATE INDEX `order_items_ticket_tier_id_idx` ON `order_items` (`ticket_tier_id`);--> statement-breakpoint
CREATE INDEX `order_items_event_product_id_idx` ON `order_items` (`event_product_id`);
CREATE TABLE `event_product_variants` (
	`id` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`product_id` integer NOT NULL,
	`name` text NOT NULL,
	`stock` integer,
	`active` integer DEFAULT true NOT NULL,
	`sort_order` integer DEFAULT 0 NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`updated_at` integer DEFAULT (unixepoch()) NOT NULL,
	FOREIGN KEY (`product_id`) REFERENCES `event_products`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `event_product_variants_product_id_sort_order_idx` ON `event_product_variants` (`product_id`,`sort_order`,`id`);--> statement-breakpoint
CREATE UNIQUE INDEX `event_product_variants_active_product_id_name_unique` ON `event_product_variants` (`product_id`,`name`) WHERE "event_product_variants"."active" = true;--> statement-breakpoint
ALTER TABLE `order_items` ADD `event_product_variant_id` integer REFERENCES event_product_variants(id);--> statement-breakpoint
ALTER TABLE `order_items` ADD `variant_name` text;--> statement-breakpoint
CREATE INDEX `order_items_event_product_variant_id_idx` ON `order_items` (`event_product_variant_id`);
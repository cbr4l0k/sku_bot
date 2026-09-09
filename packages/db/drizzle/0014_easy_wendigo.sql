ALTER TABLE `order_items` ADD `handed_over_at` integer;--> statement-breakpoint
ALTER TABLE `order_items` ADD `handed_over_by` integer REFERENCES users(id);
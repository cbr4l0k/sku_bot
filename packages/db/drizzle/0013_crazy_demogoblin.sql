DROP INDEX `ticket_orders_unsettled_event_user_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `ticket_orders_unsettled_event_user_unique` ON `ticket_orders` (`event_id`,`user_id`) WHERE "ticket_orders"."status" = 'awaiting_payment';

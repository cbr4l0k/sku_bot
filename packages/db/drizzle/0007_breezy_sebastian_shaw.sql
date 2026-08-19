CREATE TABLE `chat_guests` (
	`chat_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`event_id` integer NOT NULL,
	`invite_link` text NOT NULL,
	`status` text DEFAULT 'invited' NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	`settled_at` integer,
	PRIMARY KEY(`chat_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `chat_guests_event_id_status_idx` ON `chat_guests` (`event_id`,`status`);--> statement-breakpoint
ALTER TABLE `events` ADD `home_chat_id` integer;
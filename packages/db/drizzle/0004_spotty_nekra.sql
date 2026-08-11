CREATE TABLE `chat_members` (
	`chat_id` integer NOT NULL,
	`user_id` integer NOT NULL,
	`is_member` integer NOT NULL,
	`checked_at` integer NOT NULL,
	PRIMARY KEY(`chat_id`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `event_chats` (
	`event_id` integer NOT NULL,
	`chat_id` integer NOT NULL,
	PRIMARY KEY(`event_id`, `chat_id`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);

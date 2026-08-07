CREATE TABLE `event_groups` (
	`event_id` integer NOT NULL,
	`group_name` text NOT NULL,
	PRIMARY KEY(`event_id`, `group_name`),
	FOREIGN KEY (`event_id`) REFERENCES `events`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE TABLE `user_groups` (
	`user_id` integer NOT NULL,
	`group_name` text NOT NULL,
	PRIMARY KEY(`user_id`, `group_name`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_groups_group_name_idx` ON `user_groups` (`group_name`);
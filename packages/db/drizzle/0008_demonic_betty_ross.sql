CREATE TABLE `chats` (
	`id` integer PRIMARY KEY NOT NULL,
	`city` text,
	`title` text,
	`problem` text,
	`checked_at` integer,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL
);
--> statement-breakpoint
CREATE TABLE `user_city_roles` (
	`city` text NOT NULL,
	`user_id` integer NOT NULL,
	`role` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch()) NOT NULL,
	PRIMARY KEY(`city`, `user_id`),
	FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE INDEX `user_city_roles_user_id_idx` ON `user_city_roles` (`user_id`);--> statement-breakpoint
DROP INDEX `events_status_starts_at_idx`;--> statement-breakpoint
ALTER TABLE `events` ADD `city` text DEFAULT 'spb' NOT NULL;--> statement-breakpoint
CREATE INDEX `events_city_status_starts_at_idx` ON `events` (`city`,`status`,`starts_at`);--> statement-breakpoint
ALTER TABLE `users` ADD `city` text;--> statement-breakpoint
-- Every run so far has been Petersburg's, bar one: event 7 (the `evt_7` deep link)
-- is Moscow's. The column default has already filed the rest correctly.
UPDATE `events` SET `city` = 'msk' WHERE `id` = 7;--> statement-breakpoint
-- Likewise everyone who already has an account came in through Petersburg, so they
-- are spared the first-run branch picker. Accounts created from here on start null
-- and are asked.
UPDATE `users` SET `city` = 'spb';

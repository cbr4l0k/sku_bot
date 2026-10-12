ALTER TABLE `event_series` ADD `reminders_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `events` ADD `reminders_enabled` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `registrations` ADD `reminded_at` integer;
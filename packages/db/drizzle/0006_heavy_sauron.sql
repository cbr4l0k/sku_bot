ALTER TABLE `events` ADD `ended_at` integer;--> statement-breakpoint
-- "Over" used to mean "the start time has passed", so every event already behind us
-- is marked ended here. Without this they would all come back to life as live events.
UPDATE `events` SET `ended_at` = `starts_at` WHERE `starts_at` <= unixepoch() AND `status` <> 'draft';

CREATE TABLE `exchange_rate` (
	`store_id` text NOT NULL,
	`base_currency` text NOT NULL,
	`quote_currency` text NOT NULL,
	`rate` real,
	`rate_step_id` text,
	`fetched_rate` real,
	`fetched_at` integer,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`store_id`, `base_currency`),
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`rate_step_id`) REFERENCES `exchange_rate_step`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `exchange_rate_step` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`base_currency` text NOT NULL,
	`quote_currency` text NOT NULL,
	`rate_from` real,
	`rate_to` real NOT NULL,
	`fetched_rate` real,
	`source` text NOT NULL,
	`session_id` text,
	`stepped_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `exchange_rate_step_store_stepped` ON `exchange_rate_step` (`store_id`,`stepped_at`);--> statement-breakpoint
ALTER TABLE `sync_run` ADD `records_skipped` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `store` ADD `fx_step_threshold_pct` integer DEFAULT 2 NOT NULL;
CREATE TABLE `catalogue_quarantine` (
	`id` text PRIMARY KEY NOT NULL,
	`sync_run_id` text NOT NULL,
	`kind` text NOT NULL,
	`game_system` text NOT NULL,
	`record_kind` text,
	`record_id` text,
	`cursor` text,
	`reason` text NOT NULL,
	`detail` text NOT NULL,
	`raw` text NOT NULL,
	`quarantined_at` integer NOT NULL,
	FOREIGN KEY (`sync_run_id`) REFERENCES `sync_run`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `catalogue_quarantine_run` ON `catalogue_quarantine` (`sync_run_id`);--> statement-breakpoint
CREATE TABLE `catalogue_set` (
	`game_system` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`released_on` text,
	`cursor` text NOT NULL,
	`content_hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`game_system`, `code`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `catalogue_vocabulary` (
	`game_system` text NOT NULL,
	`facet` text NOT NULL,
	`code` text NOT NULL,
	`name` text NOT NULL,
	`sort_order` integer NOT NULL,
	`cursor` text NOT NULL,
	`content_hash` text NOT NULL,
	`synced_at` integer NOT NULL,
	PRIMARY KEY(`game_system`, `facet`, `code`)
) STRICT;
--> statement-breakpoint
CREATE TABLE `printing` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`game_system` text NOT NULL,
	`name` text NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text,
	`rarity` text,
	`finish` text,
	`images` text NOT NULL,
	`market_price` integer,
	`market_price_currency` text,
	`market_price_cursor` text,
	`market_price_updated_at` integer,
	`withdrawn` integer NOT NULL,
	`cursor` text NOT NULL,
	`synced_at` integer NOT NULL
) STRICT;
--> statement-breakpoint
CREATE TABLE `printing_detail` (
	`printing_id` text PRIMARY KEY NOT NULL,
	`record` text NOT NULL,
	`content_hash` text NOT NULL,
	`cursor` text NOT NULL,
	`synced_at` integer NOT NULL,
	FOREIGN KEY (`printing_id`) REFERENCES `printing`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `sync_run` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`game_system` text NOT NULL,
	`status` text NOT NULL,
	`cursor_from` text NOT NULL,
	`cursor_to` text NOT NULL,
	`records_seen` integer NOT NULL,
	`printings_seen` integer NOT NULL,
	`records_written` integer NOT NULL,
	`records_quarantined` integer NOT NULL,
	`records_drifted` integer NOT NULL,
	`error` text,
	`workflow_instance_id` text,
	`started_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`finished_at` integer
) STRICT;
--> statement-breakpoint
CREATE INDEX `sync_run_kind_game_started` ON `sync_run` (`kind`,`game_system`,`started_at`);
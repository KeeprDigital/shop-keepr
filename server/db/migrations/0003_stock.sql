CREATE TABLE `ledger_entry` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`kind` text NOT NULL,
	`created_at` integer NOT NULL,
	`surface` text NOT NULL,
	`session_id` text NOT NULL,
	`staff_user_id` text,
	`origin` text,
	`pos_reference` text,
	`basket_id` text,
	`trade_id` text,
	`tender` text,
	`tender_modifier_pct` integer,
	`total_pct` integer,
	`remainder_tender` text,
	`total` integer,
	`net` integer,
	`reason` text,
	`note` text,
	`reverses` text,
	`customer_name` text,
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`reverses`) REFERENCES `ledger_entry`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `ledger_entry_store_created` ON `ledger_entry` (`store_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `ledger_entry_store_pos_reference` ON `ledger_entry` (`store_id`,`pos_reference`);--> statement-breakpoint
CREATE INDEX `ledger_entry_store_trade` ON `ledger_entry` (`store_id`,`trade_id`);--> statement-breakpoint
CREATE INDEX `ledger_entry_reverses` ON `ledger_entry` (`reverses`);--> statement-breakpoint
CREATE TABLE `ledger_line` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`store_id` text NOT NULL,
	`printing_id` text NOT NULL,
	`condition` text NOT NULL,
	`language` text NOT NULL,
	`sku_id` text NOT NULL,
	`quantity` integer NOT NULL,
	`card_name` text NOT NULL,
	`collector_number` text,
	`set_code` text NOT NULL,
	`rarity` text,
	`list_price` integer,
	`transacted_price` integer,
	FOREIGN KEY (`entry_id`) REFERENCES `ledger_entry`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`printing_id`) REFERENCES `printing`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `sku`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `ledger_line_entry` ON `ledger_line` (`entry_id`);--> statement-breakpoint
CREATE INDEX `ledger_line_store_sku_entry` ON `ledger_line` (`store_id`,`sku_id`,`entry_id`);--> statement-breakpoint
CREATE TABLE `projection_drift` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`sku_id` text NOT NULL,
	`stored_on_hand` integer NOT NULL,
	`ledger_on_hand` integer NOT NULL,
	`healed_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`sku_id`) REFERENCES `sku`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `projection_drift_store_healed` ON `projection_drift` (`store_id`,`healed_at`);--> statement-breakpoint
CREATE TABLE `sku` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`printing_id` text NOT NULL,
	`condition` text NOT NULL,
	`language` text NOT NULL,
	`on_hand` integer NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`printing_id`) REFERENCES `printing`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE UNIQUE INDEX `sku_key` ON `sku` (`store_id`,`printing_id`,`condition`,`language`);
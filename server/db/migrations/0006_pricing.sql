CREATE TABLE `pricing_setting` (
	`store_id` text NOT NULL,
	`scope` text NOT NULL,
	`side` text NOT NULL,
	`key` text NOT NULL,
	`value` text NOT NULL,
	`updated_at` integer NOT NULL,
	PRIMARY KEY(`store_id`, `scope`, `side`, `key`),
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE TABLE `reprice_sweep` (
	`id` text PRIMARY KEY NOT NULL,
	`store_id` text NOT NULL,
	`status` text NOT NULL,
	`reason` text NOT NULL,
	`games` text,
	`watermark` integer NOT NULL,
	`cursor` text NOT NULL,
	`total` integer NOT NULL,
	`done` integer NOT NULL,
	`error` text,
	`requested_at` integer NOT NULL,
	`started_at` integer,
	`updated_at` integer NOT NULL,
	`finished_at` integer,
	FOREIGN KEY (`store_id`) REFERENCES `store`(`id`) ON UPDATE no action ON DELETE no action
) STRICT;
--> statement-breakpoint
CREATE INDEX `reprice_sweep_store_status` ON `reprice_sweep` (`store_id`,`status`);--> statement-breakpoint
CREATE INDEX `reprice_sweep_store_requested` ON `reprice_sweep` (`store_id`,`requested_at`);--> statement-breakpoint
ALTER TABLE `sku` ADD `sell_price` integer;--> statement-breakpoint
ALTER TABLE `sku` ADD `sell_price_source` text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE `sku` ADD `sell_pinned_session_id` text;--> statement-breakpoint
ALTER TABLE `sku` ADD `sell_pinned_staff_user_id` text;--> statement-breakpoint
ALTER TABLE `sku` ADD `sell_pinned_at` integer;--> statement-breakpoint
ALTER TABLE `sku` ADD `buy_price` integer;--> statement-breakpoint
ALTER TABLE `sku` ADD `buy_price_source` text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE `sku` ADD `buy_pinned_session_id` text;--> statement-breakpoint
ALTER TABLE `sku` ADD `buy_pinned_staff_user_id` text;--> statement-breakpoint
ALTER TABLE `sku` ADD `buy_pinned_at` integer;--> statement-breakpoint
ALTER TABLE `sku` ADD `priced_at` integer;--> statement-breakpoint
CREATE INDEX `sku_store_sell_price` ON `sku` (`store_id`,`sell_price`);--> statement-breakpoint
CREATE INDEX `sku_store_buy_price` ON `sku` (`store_id`,`buy_price`);
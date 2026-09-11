CREATE TABLE `store` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`currency` text NOT NULL,
	`default_language` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL
) STRICT;

CREATE TABLE `mtg_printing` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`name_folded_nospace` text NOT NULL,
	`name_metaphone` text NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text,
	`rarity` text,
	`market_price` integer,
	`withdrawn` integer NOT NULL,
	`keys_version` integer NOT NULL,
	`cursor` text NOT NULL,
	`synced_at` integer NOT NULL,
	`colour_w` integer NOT NULL,
	`colour_u` integer NOT NULL,
	`colour_b` integer NOT NULL,
	`colour_r` integer NOT NULL,
	`colour_g` integer NOT NULL,
	`card_type` text,
	`finish` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `onepiece_printing` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`name_folded_nospace` text NOT NULL,
	`name_metaphone` text NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text,
	`rarity` text,
	`market_price` integer,
	`withdrawn` integer NOT NULL,
	`keys_version` integer NOT NULL,
	`cursor` text NOT NULL,
	`synced_at` integer NOT NULL,
	`colour_red` integer NOT NULL,
	`colour_green` integer NOT NULL,
	`colour_blue` integer NOT NULL,
	`colour_purple` integer NOT NULL,
	`colour_black` integer NOT NULL,
	`colour_yellow` integer NOT NULL,
	`card_type` text,
	`finish` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `pokemon_printing` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`name_folded_nospace` text NOT NULL,
	`name_metaphone` text NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text,
	`rarity` text,
	`market_price` integer,
	`withdrawn` integer NOT NULL,
	`keys_version` integer NOT NULL,
	`cursor` text NOT NULL,
	`synced_at` integer NOT NULL,
	`card_kind` text,
	`energy_type` text,
	`stage` text,
	`variant` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `riftbound_printing` (
	`id` text PRIMARY KEY NOT NULL,
	`card_id` text NOT NULL,
	`name` text NOT NULL,
	`name_folded` text NOT NULL,
	`name_folded_nospace` text NOT NULL,
	`name_metaphone` text NOT NULL,
	`set_code` text NOT NULL,
	`collector_number` text,
	`rarity` text,
	`market_price` integer,
	`withdrawn` integer NOT NULL,
	`keys_version` integer NOT NULL,
	`cursor` text NOT NULL,
	`synced_at` integer NOT NULL,
	`domain_fury` integer NOT NULL,
	`domain_calm` integer NOT NULL,
	`domain_mind` integer NOT NULL,
	`domain_body` integer NOT NULL,
	`domain_chaos` integer NOT NULL,
	`domain_order` integer NOT NULL,
	`card_type` text,
	`finish` text
) STRICT;
--> statement-breakpoint
CREATE TABLE `token_trigram` (
	`trigram` text NOT NULL,
	`token` text NOT NULL,
	PRIMARY KEY(`trigram`, `token`)
) STRICT;
--> statement-breakpoint
CREATE VIRTUAL TABLE `mtg_printing_fts` USING fts5(`name_folded`, `name_metaphone`, content='mtg_printing', content_rowid='rowid');--> statement-breakpoint
CREATE VIRTUAL TABLE `pokemon_printing_fts` USING fts5(`name_folded`, `name_metaphone`, content='pokemon_printing', content_rowid='rowid');--> statement-breakpoint
CREATE VIRTUAL TABLE `onepiece_printing_fts` USING fts5(`name_folded`, `name_metaphone`, content='onepiece_printing', content_rowid='rowid');--> statement-breakpoint
CREATE VIRTUAL TABLE `riftbound_printing_fts` USING fts5(`name_folded`, `name_metaphone`, content='riftbound_printing', content_rowid='rowid');

ALTER TABLE `share_links` ADD `guest_interact` integer DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE `share_links` ADD `guest_edit` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `share_links` ADD `guest_edit_source` integer DEFAULT false NOT NULL;
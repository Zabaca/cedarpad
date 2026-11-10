CREATE TABLE `oauthAccessToken` (
	`id` text PRIMARY KEY NOT NULL,
	`access_token` text NOT NULL,
	`refresh_token` text NOT NULL,
	`access_token_expires_at` integer NOT NULL,
	`refresh_token_expires_at` integer NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauthApplication`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthAccessToken_access_token_unique` ON `oauthAccessToken` (`access_token`);--> statement-breakpoint
CREATE UNIQUE INDEX `oauthAccessToken_refresh_token_unique` ON `oauthAccessToken` (`refresh_token`);--> statement-breakpoint
CREATE TABLE `oauthApplication` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`icon` text,
	`metadata` text,
	`client_id` text NOT NULL,
	`client_secret` text,
	`redirect_urls` text NOT NULL,
	`type` text NOT NULL,
	`disabled` integer DEFAULT false,
	`user_id` text,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
CREATE UNIQUE INDEX `oauthApplication_client_id_unique` ON `oauthApplication` (`client_id`);--> statement-breakpoint
CREATE TABLE `oauthConsent` (
	`id` text PRIMARY KEY NOT NULL,
	`client_id` text NOT NULL,
	`user_id` text NOT NULL,
	`scopes` text NOT NULL,
	`created_at` integer NOT NULL,
	`updated_at` integer NOT NULL,
	`consent_given` integer NOT NULL,
	FOREIGN KEY (`client_id`) REFERENCES `oauthApplication`(`client_id`) ON UPDATE no action ON DELETE cascade,
	FOREIGN KEY (`user_id`) REFERENCES `user`(`id`) ON UPDATE no action ON DELETE cascade
);

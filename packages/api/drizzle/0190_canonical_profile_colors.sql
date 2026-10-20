-- oxy:deploy-phase=post
-- The new image no longer assigns amber. Preserve existing choices and hex seeds.
UPDATE users SET color = 'yellow' WHERE color = 'amber';--> statement-breakpoint
UPDATE users SET theme_preference_color_preset = 'yellow' WHERE theme_preference_color_preset = 'amber';

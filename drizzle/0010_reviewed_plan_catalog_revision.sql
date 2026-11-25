CREATE TABLE `recipe_catalog_revision` (
	`id` integer PRIMARY KEY NOT NULL,
	`revision` integer DEFAULT 0 NOT NULL,
	CONSTRAINT "recipe_catalog_revision_singleton" CHECK("recipe_catalog_revision"."id" = 1)
);

--> statement-breakpoint
INSERT INTO recipe_catalog_revision(id, revision) VALUES(1, 0);
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_sources_insert AFTER INSERT ON recipe_sources
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_sources_update AFTER UPDATE ON recipe_sources
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_sources_delete AFTER DELETE ON recipe_sources
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipes_insert AFTER INSERT ON recipes
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipes_update AFTER UPDATE ON recipes
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipes_delete AFTER DELETE ON recipes
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_ingredients_insert AFTER INSERT ON recipe_ingredients
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_ingredients_update AFTER UPDATE ON recipe_ingredients
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_ingredients_delete AFTER DELETE ON recipe_ingredients
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_instruction_sections_insert AFTER INSERT ON recipe_instruction_sections
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_instruction_sections_update AFTER UPDATE ON recipe_instruction_sections
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_instruction_sections_delete AFTER DELETE ON recipe_instruction_sections
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_instruction_steps_insert AFTER INSERT ON recipe_instruction_steps
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_instruction_steps_update AFTER UPDATE ON recipe_instruction_steps
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_instruction_steps_delete AFTER DELETE ON recipe_instruction_steps
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_metadata_insert AFTER INSERT ON recipe_metadata
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_metadata_update AFTER UPDATE ON recipe_metadata
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;
--> statement-breakpoint
CREATE TRIGGER catalog_revision_recipe_metadata_delete AFTER DELETE ON recipe_metadata
BEGIN
  UPDATE recipe_catalog_revision SET revision = revision + 1 WHERE id = 1;
END;

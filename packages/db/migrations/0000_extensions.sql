CREATE SCHEMA IF NOT EXISTS public;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS pg_trgm WITH SCHEMA public;
--> statement-breakpoint
CREATE EXTENSION IF NOT EXISTS fuzzystrmatch WITH SCHEMA public;

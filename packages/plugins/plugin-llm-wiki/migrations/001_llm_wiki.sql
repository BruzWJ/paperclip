CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_instances (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  root_folder_key text NOT NULL DEFAULT 'wiki-root',
  configured_root_path text,
  schema_version integer NOT NULL DEFAULT 1,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  managed_agent_key text,
  managed_project_key text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_spaces (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL DEFAULT 'default',
  slug text NOT NULL,
  display_name text NOT NULL,
  space_type text NOT NULL DEFAULT 'local_folder',
  folder_mode text NOT NULL DEFAULT 'managed_subfolder',
  root_folder_key text NOT NULL DEFAULT 'wiki-root',
  path_prefix text,
  configured_root_path text,
  access_scope text NOT NULL DEFAULT 'shared',
  owner_user_id text,
  owner_agent_id uuid REFERENCES public.agents(id) ON DELETE SET NULL,
  team_key text,
  settings jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, slug)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_sources (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  source_type text NOT NULL,
  title text,
  url text,
  raw_path text NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL DEFAULT 'captured',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_pages (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  path text NOT NULL,
  title text,
  page_type text,
  frontmatter jsonb NOT NULL DEFAULT '{}'::jsonb,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  backlinks jsonb NOT NULL DEFAULT '[]'::jsonb,
  content_hash text,
  current_revision_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT wiki_pages_company_wiki_space_path_key UNIQUE (company_id, wiki_id, space_id, path)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_operations (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  operation_type text NOT NULL,
  status text NOT NULL,
  issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  run_ids jsonb NOT NULL DEFAULT '[]'::jsonb,
  cost_cents integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  affected_pages jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_page_revisions (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  page_id uuid REFERENCES plugin_llm_wiki_8f50da974f.wiki_pages(id) ON DELETE CASCADE,
  operation_id uuid,
  path text NOT NULL,
  content_hash text NOT NULL,
  summary text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.wiki_resource_bindings (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  resource_kind text NOT NULL,
  resource_key text NOT NULL,
  resolved_id uuid,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (company_id, wiki_id, resource_kind, resource_key)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  source_scope text NOT NULL,
  scope_key text NOT NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  source_kind text NOT NULL DEFAULT 'paperclip_issue_history',
  last_processed_at timestamptz,
  last_observed_at timestamptz,
  pending_event_count integer NOT NULL DEFAULT 0,
  last_successful_run_id uuid,
  last_source_hash text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distillation_cursors_company_wiki_space_scope_key
    UNIQUE (company_id, wiki_id, space_id, source_scope, scope_key, source_kind)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  work_item_kind text NOT NULL,
  status text NOT NULL DEFAULT 'pending',
  priority text NOT NULL DEFAULT 'medium',
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  requested_by_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  idempotency_key text,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT distillation_work_items_company_wiki_space_idempotency_key
    UNIQUE (company_id, wiki_id, space_id, idempotency_key)
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_distillation_runs (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  cursor_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_cursors(id) ON DELETE SET NULL,
  work_item_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_work_items(id) ON DELETE SET NULL,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  source_window_start timestamptz,
  source_window_end timestamptz,
  source_hash text,
  status text NOT NULL,
  operation_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  retry_count integer NOT NULL DEFAULT 0,
  cost_cents integer NOT NULL DEFAULT 0,
  warnings jsonb NOT NULL DEFAULT '[]'::jsonb,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_source_snapshots (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  distillation_run_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_runs(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE SET NULL,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE SET NULL,
  source_hash text NOT NULL,
  max_characters integer NOT NULL,
  clipped boolean NOT NULL DEFAULT false,
  source_refs jsonb NOT NULL DEFAULT '[]'::jsonb,
  bundle_markdown text NOT NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE plugin_llm_wiki_8f50da974f.paperclip_page_bindings (
  id uuid PRIMARY KEY,
  company_id uuid NOT NULL REFERENCES public.companies(id) ON DELETE CASCADE,
  wiki_id text NOT NULL,
  space_id uuid NOT NULL REFERENCES plugin_llm_wiki_8f50da974f.wiki_spaces(id) ON DELETE CASCADE,
  project_id uuid REFERENCES public.projects(id) ON DELETE CASCADE,
  root_issue_id uuid REFERENCES public.issues(id) ON DELETE CASCADE,
  page_path text NOT NULL,
  last_applied_source_hash text,
  last_distillation_run_id uuid REFERENCES plugin_llm_wiki_8f50da974f.paperclip_distillation_runs(id) ON DELETE SET NULL,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT page_bindings_company_wiki_space_page_path_key
    UNIQUE (company_id, wiki_id, space_id, page_path)
);

CREATE INDEX wiki_spaces_company_status_idx
  ON plugin_llm_wiki_8f50da974f.wiki_spaces (company_id, wiki_id, status);

CREATE INDEX wiki_sources_space_idx
  ON plugin_llm_wiki_8f50da974f.wiki_sources (company_id, wiki_id, space_id, created_at DESC);

CREATE INDEX wiki_operations_space_idx
  ON plugin_llm_wiki_8f50da974f.wiki_operations (company_id, wiki_id, space_id, created_at DESC);

CREATE INDEX distillation_runs_space_idx
  ON plugin_llm_wiki_8f50da974f.paperclip_distillation_runs (company_id, wiki_id, space_id, created_at DESC);

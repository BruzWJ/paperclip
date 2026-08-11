CREATE TABLE plugin_orchestration_smoke_1e8c264c64.smoke_runs (
  id uuid PRIMARY KEY,
  root_task_id uuid NOT NULL REFERENCES public.tasks(id) ON DELETE CASCADE,
  child_task_id uuid REFERENCES public.tasks(id) ON DELETE SET NULL,
  owner_agent_id uuid NOT NULL REFERENCES public.agents(id) ON DELETE RESTRICT,
  request text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

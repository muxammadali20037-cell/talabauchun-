-- Stage 2: study tools, games, workspace sharing.
create table game_sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  kind text not null check (kind in ('matching')),
  public_payload jsonb not null,
  private_key jsonb not null,           -- never sent to the client
  score int,
  max_score int not null,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);
create index game_sessions_user_idx on game_sessions(user_id, created_at desc);

alter table flashcards add column document_id uuid references documents(id) on delete set null;
alter table flashcards add constraint flashcards_unique_question unique (owner_id, question_stable_id);

alter table tasks add column topic text;
alter table tasks add column minutes int;
alter table tasks add column position int not null default 0;
alter table tasks add column rescheduled_count int not null default 0;

alter table study_plans add column timezone text not null default 'Asia/Tashkent';

alter table rooms add column team_count int not null default 0;

create table workspace_events (
  id bigserial primary key,
  workspace_id uuid not null references workspaces(id) on delete cascade,
  actor_id uuid references users(id),
  type text not null,
  target_type text,
  target_id uuid,
  data jsonb not null default '{}'::jsonb,
  at timestamptz not null default now()
);
create index workspace_events_ws_idx on workspace_events(workspace_id, id desc);

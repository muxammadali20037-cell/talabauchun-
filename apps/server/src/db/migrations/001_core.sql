-- TALABA AI core schema. All timestamps are UTC (timestamptz). Telegram ids are bigint.
create extension if not exists pg_trgm;
create extension if not exists vector;

-- ───────────────────────── Accounts ─────────────────────────
create table users (
  id uuid primary key default gen_random_uuid(),
  telegram_id bigint not null unique,
  username text,
  first_name text not null default '',
  last_name text,
  telegram_language text,
  language text not null default 'uz' check (language in ('uz','uz-Cyrl','ru','en')),
  language_confirmed boolean not null default false,
  edu_role text check (edu_role in ('student','teacher')),
  -- platform roles are assigned server-side only (ADMIN_TELEGRAM_IDS or admin action)
  platform_role text not null default 'user' check (platform_role in ('user','moderator','admin')),
  timezone text not null default 'Asia/Tashkent',
  onboarding_goal text check (onboarding_goal in ('presentation','quiz','book','question')),
  onboarded_at timestamptz,
  bot_chat_open boolean not null default false,
  bot_blocked_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table profiles (
  user_id uuid primary key references users(id) on delete cascade,
  university text,
  faculty text,
  course smallint check (course between 1 and 8),
  specialty text,
  nickname text,
  notifications_enabled boolean not null default true,
  quiet_hours_start smallint check (quiet_hours_start between 0 and 23),
  quiet_hours_end smallint check (quiet_hours_end between 0 and 23),
  updated_at timestamptz not null default now()
);

create table sessions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id) on delete cascade,
  token_hash bytea not null unique,
  auth_method text not null check (auth_method in ('telegram_webapp','dev')),
  init_data_hash text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  last_seen_at timestamptz
);
create index sessions_user_idx on sessions(user_id);

create table workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  kind text not null check (kind in ('personal','group')),
  owner_id uuid not null references users(id),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create unique index workspaces_one_personal on workspaces(owner_id) where kind = 'personal';

create table memberships (
  workspace_id uuid not null references workspaces(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  role text not null check (role in ('owner','editor','viewer')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index memberships_user_idx on memberships(user_id);

create table invitations (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('workspace','room','readonly','group_quiz')),
  workspace_id uuid references workspaces(id) on delete cascade,
  target_id uuid,
  role text check (role in ('editor','viewer','participant')),
  token_hash bytea not null unique,
  created_by uuid not null references users(id),
  expires_at timestamptz not null,
  revoked_at timestamptz,
  max_uses int,
  uses int not null default 0,
  created_at timestamptz not null default now()
);
create index invitations_target_idx on invitations(kind, target_id);

-- ───────────────────────── Sources ─────────────────────────
create table documents (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references users(id),
  title text not null,
  author text,
  published_info text,
  source_kind text not null check (source_kind in ('pdf','docx','pptx','txt','text','image','url','csv','xlsx')),
  source_url text,
  current_version_id uuid,
  created_via text not null default 'miniapp' check (created_via in ('miniapp','bot','api')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index documents_ws_idx on documents(workspace_id, created_at desc) where deleted_at is null;

create table document_versions (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references documents(id) on delete cascade,
  version_no int not null,
  storage_key text,
  original_filename text,
  mime text,
  byte_size bigint,
  sha256 text,
  status text not null default 'uploaded'
    check (status in ('uploaded','queued','extracting','indexing','ready','partial','failed','deleted')),
  page_count int,
  pages_ok int not null default 0,
  pages_failed int not null default 0,
  pages_low_conf int not null default 0,
  error_code text,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  processed_at timestamptz,
  unique (document_id, version_no)
);
alter table documents add constraint documents_current_version_fk
  foreign key (current_version_id) references document_versions(id) deferrable initially deferred;

create table pages (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references document_versions(id) on delete cascade,
  page_index int not null,               -- physical page / slide / section number, 1-based
  page_label text,                       -- printed page label from the PDF, if present
  kind text not null check (kind in ('pdf_page','slide','section','image','sheet','web','text')),
  heading text,
  text text not null default '',
  method text not null default 'text' check (method in ('text','ocr','none')),
  ocr_confidence real,
  status text not null check (status in ('ok','low_confidence','failed','empty')),
  error text,
  unique (document_version_id, page_index)
);

create table sections (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references document_versions(id) on delete cascade,
  title text not null,
  level smallint not null default 1,
  start_page int not null,
  end_page int not null,
  ord int not null
);
create index sections_dv_idx on sections(document_version_id, ord);

create table chunks (
  id uuid primary key default gen_random_uuid(),
  document_version_id uuid not null references document_versions(id) on delete cascade,
  page_id uuid references pages(id) on delete cascade,
  section_id uuid references sections(id) on delete set null,
  ord int not null,
  page_start int not null,
  page_end int not null,
  locator jsonb not null default '{}'::jsonb,
  text text not null,
  tsv tsvector generated always as (to_tsvector('simple', text)) stored,
  embedding vector(1024),
  embedding_model text,
  unique (document_version_id, ord)
);
create index chunks_tsv_idx on chunks using gin(tsv);
create index chunks_trgm_idx on chunks using gin(text gin_trgm_ops);
create index chunks_embedding_idx on chunks using hnsw (embedding vector_cosine_ops);

-- Evidence snapshot: quote + locator copied at creation time so later document
-- versions or deletions never silently change an existing quiz's evidence.
create table source_references (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  document_id uuid references documents(id) on delete set null,
  document_version_id uuid references document_versions(id) on delete set null,
  chunk_id uuid references chunks(id) on delete set null,
  document_title text not null,
  locator jsonb not null default '{}'::jsonb,
  quote text not null,
  verified boolean not null default false,
  verification text not null default 'none' check (verification in ('none','exact_quote','fuzzy_quote','user_confirmed','table_value')),
  created_at timestamptz not null default now()
);

-- ───────────────────────── Work / jobs ─────────────────────────
create table projects (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references users(id),
  title text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table artifacts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references users(id),
  project_id uuid references projects(id),
  kind text not null check (kind in ('deck_pptx','deck_pdf','handout','speech','defense_qa','data_export','quiz_export')),
  title text not null,
  target_id uuid,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table artifact_versions (
  id uuid primary key default gen_random_uuid(),
  artifact_id uuid not null references artifacts(id) on delete cascade,
  version_no int not null,
  storage_key text not null,
  mime text not null,
  byte_size bigint not null,
  sha256 text not null,
  checks jsonb not null default '{}'::jsonb,
  source_revision int,
  created_at timestamptz not null default now(),
  unique (artifact_id, version_no)
);

create table generation_jobs (
  id uuid primary key default gen_random_uuid(),
  kind text not null,
  user_id uuid not null references users(id),
  workspace_id uuid not null references workspaces(id),
  target_id uuid,
  status text not null default 'queued'
    check (status in ('queued','extracting','indexing','generating','validating','rendering','completed','failed','cancelled')),
  stages text[] not null default '{}',
  stage_index int not null default 0,
  idempotency_key text not null unique,
  pipeline_version int not null default 1,
  input jsonb not null default '{}'::jsonb,
  checkpoint jsonb not null default '{}'::jsonb,
  result jsonb,
  error_code text,
  error_message text,
  attempts int not null default 0,
  max_attempts int not null default 3,
  run_after timestamptz not null default now(),
  locked_by text,
  lease_expires_at timestamptz,
  cancel_requested boolean not null default false,
  credit_reservation_id uuid,
  notify_chat_id bigint,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz not null default now()
);
create index generation_jobs_pick_idx on generation_jobs(run_after) where status not in ('completed','failed','cancelled');
create index generation_jobs_user_idx on generation_jobs(user_id, created_at desc);
create index generation_jobs_target_idx on generation_jobs(target_id);

create table job_events (
  id bigserial primary key,
  job_id uuid not null references generation_jobs(id) on delete cascade,
  at timestamptz not null default now(),
  type text not null,
  status text,
  message text,
  data jsonb
);
create index job_events_job_idx on job_events(job_id, id);

-- ───────────────────────── Quiz ─────────────────────────
create table quizzes (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references users(id),
  title text not null,
  description text,
  language text not null default 'uz',
  subject text,
  topic text,
  settings jsonb not null default '{}'::jsonb,
  source_document_ids uuid[] not null default '{}',
  draft_version_id uuid,
  published_version_id uuid,
  visibility text not null default 'private' check (visibility in ('private','workspace','link','public_template')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index quizzes_ws_idx on quizzes(workspace_id, updated_at desc) where deleted_at is null;

create table quiz_versions (
  id uuid primary key default gen_random_uuid(),
  quiz_id uuid not null references quizzes(id) on delete cascade,
  version_no int not null,
  status text not null default 'draft' check (status in ('draft','published','archived')),
  based_on_version_id uuid references quiz_versions(id),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  published_at timestamptz,
  generation_note jsonb not null default '{}'::jsonb,
  unique (quiz_id, version_no)
);
alter table quizzes add constraint quizzes_draft_fk foreign key (draft_version_id) references quiz_versions(id) deferrable initially deferred;
alter table quizzes add constraint quizzes_published_fk foreign key (published_version_id) references quiz_versions(id) deferrable initially deferred;

create table questions (
  id uuid primary key default gen_random_uuid(),
  quiz_version_id uuid not null references quiz_versions(id) on delete cascade,
  stable_id uuid not null default gen_random_uuid(),
  revision int not null default 1,
  position int not null,
  type text not null default 'single' check (type in ('single','multiple','true_false','matching','ordering','fill_blank','short_answer')),
  text text not null,
  language text not null default 'uz',
  topic text,
  difficulty text not null default 'medium' check (difficulty in ('easy','medium','hard')),
  cognitive_level text not null default 'recall' check (cognitive_level in ('recall','understand','apply','analyze')),
  explanation text,
  status text not null default 'draft' check (status in ('draft','needs_review','approved','published','archived')),
  generator text not null check (generator in ('ai','extractive','user','import')),
  evidence_status text not null default 'unverified' check (evidence_status in ('verified','unverified','not_found','general_knowledge')),
  source_ref_id uuid references source_references(id) on delete set null,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (quiz_version_id, stable_id),
  unique (quiz_version_id, position) deferrable initially deferred
);
create index questions_version_idx on questions(quiz_version_id, position);

create table options (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  stable_id uuid not null default gen_random_uuid(),
  position int not null,
  text text not null,
  why_wrong text,
  unique (question_id, position) deferrable initially deferred
);
create index options_question_idx on options(question_id, position);

-- Answer keys live apart from questions/options so that ordinary question
-- queries cannot accidentally serialise them to clients.
create table private_answer_keys (
  question_id uuid primary key references questions(id) on delete cascade,
  correct_option_ids uuid[] not null,
  accepted_answers text[] not null default '{}',
  updated_at timestamptz not null default now()
);

create table question_checks (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  rule text not null,
  result text not null check (result in ('pass','warn','fail')),
  checker text not null check (checker in ('deterministic','ai','user')),
  detail jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index question_checks_q_idx on question_checks(question_id);

create table question_reports (
  id uuid primary key default gen_random_uuid(),
  question_id uuid not null references questions(id) on delete cascade,
  reporter_id uuid not null references users(id),
  reason text not null check (reason in ('wrong_key','ambiguous','bad_source','typo','other')),
  comment text,
  status text not null default 'open' check (status in ('open','resolved','rejected')),
  created_at timestamptz not null default now(),
  resolved_at timestamptz,
  unique (question_id, reporter_id)
);

create table attempts (
  id uuid primary key default gen_random_uuid(),
  quiz_version_id uuid not null references quiz_versions(id),
  user_id uuid not null references users(id),
  mode text not null check (mode in ('bot_practice','app_practice','room','group_native','mistakes')),
  room_id uuid,
  question_ids uuid[] not null,
  option_orders jsonb not null default '{}'::jsonb,
  current_index int not null default 0,
  score int not null default 0,
  max_score int not null default 0,
  status text not null default 'active' check (status in ('active','finished','abandoned')),
  started_at timestamptz not null default now(),
  finished_at timestamptz
);
create index attempts_user_idx on attempts(user_id, started_at desc);

create table attempt_answers (
  id uuid primary key default gen_random_uuid(),
  attempt_id uuid not null references attempts(id) on delete cascade,
  question_id uuid not null references questions(id),
  selected_option_ids uuid[] not null,
  is_correct boolean not null,
  points int not null default 0,
  answered_at timestamptz not null default now(),
  unique (attempt_id, question_id)
);

-- ───────────────────────── Live rooms ─────────────────────────
create table rooms (
  id uuid primary key default gen_random_uuid(),
  code text not null unique,
  title text not null,
  quiz_version_id uuid not null references quiz_versions(id),
  workspace_id uuid not null references workspaces(id),
  host_id uuid not null references users(id),
  co_host_id uuid references users(id),
  status text not null default 'lobby' check (status in ('lobby','running','paused','finished','cancelled')),
  phase text check (phase in ('question','reveal')),
  settings jsonb not null default '{}'::jsonb,
  question_ids uuid[] not null,
  current_index int not null default -1,
  question_started_at timestamptz,
  deadline_at timestamptz,
  paused_remaining_ms int,
  host_last_seen_at timestamptz,
  state_version bigint not null default 0,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  expires_at timestamptz not null default now() + interval '7 days'
);

create table teams (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  name text not null,
  color text not null default '#4F46E5'
);

create table room_members (
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid not null references users(id),
  display_name text not null,
  role text not null default 'participant' check (role in ('host','cohost','participant')),
  team_id uuid references teams(id) on delete set null,
  joined_at timestamptz not null default now(),
  last_seen_at timestamptz,
  connected boolean not null default false,
  primary key (room_id, user_id)
);

create table room_answers (
  id uuid primary key default gen_random_uuid(),
  room_id uuid not null references rooms(id) on delete cascade,
  question_id uuid not null references questions(id),
  user_id uuid not null references users(id),
  selected_option_ids uuid[] not null,
  received_at timestamptz not null default clock_timestamp(),
  latency_ms int not null,
  is_correct boolean not null,
  points int not null,
  unique (room_id, question_id, user_id)
);

create table scores (
  room_id uuid not null references rooms(id) on delete cascade,
  user_id uuid not null references users(id),
  points int not null default 0,
  correct int not null default 0,
  answered int not null default 0,
  primary key (room_id, user_id)
);

create table room_events (
  id bigserial primary key,
  room_id uuid not null references rooms(id) on delete cascade,
  at timestamptz not null default now(),
  type text not null,
  actor_id uuid,
  data jsonb not null default '{}'::jsonb
);
create index room_events_room_idx on room_events(room_id, id);

-- ───────────── Native Telegram group quizzes ─────────────
create table group_quiz_runs (
  id uuid primary key default gen_random_uuid(),
  quiz_version_id uuid not null references quiz_versions(id),
  host_id uuid not null references users(id),
  chat_id bigint,
  chat_title text,
  status text not null default 'pending_group' check (status in ('pending_group','ready','running','finished','failed','cancelled')),
  anonymous boolean not null default false,
  open_period int not null default 30,
  question_ids uuid[] not null,
  current_index int not null default -1,
  next_send_at timestamptz,
  link_token_hash bytea unique,
  link_expires_at timestamptz,
  error text,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create table telegram_polls (
  poll_id text primary key,
  run_id uuid not null references group_quiz_runs(id) on delete cascade,
  question_id uuid not null references questions(id),
  chat_id bigint not null,
  message_id bigint not null,
  option_ids uuid[] not null,        -- index i in the Telegram poll -> option id
  correct_indices int[] not null,
  sent_at timestamptz not null default now(),
  closes_at timestamptz
);

create table poll_answers (
  poll_id text not null references telegram_polls(poll_id) on delete cascade,
  telegram_user_id bigint not null,
  user_id uuid references users(id),
  display_name text,
  option_indices int[] not null,
  is_correct boolean not null,
  received_at timestamptz not null default now(),
  primary key (poll_id, telegram_user_id)
);

-- ───────────────────────── Slides ─────────────────────────
create table decks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references users(id),
  title text not null,
  settings jsonb not null default '{}'::jsonb,
  theme text not null default 'academic' check (theme in ('academic','data','creative')),
  status text not null default 'draft' check (status in ('draft','planning','plan_ready','generating','ready','failed')),
  outline jsonb,
  source_document_ids uuid[] not null default '{}',
  revision int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);

create table slides (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references decks(id) on delete cascade,
  position int not null,
  content jsonb not null,
  notes text not null default '',
  revision int not null default 1,
  locked_by uuid references users(id),
  lock_expires_at timestamptz,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index slides_deck_idx on slides(deck_id, position) where deleted_at is null;

create table slide_versions (
  id uuid primary key default gen_random_uuid(),
  slide_id uuid not null references slides(id) on delete cascade,
  revision int not null,
  position int not null,
  content jsonb not null,
  notes text not null default '',
  change_kind text not null check (change_kind in ('create','edit','regenerate','restore','reorder','delete')),
  created_by uuid references users(id),
  created_at timestamptz not null default now(),
  unique (slide_id, revision)
);

create table exports (
  id uuid primary key default gen_random_uuid(),
  deck_id uuid not null references decks(id) on delete cascade,
  deck_revision int not null,
  format text not null check (format in ('pptx','pdf')),
  status text not null default 'queued' check (status in ('queued','rendering','ready','failed')),
  artifact_version_id uuid references artifact_versions(id),
  checks jsonb not null default '{}'::jsonb,
  error text,
  job_id uuid references generation_jobs(id),
  created_at timestamptz not null default now()
);
create index exports_deck_idx on exports(deck_id, created_at desc);

-- ───────────────────────── Study ─────────────────────────
create table flashcards (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  owner_id uuid not null references users(id),
  collection text not null default 'default',
  front text not null,
  back text not null,
  source_ref_id uuid references source_references(id) on delete set null,
  question_stable_id uuid,
  ease real not null default 2.5,
  interval_days int not null default 0,
  reps int not null default 0,
  lapses int not null default 0,
  due_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index flashcards_due_idx on flashcards(owner_id, due_at) where deleted_at is null;

create table review_events (
  id bigserial primary key,
  user_id uuid not null references users(id),
  flashcard_id uuid references flashcards(id) on delete cascade,
  grade smallint not null check (grade between 0 and 5),
  reviewed_at timestamptz not null default now(),
  next_due_at timestamptz not null
);

create table study_plans (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  workspace_id uuid not null references workspaces(id),
  title text not null,
  exam_date date not null,
  daily_minutes int not null check (daily_minutes between 5 and 600),
  topics jsonb not null default '[]'::jsonb,
  diagnostic jsonb not null default '{}'::jsonb,
  status text not null default 'active' check (status in ('active','done','archived')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table tasks (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  plan_id uuid references study_plans(id) on delete cascade,
  title text not null,
  description text,
  kind text not null default 'task' check (kind in ('task','study','review','deadline')),
  assignee_id uuid references users(id),
  due_at timestamptz,
  status text not null default 'todo' check (status in ('todo','in_progress','done','skipped')),
  created_by uuid not null references users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  completed_at timestamptz
);
create index tasks_ws_idx on tasks(workspace_id, due_at);

create table comments (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  target_type text not null check (target_type in ('slide','question','document','task','deck','quiz')),
  target_id uuid not null,
  author_id uuid not null references users(id),
  body text not null,
  created_at timestamptz not null default now(),
  deleted_at timestamptz
);
create index comments_target_idx on comments(target_type, target_id, created_at);

create table stat_facts (
  id uuid primary key default gen_random_uuid(),
  workspace_id uuid not null references workspaces(id),
  document_version_id uuid references document_versions(id) on delete set null,
  source_ref_id uuid references source_references(id),
  indicator text not null,
  definition text,
  value numeric not null,
  unit text not null,
  geography text,
  period text,
  published_on date,
  source_url text,
  locator jsonb not null default '{}'::jsonb,
  sample_info text,
  denominator text,
  formula text,
  verified_at timestamptz,
  is_example boolean not null default false,
  created_at timestamptz not null default now()
);

-- ───────────────────────── Operations ─────────────────────────
create table notifications (
  id uuid primary key default gen_random_uuid(),
  user_id uuid references users(id),
  chat_id bigint not null,
  method text not null,
  payload jsonb not null,
  dedupe_key text unique,
  status text not null default 'pending' check (status in ('pending','sending','sent','failed','dead')),
  attempts int not null default 0,
  next_attempt_at timestamptz not null default now(),
  last_error text,
  result jsonb,
  created_at timestamptz not null default now(),
  sent_at timestamptz
);
create index notifications_pick_idx on notifications(next_attempt_at) where status = 'pending';

create table processed_updates (
  update_id bigint primary key,
  received_at timestamptz not null default now()
);

create table bot_states (
  user_id uuid primary key references users(id) on delete cascade,
  state text not null,
  data jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now()
);

create table usage_events (
  id bigserial primary key,
  user_id uuid references users(id),
  workspace_id uuid references workspaces(id),
  job_id uuid references generation_jobs(id) on delete set null,
  kind text not null check (kind in ('ai_tokens','ocr_page','render','storage_bytes','embedding_tokens')),
  provider text,
  model text,
  task text,
  input_tokens int,
  output_tokens int,
  quantity numeric,
  cost_usd numeric(12,6),
  latency_ms int,
  ok boolean not null default true,
  created_at timestamptz not null default now()
);
create index usage_events_created_idx on usage_events(created_at);

create table plans (
  code text primary key,
  title jsonb not null,
  price_stars int not null default 0,
  credits int not null default 0,
  period_days int,
  limits jsonb not null default '{}'::jsonb,
  active boolean not null default true,
  version int not null default 1,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table payments (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  provider text not null default 'telegram_stars',
  plan_code text not null references plans(code),
  plan_snapshot jsonb not null,
  invoice_payload text not null unique,
  currency text not null default 'XTR',
  amount int not null,
  credits int not null,
  status text not null default 'pending' check (status in ('pending','paid','refunded','failed','cancelled')),
  telegram_payment_charge_id text unique,
  provider_payment_charge_id text,
  created_at timestamptz not null default now(),
  paid_at timestamptz,
  refunded_at timestamptz,
  raw jsonb
);

create table credit_ledger (
  id bigserial primary key,
  user_id uuid not null references users(id),
  entry_type text not null check (entry_type in ('grant','reserve','capture','release','purchase','refund','adjust')),
  amount int not null,
  reservation_id uuid,
  job_id uuid references generation_jobs(id) on delete set null,
  payment_id uuid references payments(id),
  reason text,
  idempotency_key text not null unique,
  created_at timestamptz not null default now()
);
create index credit_ledger_user_idx on credit_ledger(user_id, id);
create index credit_ledger_reservation_idx on credit_ledger(reservation_id);

create table entitlements (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  plan_code text not null references plans(code),
  plan_snapshot jsonb not null,
  starts_at timestamptz not null default now(),
  ends_at timestamptz,
  source_payment_id uuid references payments(id),
  status text not null default 'active' check (status in ('active','expired','revoked')),
  created_at timestamptz not null default now()
);

create table audit_events (
  id bigserial primary key,
  actor_id uuid references users(id),
  action text not null,
  target_type text,
  target_id text,
  data jsonb not null default '{}'::jsonb,
  ip text,
  created_at timestamptz not null default now()
);
create index audit_events_created_idx on audit_events(created_at desc);

create table support_tickets (
  id bigserial primary key,
  user_id uuid not null references users(id),
  kind text not null check (kind in ('support','paysupport','content_error','data_request')),
  body text not null,
  status text not null default 'open' check (status in ('open','in_progress','resolved','rejected')),
  resolution text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table feature_flags (
  key text primary key,
  enabled boolean not null default false,
  data jsonb not null default '{}'::jsonb,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table model_configs (
  task text primary key,
  model text not null,
  effort text,
  max_tokens int not null default 16000,
  enabled boolean not null default true,
  previous jsonb,
  updated_by uuid references users(id),
  updated_at timestamptz not null default now()
);

create table data_requests (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references users(id),
  kind text not null check (kind in ('export','delete')),
  status text not null default 'pending' check (status in ('pending','processing','done','failed')),
  artifact_version_id uuid references artifact_versions(id),
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

insert into plans (code, title, price_stars, credits, period_days, limits) values
  ('free', '{"uz":"Bepul","ru":"Бесплатный","en":"Free"}', 0, 60, 30, '{"maxQuestionsPerQuiz":30,"maxUploadMb":50,"maxSlides":20}'),
  ('student_plus', '{"uz":"Student Plus","ru":"Student Plus","en":"Student Plus"}', 0, 0, 30, '{"maxQuestionsPerQuiz":60,"maxUploadMb":100,"maxSlides":40}'),
  ('group_teacher', '{"uz":"Guruh / Oʻqituvchi","ru":"Группа / Преподаватель","en":"Group / Teacher"}', 0, 0, 30, '{"maxQuestionsPerQuiz":100,"maxUploadMb":200,"maxSlides":40}');
-- Paid plan prices are intentionally 0 / inactive-for-sale until the cost model is approved (see docs/cost-model.md).
update plans set active = false where code <> 'free';

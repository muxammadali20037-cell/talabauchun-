-- Operations: activity days for retention, account deletion, moderation, data requests.
create table if not exists user_activity (
  user_id uuid not null references users(id) on delete cascade,
  day date not null,
  primary key (user_id, day)
);
create index if not exists user_activity_day on user_activity (day);

-- deleted accounts keep no Telegram identity, so the same person can start fresh
alter table users alter column telegram_id drop not null;
alter table users add column if not exists deleted_at timestamptz;

alter table quizzes add column if not exists moderated_at timestamptz;
alter table quizzes add column if not exists moderation_note text;

alter table data_requests add column if not exists error text;
alter table data_requests add column if not exists result jsonb;

alter table support_tickets add column if not exists replied_at timestamptz;
alter table support_tickets add column if not exists replied_by uuid references users(id);

create index if not exists generation_jobs_status_created on generation_jobs (status, created_at);
create index if not exists usage_events_created on usage_events (created_at);
create index if not exists audit_events_created on audit_events (created_at);

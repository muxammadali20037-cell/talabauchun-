-- Telegram updates: claim → handle → done, so an update whose handler died is processed again (at-least-once).
alter table processed_updates add column if not exists done boolean not null default true;
alter table processed_updates add column if not exists claimed_at timestamptz not null default now();
-- The admin freshness rule uses the Telegram auth_date of the initData that opened the session.
alter table sessions add column if not exists init_auth_date timestamptz;
-- 005 created indexes that duplicate ones from 001 under other names
drop index if exists usage_events_created;
drop index if exists audit_events_created;
-- Self-paced assignments (room mode "async"): everyone takes the quiz on their own until this time.
alter table rooms add column if not exists assignment_due_at timestamptz;
create unique index if not exists attempts_one_per_assignment on attempts (room_id, user_id) where room_id is not null and mode = 'room';

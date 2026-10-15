-- Aggregate results for native polls (needed for anonymous group quizzes, where
-- Telegram sends no per-user poll_answer updates).
alter table telegram_polls add column final_counts int[];
alter table telegram_polls add column total_voters int;
alter table telegram_polls add column closed_at timestamptz;
alter table group_quiz_runs add column skipped_question_ids uuid[] not null default '{}';
alter table group_quiz_runs add column option_orders jsonb not null default '{}'::jsonb;
create index group_quiz_runs_due_idx on group_quiz_runs(next_send_at) where status = 'running';

-- Presentation Studio.
-- slides.origin: how a slide was generated (plan key, source anchor, variant) so a
--   single slide can be regenerated from the same material without touching the others.
-- slide_versions.restored_from: the revision an undo restored, so repeated undo walks
--   further back instead of toggling between two states.
-- decks.generation: generation summary (mode, warnings, requested/produced counts).
alter table slides add column origin jsonb not null default '{}'::jsonb;
alter table slide_versions add column restored_from int;
alter table decks add column generation jsonb not null default '{}'::jsonb;
create index decks_ws_idx on decks(workspace_id, updated_at desc) where deleted_at is null;
create index artifacts_target_idx on artifacts(target_id) where deleted_at is null;

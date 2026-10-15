import type { Deps } from "../deps";

/**
 * Housekeeping (hourly in the worker). Keeps operational tables and the file
 * store from growing without bound:
 *  - Telegram update ids: 7 days (only needed to drop duplicate deliveries)
 *  - delivered/failed bot messages: 30 days
 *  - job event logs of finished jobs: 90 days
 *  - presentation exports older than 30 days that are not the latest of their
 *    deck and format: file, thumbnails and row (the deck itself is untouched)
 */
export async function retentionCleanup(deps: Deps) {
  const updates = await deps.sql`delete from processed_updates where done and claimed_at < now() - interval '7 days'`;
  const messages = await deps.sql`delete from notifications where status in ('sent','failed','dead') and created_at < now() - interval '30 days'`;
  const events = await deps.sql`delete from job_events e using generation_jobs j where j.id = e.job_id and j.finished_at < now() - interval '90 days'`;
  const old = await deps.sql<{ id: string; storage_key: string | null; artifact_version_id: string | null; thumbs: string[] | null }[]>`
    select e.id, av.storage_key, e.artifact_version_id, (select array_agg(x) from jsonb_array_elements_text(coalesce(e.checks->'thumbnails', '[]'::jsonb)) x) as thumbs
    from exports e left join artifact_versions av on av.id = e.artifact_version_id
    where e.created_at < now() - interval '30 days'
      and e.id <> (select e2.id from exports e2 where e2.deck_id = e.deck_id and e2.format = e.format order by e2.created_at desc limit 1)
    limit 500`;
  for (const x of old) {
    for (const k of [x.storage_key, ...(x.thumbs ?? [])]) if (k) await deps.storage.delete(k).catch(() => {});
    await deps.sql`delete from exports where id = ${x.id}`;
    if (x.artifact_version_id) await deps.sql`delete from artifact_versions where id = ${x.artifact_version_id}`;
  }
  return { updates: updates.count, messages: messages.count, events: events.count, exports: old.length };
}

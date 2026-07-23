alter table public.storage_cleanup_jobs
drop constraint storage_cleanup_jobs_object_keys_check;

alter table public.storage_cleanup_jobs
drop column object_keys;

alter table public.storage_cleanup_jobs
add column storage_prefix text;

update public.storage_cleanup_jobs
set storage_prefix = knowledge_base_id::text;

alter table public.storage_cleanup_jobs
alter column storage_prefix set not null;

alter table public.storage_cleanup_jobs
add constraint storage_cleanup_jobs_prefix_check
check (nullif(btrim(storage_prefix), '') is not null);

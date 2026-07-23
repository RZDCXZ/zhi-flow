select pgmq.create('document_ingestion_failed');

alter table public.documents
add column active_ingestion_message_id bigint,
add column active_ingestion_claim_id uuid;

alter table public.document_ingestion_enqueues
drop constraint document_ingestion_enqueues_queue_message_id_key;

create table public.document_ingestion_failures (
  id uuid primary key default gen_random_uuid(),
  source_queue_message_id bigint not null,
  failure_queue_message_id bigint not null,
  document_id uuid references public.documents (id) on delete set null,
  ingestion_version integer,
  idempotency_key text,
  attempt_count integer not null,
  error_code text not null,
  error_summary text not null,
  failed_at timestamptz not null default now(),
  constraint document_ingestion_failures_version_check
    check (ingestion_version is null or ingestion_version > 0),
  constraint document_ingestion_failures_attempt_count_check
    check (attempt_count >= 0),
  constraint document_ingestion_failures_idempotency_key_check
    check (idempotency_key is null or nullif(btrim(idempotency_key), '') is not null),
  constraint document_ingestion_failures_error_code_check
    check (nullif(btrim(error_code), '') is not null),
  constraint document_ingestion_failures_error_summary_check
    check (nullif(btrim(error_summary), '') is not null)
);

create unique index document_ingestion_failures_idempotency_key_idx
on public.document_ingestion_failures (idempotency_key)
where idempotency_key is not null;

alter table public.document_ingestion_failures enable row level security;

revoke all privileges on table public.document_ingestion_failures
from anon, authenticated;

grant select on table public.document_ingestion_failures
to service_role;

create or replace function public.enqueue_document_ingestion(target_document_id uuid)
returns table (
  queue_message_id bigint,
  idempotency_key text,
  created boolean
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_document public.documents%rowtype;
  stable_idempotency_key text;
  existing_queue_message_id bigint;
  sent_queue_message_id bigint;
begin
  select documents.*
    into target_document
    from public.documents as documents
    where documents.id = target_document_id
    for update;

  if target_document.id is null then
    raise exception using
      errcode = 'P0002',
      message = 'Document does not exist';
  end if;

  stable_idempotency_key :=
    target_document.id::text
    || ':'
    || target_document.ingestion_version::text
    || ':'
    || lower(target_document.sha256);

  if target_document.status not in ('uploaded', 'queued') then
    raise exception using
      errcode = '55000',
      message = 'Document is not eligible for enqueue';
  end if;

  select enqueues.queue_message_id
    into existing_queue_message_id
    from public.document_ingestion_enqueues as enqueues
    where enqueues.idempotency_key = stable_idempotency_key;

  if existing_queue_message_id is null then
    select send
      into sent_queue_message_id
      from pgmq.send(
        'document_ingestion',
        jsonb_build_object(
          'documentId', target_document.id,
          'ingestionVersion', target_document.ingestion_version,
          'contentSha256', lower(target_document.sha256),
          'idempotencyKey', stable_idempotency_key
        )
      );

    insert into public.document_ingestion_enqueues (
      idempotency_key,
      document_id,
      ingestion_version,
      content_sha256,
      queue_message_id
    )
    values (
      stable_idempotency_key,
      target_document.id,
      target_document.ingestion_version,
      lower(target_document.sha256),
      sent_queue_message_id
    );
  end if;

  update public.documents
  set
    status = 'queued',
    current_stage = 'queue_pending',
    active_ingestion_message_id =
      coalesce(existing_queue_message_id, sent_queue_message_id),
    active_ingestion_claim_id = null,
    error_code = null,
    error_summary = null,
    updated_at = now()
  where id = target_document.id;

  return query select
    coalesce(existing_queue_message_id, sent_queue_message_id),
    stable_idempotency_key,
    existing_queue_message_id is null;
end;
$$;

create function public.lease_document_ingestion(
  visibility_timeout_seconds integer
)
returns table (
  queue_message_id bigint,
  read_count integer,
  visible_at timestamptz,
  message_body jsonb
)
language plpgsql
security definer
set search_path = ''
as $$
begin
  if visibility_timeout_seconds <= 0 then
    raise exception using
      errcode = '22023',
      message = 'visibility timeout must be positive';
  end if;

  return query
  select
    leased.msg_id,
    leased.read_ct,
    leased.vt,
    leased.message
  from pgmq.read(
    'document_ingestion',
    visibility_timeout_seconds,
    1
  ) as leased;
end;
$$;

create function public.claim_document_ingestion(
  source_queue_message_id bigint,
  target_document_id uuid,
  target_ingestion_version integer,
  target_content_sha256 text,
  target_idempotency_key text,
  maximum_attempts integer
)
returns table (
  outcome text,
  attempt_count integer,
  claim_id uuid
)
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_document public.documents%rowtype;
  next_attempt_count integer;
  next_claim_id uuid;
begin
  if maximum_attempts <= 0 then
    raise exception using
      errcode = '22023',
      message = 'maximum attempts must be positive';
  end if;

  select documents.*
    into target_document
    from public.documents as documents
    where documents.id = target_document_id
    for update;

  if target_document.id is null
    or target_document.ingestion_version <> target_ingestion_version
    or lower(target_document.sha256) <> lower(target_content_sha256)
    or target_idempotency_key <> (
      target_document.id::text
      || ':'
      || target_document.ingestion_version::text
      || ':'
      || lower(target_document.sha256)
    )
    or target_document.active_ingestion_message_id
      is distinct from source_queue_message_id
    or target_document.status not in ('queued', 'processing')
  then
    perform pgmq.archive('document_ingestion', source_queue_message_id);
    return query
    select
      'skipped'::text,
      coalesce(target_document.attempt_count, 0),
      null::uuid;
    return;
  end if;

  next_claim_id := gen_random_uuid();
  if target_document.attempt_count >= maximum_attempts then
    update public.documents
    set
      status = 'processing',
      current_stage = 'attempts_exhausted',
      active_ingestion_claim_id = next_claim_id,
      updated_at = now()
    where id = target_document.id;

    return query
    select 'exhausted'::text, target_document.attempt_count, next_claim_id;
    return;
  end if;

  next_attempt_count := target_document.attempt_count + 1;
  update public.documents
  set
    status = 'processing',
    current_stage = 'placeholder_processing',
    attempt_count = next_attempt_count,
    active_ingestion_claim_id = next_claim_id,
    error_code = null,
    error_summary = null,
    updated_at = now()
  where id = target_document.id;

  return query select 'claimed'::text, next_attempt_count, next_claim_id;
end;
$$;

create function public.complete_document_ingestion(
  source_queue_message_id bigint,
  target_document_id uuid,
  target_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  completed boolean;
begin
  update public.documents
  set
    status = 'ready',
    current_stage = 'placeholder_completed',
    active_ingestion_message_id = null,
    active_ingestion_claim_id = null,
    error_code = null,
    error_summary = null,
    updated_at = now()
  where id = target_document_id
    and status = 'processing'
    and active_ingestion_message_id = source_queue_message_id
    and active_ingestion_claim_id = target_claim_id;

  completed := found;
  if completed then
    perform pgmq.archive('document_ingestion', source_queue_message_id);
  end if;
  return completed;
end;
$$;

create function public.retry_document_ingestion(
  source_queue_message_id bigint,
  target_document_id uuid,
  target_claim_id uuid,
  retry_delay_seconds integer,
  stable_error_code text,
  safe_error_summary text
)
returns timestamptz
language plpgsql
security definer
set search_path = ''
as $$
declare
  next_visible_at timestamptz;
begin
  if retry_delay_seconds < 0 then
    raise exception using
      errcode = '22023',
      message = 'retry delay cannot be negative';
  end if;

  update public.documents
  set
    status = 'queued',
    current_stage = 'retry_wait',
    active_ingestion_claim_id = null,
    error_code = stable_error_code,
    error_summary = safe_error_summary,
    updated_at = now()
  where id = target_document_id
    and status = 'processing'
    and active_ingestion_message_id = source_queue_message_id
    and active_ingestion_claim_id = target_claim_id;

  if not found then
    return null;
  end if;

  select leased.vt
    into next_visible_at
    from pgmq.set_vt(
      'document_ingestion',
      source_queue_message_id,
      retry_delay_seconds
    ) as leased;
  return next_visible_at;
end;
$$;

create function public.fail_document_ingestion(
  source_queue_message_id bigint,
  target_document_id uuid,
  target_claim_id uuid,
  target_ingestion_version integer,
  target_idempotency_key text,
  stable_error_code text,
  safe_error_summary text
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_document public.documents%rowtype;
  sent_failure_message_id bigint;
begin
  select documents.*
    into target_document
    from public.documents as documents
    where documents.id = target_document_id
      and documents.status = 'processing'
      and documents.active_ingestion_message_id = source_queue_message_id
      and documents.active_ingestion_claim_id = target_claim_id
    for update;

  if target_document.id is null then
    return null;
  end if;

  select failures.failure_queue_message_id
    into sent_failure_message_id
    from public.document_ingestion_failures as failures
    where failures.idempotency_key = target_idempotency_key;

  if sent_failure_message_id is null then
    select send
      into sent_failure_message_id
      from pgmq.send(
        'document_ingestion_failed',
        jsonb_build_object(
          'sourceQueueMessageId', source_queue_message_id,
          'documentId', target_document.id,
          'ingestionVersion', target_ingestion_version,
          'idempotencyKey', target_idempotency_key,
          'attemptCount', target_document.attempt_count,
          'errorCode', stable_error_code,
          'errorSummary', safe_error_summary,
          'failedAt', now()
        )
      );

    insert into public.document_ingestion_failures (
      source_queue_message_id,
      failure_queue_message_id,
      document_id,
      ingestion_version,
      idempotency_key,
      attempt_count,
      error_code,
      error_summary
    )
    values (
      source_queue_message_id,
      sent_failure_message_id,
      target_document.id,
      target_ingestion_version,
      target_idempotency_key,
      target_document.attempt_count,
      stable_error_code,
      safe_error_summary
    );
  end if;

  update public.documents
  set
    status = 'failed',
    current_stage = 'failed',
    active_ingestion_message_id = null,
    active_ingestion_claim_id = null,
    error_code = stable_error_code,
    error_summary = safe_error_summary,
    updated_at = now()
  where id = target_document.id;

  perform pgmq.archive('document_ingestion', source_queue_message_id);
  return sent_failure_message_id;
end;
$$;

create function public.archive_invalid_document_ingestion(
  source_queue_message_id bigint
)
returns bigint
language plpgsql
security definer
set search_path = ''
as $$
declare
  sent_failure_message_id bigint;
begin
  select send
    into sent_failure_message_id
    from pgmq.send(
      'document_ingestion_failed',
      jsonb_build_object(
        'sourceQueueMessageId', source_queue_message_id,
        'attemptCount', 0,
        'errorCode', 'INVALID_QUEUE_MESSAGE',
        'errorSummary', '队列消息格式无效，已归档。',
        'failedAt', now()
      )
    );

  insert into public.document_ingestion_failures (
    source_queue_message_id,
    failure_queue_message_id,
    attempt_count,
    error_code,
    error_summary
  )
  values (
    source_queue_message_id,
    sent_failure_message_id,
    0,
    'INVALID_QUEUE_MESSAGE',
    '队列消息格式无效，已归档。'
  );

  perform pgmq.archive('document_ingestion', source_queue_message_id);
  return sent_failure_message_id;
end;
$$;

revoke execute on function public.lease_document_ingestion(integer)
from public, anon, authenticated;
revoke execute on function public.claim_document_ingestion(bigint, uuid, integer, text, text, integer)
from public, anon, authenticated;
revoke execute on function public.complete_document_ingestion(bigint, uuid, uuid)
from public, anon, authenticated;
revoke execute on function public.retry_document_ingestion(bigint, uuid, uuid, integer, text, text)
from public, anon, authenticated;
revoke execute on function public.fail_document_ingestion(bigint, uuid, uuid, integer, text, text, text)
from public, anon, authenticated;
revoke execute on function public.archive_invalid_document_ingestion(bigint)
from public, anon, authenticated;

grant execute on function public.lease_document_ingestion(integer)
to service_role;
grant execute on function public.claim_document_ingestion(bigint, uuid, integer, text, text, integer)
to service_role;
grant execute on function public.complete_document_ingestion(bigint, uuid, uuid)
to service_role;
grant execute on function public.retry_document_ingestion(bigint, uuid, uuid, integer, text, text)
to service_role;
grant execute on function public.fail_document_ingestion(bigint, uuid, uuid, integer, text, text, text)
to service_role;
grant execute on function public.archive_invalid_document_ingestion(bigint)
to service_role;

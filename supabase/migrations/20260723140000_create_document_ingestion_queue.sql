create extension if not exists pgmq;

select pgmq.create('document_ingestion');

create table public.document_ingestion_enqueues (
  idempotency_key text primary key,
  document_id uuid not null references public.documents (id) on delete cascade,
  ingestion_version integer not null,
  content_sha256 text not null,
  queue_message_id bigint not null unique,
  created_at timestamptz not null default now(),
  unique (document_id, ingestion_version, content_sha256),
  constraint document_ingestion_enqueues_idempotency_key_check
    check (nullif(btrim(idempotency_key), '') is not null),
  constraint document_ingestion_enqueues_version_check
    check (ingestion_version > 0),
  constraint document_ingestion_enqueues_sha256_check
    check (content_sha256 ~ '^[0-9a-f]{64}$')
);

alter table public.document_ingestion_enqueues enable row level security;

revoke all privileges on table public.document_ingestion_enqueues
from anon, authenticated;

grant select on table public.document_ingestion_enqueues
to service_role;

create function public.enqueue_document_ingestion(target_document_id uuid)
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

revoke execute on function public.enqueue_document_ingestion(uuid)
from public, anon, authenticated;

grant execute on function public.enqueue_document_ingestion(uuid)
to service_role;

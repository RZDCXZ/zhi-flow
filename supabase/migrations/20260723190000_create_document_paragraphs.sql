create table public.document_paragraphs (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null references public.documents (id) on delete cascade,
  knowledge_base_id uuid not null references public.knowledge_bases (id) on delete cascade,
  document_version integer not null,
  paragraph_index integer not null,
  kind text not null,
  content text not null,
  page_number integer,
  heading_level integer,
  heading_path text[] not null default '{}',
  source_start integer not null,
  source_end integer not null,
  source_locator text not null,
  created_at timestamptz not null default now(),
  unique (document_id, document_version, paragraph_index),
  constraint document_paragraphs_document_version_check
    check (document_version > 0),
  constraint document_paragraphs_index_check
    check (paragraph_index >= 0),
  constraint document_paragraphs_kind_check
    check (kind in ('heading', 'paragraph')),
  constraint document_paragraphs_content_check
    check (nullif(btrim(content), '') is not null),
  constraint document_paragraphs_page_number_check
    check (page_number is null or page_number > 0),
  constraint document_paragraphs_heading_level_check
    check (
      (kind = 'heading' and heading_level between 1 and 6)
      or (kind = 'paragraph' and heading_level is null)
    ),
  constraint document_paragraphs_source_range_check
    check (source_start >= 0 and source_end > source_start),
  constraint document_paragraphs_source_locator_check
    check (nullif(btrim(source_locator), '') is not null),
  foreign key (document_id, knowledge_base_id)
    references public.documents (id, knowledge_base_id)
    on delete cascade
);

create index document_paragraphs_knowledge_base_idx
on public.document_paragraphs (knowledge_base_id);

alter table public.document_paragraphs enable row level security;

revoke all privileges on table public.document_paragraphs
from anon, authenticated;

grant select on table public.document_paragraphs
to service_role;

create function public.remove_failed_document_paragraphs()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  delete from public.document_paragraphs
  where document_id = new.id;
  return new;
end;
$$;

create trigger remove_failed_document_paragraphs
after update of status on public.documents
for each row
when (new.status = 'failed' and old.status is distinct from new.status)
execute function public.remove_failed_document_paragraphs();

create function public.begin_document_parsing(
  target_document_id uuid,
  target_claim_id uuid
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.documents
  set
    current_stage = 'parsing',
    updated_at = now()
  where id = target_document_id
    and status = 'processing'
    and active_ingestion_claim_id = target_claim_id;
  return found;
end;
$$;

create function public.replace_document_paragraphs(
  target_document_id uuid,
  target_document_version integer,
  target_claim_id uuid,
  parsed_page_count integer,
  parsed_paragraphs jsonb
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  target_document public.documents%rowtype;
  paragraph_count integer;
begin
  if jsonb_typeof(parsed_paragraphs) <> 'array'
    or jsonb_array_length(parsed_paragraphs) = 0 then
    raise exception using
      errcode = '22023',
      message = 'parsed paragraphs must be a non-empty array';
  end if;

  select documents.*
    into target_document
    from public.documents as documents
    where documents.id = target_document_id
      and documents.status = 'processing'
      and documents.ingestion_version = target_document_version
      and documents.active_ingestion_claim_id = target_claim_id
    for update;

  if target_document.id is null then
    return false;
  end if;

  delete from public.document_paragraphs
  where document_id = target_document_id
    and document_version = target_document_version;

  insert into public.document_paragraphs (
    document_id,
    knowledge_base_id,
    document_version,
    paragraph_index,
    kind,
    content,
    page_number,
    heading_level,
    heading_path,
    source_start,
    source_end,
    source_locator
  )
  select
    target_document.id,
    target_document.knowledge_base_id,
    target_document_version,
    paragraph.paragraph_index,
    paragraph.kind,
    paragraph.content,
    paragraph.page_number,
    paragraph.heading_level,
    coalesce(paragraph.heading_path, '{}'),
    paragraph.source_start,
    paragraph.source_end,
    paragraph.source_locator
  from jsonb_to_recordset(parsed_paragraphs) as paragraph (
    paragraph_index integer,
    kind text,
    content text,
    page_number integer,
    heading_level integer,
    heading_path text[],
    source_start integer,
    source_end integer,
    source_locator text
  );

  get diagnostics paragraph_count = row_count;
  if paragraph_count <> jsonb_array_length(parsed_paragraphs) then
    raise exception using
      errcode = '22023',
      message = 'parsed paragraph payload is incomplete';
  end if;

  update public.documents
  set
    page_count = parsed_page_count,
    current_stage = 'parsed',
    updated_at = now()
  where id = target_document.id;
  return true;
end;
$$;

create or replace function public.complete_document_ingestion(
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
    current_stage = case
      when current_stage = 'parsed' then 'parsing_completed'
      else 'placeholder_completed'
    end,
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

revoke execute on function public.begin_document_parsing(uuid, uuid)
from public, anon, authenticated;
revoke execute on function public.replace_document_paragraphs(uuid, integer, uuid, integer, jsonb)
from public, anon, authenticated;

grant execute on function public.begin_document_parsing(uuid, uuid)
to service_role;
grant execute on function public.replace_document_paragraphs(uuid, integer, uuid, integer, jsonb)
to service_role;

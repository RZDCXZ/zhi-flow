create extension if not exists vector with schema extensions;

create type public.document_status as enum (
  'uploaded',
  'queued',
  'processing',
  'ready',
  'failed',
  'archived'
);

create type public.conversation_mode as enum ('general', 'knowledge_base');
create type public.message_role as enum ('user', 'assistant');
create type public.message_status as enum (
  'streaming',
  'completed',
  'cancelled',
  'failed'
);

create table public.knowledge_bases (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint knowledge_bases_name_check check (nullif(btrim(name), '') is not null)
);

create table public.documents (
  id uuid primary key default gen_random_uuid(),
  knowledge_base_id uuid not null references public.knowledge_bases (id) on delete cascade,
  original_filename text not null,
  storage_object_key text not null unique,
  mime_type text not null,
  byte_size bigint not null,
  page_count integer,
  sha256 text not null,
  ingestion_version integer not null default 1,
  status public.document_status not null default 'uploaded',
  current_stage text not null default 'stored',
  attempt_count integer not null default 0,
  error_code text,
  error_summary text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, knowledge_base_id),
  constraint documents_filename_check check (nullif(btrim(original_filename), '') is not null),
  constraint documents_storage_key_check check (nullif(btrim(storage_object_key), '') is not null),
  constraint documents_mime_type_check check (nullif(btrim(mime_type), '') is not null),
  constraint documents_byte_size_check check (byte_size > 0),
  constraint documents_page_count_check check (page_count is null or page_count > 0),
  constraint documents_sha256_check check (sha256 ~ '^[0-9a-fA-F]{64}$'),
  constraint documents_ingestion_version_check check (ingestion_version > 0),
  constraint documents_stage_check check (nullif(btrim(current_stage), '') is not null),
  constraint documents_attempt_count_check check (attempt_count >= 0),
  constraint documents_error_code_check check (error_code is null or nullif(btrim(error_code), '') is not null),
  constraint documents_error_summary_check check (error_summary is null or nullif(btrim(error_summary), '') is not null)
);

create table public.document_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id uuid not null,
  knowledge_base_id uuid not null,
  document_version integer not null,
  chunking_version text not null,
  chunk_index integer not null,
  content text not null,
  estimated_token_count integer not null,
  page_start integer,
  page_end integer,
  heading_path text[] not null default '{}',
  source_locator text not null,
  embedding_model text not null,
  embedding extensions.vector(1024) not null,
  created_at timestamptz not null default now(),
  foreign key (document_id, knowledge_base_id)
    references public.documents (id, knowledge_base_id)
    on delete cascade,
  unique (id, document_id),
  unique (document_id, document_version, chunking_version, chunk_index),
  constraint document_chunks_document_version_check check (document_version > 0),
  constraint document_chunks_chunking_version_check check (nullif(btrim(chunking_version), '') is not null),
  constraint document_chunks_index_check check (chunk_index >= 0),
  constraint document_chunks_content_check check (nullif(btrim(content), '') is not null),
  constraint document_chunks_token_count_check check (estimated_token_count > 0),
  constraint document_chunks_page_start_check check (page_start is null or page_start > 0),
  constraint document_chunks_page_end_check check (page_end is null or page_end > 0),
  constraint document_chunks_page_range_check check (
    page_start is null or page_end is null or page_start <= page_end
  ),
  constraint document_chunks_source_locator_check check (nullif(btrim(source_locator), '') is not null),
  constraint document_chunks_embedding_model_check check (nullif(btrim(embedding_model), '') is not null)
);

create table public.conversations (
  id uuid primary key default gen_random_uuid(),
  title text not null,
  mode public.conversation_mode not null default 'general',
  knowledge_base_id uuid references public.knowledge_bases (id) on delete cascade,
  rolling_summary text,
  summary_through_message_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, knowledge_base_id),
  constraint conversations_title_check check (nullif(btrim(title), '') is not null),
  constraint conversations_mode_knowledge_base_check check (
    (mode = 'general' and knowledge_base_id is null)
    or (mode = 'knowledge_base' and knowledge_base_id is not null)
  )
);

create table public.messages (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  role public.message_role not null,
  content text not null default '',
  status public.message_status not null,
  client_idempotency_key text,
  source_message_id uuid,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, conversation_id),
  foreign key (source_message_id, conversation_id)
    references public.messages (id, conversation_id)
    on delete cascade,
  constraint messages_role_status_check check (
    (
      role = 'user'
      and status = 'completed'
      and source_message_id is null
      and nullif(btrim(client_idempotency_key), '') is not null
      and nullif(btrim(content), '') is not null
    )
    or (
      role = 'assistant'
      and source_message_id is not null
      and client_idempotency_key is null
      and (status <> 'completed' or nullif(btrim(content), '') is not null)
    )
  )
);

create function public.enforce_assistant_message_source()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  source_role public.message_role;
begin
  if new.role = 'assistant' then
    select role
      into source_role
      from public.messages
      where id = new.source_message_id
        and conversation_id = new.conversation_id;

    if source_role is distinct from 'user' then
      raise exception using
        errcode = '23514',
        message = 'assistant Message source must be a user Message';
    end if;
  end if;

  return new;
end;
$$;

create trigger messages_enforce_assistant_source
before insert or update of role, source_message_id, conversation_id
on public.messages
for each row execute function public.enforce_assistant_message_source();

create unique index messages_conversation_client_key_idx
on public.messages (conversation_id, client_idempotency_key)
where client_idempotency_key is not null;

alter table public.conversations
  add constraint conversations_summary_message_fkey
  foreign key (summary_through_message_id, id)
  references public.messages (id, conversation_id)
  on delete set null (summary_through_message_id);

create table public.rag_runs (
  id uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.conversations (id) on delete cascade,
  knowledge_base_id uuid not null references public.knowledge_bases (id) on delete cascade,
  user_message_id uuid not null,
  assistant_message_id uuid not null unique,
  standalone_question text,
  config_snapshot jsonb not null default '{}',
  candidates jsonb not null default '[]',
  final_context_chunk_ids uuid[] not null default '{}',
  stage_timings jsonb not null default '{}',
  token_usage jsonb not null default '{}',
  result jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  foreign key (user_message_id, conversation_id)
    references public.messages (id, conversation_id)
    on delete cascade,
  foreign key (assistant_message_id, conversation_id)
    references public.messages (id, conversation_id)
    on delete cascade,
  unique (id, assistant_message_id),
  constraint rag_runs_standalone_question_check check (
    standalone_question is null or nullif(btrim(standalone_question), '') is not null
  ),
  constraint rag_runs_config_snapshot_check check (jsonb_typeof(config_snapshot) = 'object'),
  constraint rag_runs_candidates_check check (jsonb_typeof(candidates) = 'array'),
  constraint rag_runs_stage_timings_check check (jsonb_typeof(stage_timings) = 'object'),
  constraint rag_runs_token_usage_check check (jsonb_typeof(token_usage) = 'object')
);

create function public.enforce_rag_run_associations()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  conversation_mode public.conversation_mode;
  conversation_knowledge_base_id uuid;
  actual_user_role public.message_role;
  actual_assistant_role public.message_role;
  assistant_source_message_id uuid;
begin
  select mode, knowledge_base_id
    into conversation_mode, conversation_knowledge_base_id
    from public.conversations
    where id = new.conversation_id;

  select role
    into actual_user_role
    from public.messages
    where id = new.user_message_id
      and conversation_id = new.conversation_id;

  select role, source_message_id
    into actual_assistant_role, assistant_source_message_id
    from public.messages
    where id = new.assistant_message_id
      and conversation_id = new.conversation_id;

  if conversation_mode is distinct from 'knowledge_base'
    or conversation_knowledge_base_id is distinct from new.knowledge_base_id
    or actual_user_role is distinct from 'user'
    or actual_assistant_role is distinct from 'assistant'
    or assistant_source_message_id is distinct from new.user_message_id
  then
    raise exception using
      errcode = '23514',
      message = 'RAG Run associations are inconsistent';
  end if;

  return new;
end;
$$;

create trigger rag_runs_enforce_associations
before insert or update of conversation_id, knowledge_base_id, user_message_id, assistant_message_id
on public.rag_runs
for each row execute function public.enforce_rag_run_associations();

create table public.citations (
  id uuid primary key default gen_random_uuid(),
  rag_run_id uuid not null,
  assistant_message_id uuid not null,
  chunk_id uuid not null,
  document_id uuid not null,
  display_order integer not null,
  document_name text not null,
  page_start integer,
  page_end integer,
  heading_path text[] not null default '{}',
  quote text not null,
  source_locator text not null,
  created_at timestamptz not null default now(),
  foreign key (rag_run_id, assistant_message_id)
    references public.rag_runs (id, assistant_message_id)
    on delete cascade,
  foreign key (chunk_id, document_id)
    references public.document_chunks (id, document_id)
    on delete cascade,
  unique (rag_run_id, display_order),
  constraint citations_display_order_check check (display_order > 0),
  constraint citations_document_name_check check (nullif(btrim(document_name), '') is not null),
  constraint citations_page_start_check check (page_start is null or page_start > 0),
  constraint citations_page_end_check check (page_end is null or page_end > 0),
  constraint citations_page_range_check check (
    page_start is null or page_end is null or page_start <= page_end
  ),
  constraint citations_quote_check check (nullif(btrim(quote), '') is not null),
  constraint citations_source_locator_check check (nullif(btrim(source_locator), '') is not null)
);

create function public.enforce_citation_integrity()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  chunk_content text;
  chunk_knowledge_base_id uuid;
  rag_run_knowledge_base_id uuid;
begin
  select content, knowledge_base_id
    into chunk_content, chunk_knowledge_base_id
    from public.document_chunks
    where id = new.chunk_id
      and document_id = new.document_id;

  select knowledge_base_id
    into rag_run_knowledge_base_id
    from public.rag_runs
    where id = new.rag_run_id
      and assistant_message_id = new.assistant_message_id;

  if chunk_knowledge_base_id is not null
    and rag_run_knowledge_base_id is not null
    and chunk_knowledge_base_id is distinct from rag_run_knowledge_base_id
  then
    raise exception using
      errcode = '23514',
      message = 'Citation Document Chunk must belong to the RAG Run Knowledge Base';
  end if;

  if chunk_content is not null and position(new.quote in chunk_content) = 0 then
    raise exception using
      errcode = '23514',
      message = 'Citation quote must occur in its Document Chunk';
  end if;

  return new;
end;
$$;

create trigger citations_enforce_integrity
before insert or update of rag_run_id, assistant_message_id, chunk_id, document_id, quote
on public.citations
for each row execute function public.enforce_citation_integrity();

create index documents_knowledge_base_status_idx
on public.documents (knowledge_base_id, status);

create index document_chunks_knowledge_base_idx
on public.document_chunks (knowledge_base_id);

create index conversations_updated_at_idx
on public.conversations (updated_at desc);

create index messages_conversation_created_at_idx
on public.messages (conversation_id, created_at);

create index rag_runs_user_message_idx
on public.rag_runs (user_message_id);

create index citations_assistant_message_idx
on public.citations (assistant_message_id);

insert into storage.buckets (
  id,
  name,
  public,
  file_size_limit,
  allowed_mime_types
)
values (
  'documents',
  'documents',
  false,
  20 * 1024 * 1024,
  array['application/pdf', 'text/markdown', 'text/plain']
)
on conflict (id) do update
set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

alter table public.knowledge_bases enable row level security;
alter table public.documents enable row level security;
alter table public.document_chunks enable row level security;
alter table public.conversations enable row level security;
alter table public.messages enable row level security;
alter table public.rag_runs enable row level security;
alter table public.citations enable row level security;

revoke all privileges on table
  public.knowledge_bases,
  public.documents,
  public.document_chunks,
  public.conversations,
  public.messages,
  public.rag_runs,
  public.citations
from anon, authenticated;

grant select, insert, update, delete on table
  public.knowledge_bases,
  public.documents,
  public.document_chunks,
  public.conversations,
  public.messages,
  public.rag_runs,
  public.citations
to service_role;

revoke execute on function
  public.enforce_assistant_message_source(),
  public.enforce_rag_run_associations(),
  public.enforce_citation_integrity()
from public, anon, authenticated;

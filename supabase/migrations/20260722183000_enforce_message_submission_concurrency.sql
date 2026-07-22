create unique index messages_one_streaming_assistant_per_conversation_idx
on public.messages (conversation_id)
where role = 'assistant' and status = 'streaming';

drop function public.create_message_attempt(uuid, text, text);

create function public.create_message_submission(
  target_conversation_id uuid,
  user_content text,
  idempotency_key text
)
returns table (
  outcome text,
  user_message_id uuid,
  assistant_message_id uuid,
  assistant_message_status public.message_status
)
language plpgsql
set search_path = ''
as $$
declare
  locked_conversation_id uuid;
  existing_user_message_id uuid;
  existing_user_content text;
  existing_assistant_message_id uuid;
  existing_assistant_message_status public.message_status;
  active_assistant_message_id uuid;
  created_user_message_id uuid;
  created_assistant_message_id uuid;
begin
  select conversations.id
    into locked_conversation_id
    from public.conversations as conversations
    where conversations.id = target_conversation_id
    for update;

  if locked_conversation_id is null then
    raise exception using
      errcode = '23503',
      message = 'Conversation does not exist';
  end if;

  select messages.id, messages.content
    into existing_user_message_id, existing_user_content
    from public.messages as messages
    where messages.conversation_id = target_conversation_id
      and messages.client_idempotency_key = idempotency_key;

  if existing_user_message_id is not null then
    select messages.id, messages.status
      into existing_assistant_message_id, existing_assistant_message_status
      from public.messages as messages
      where messages.conversation_id = target_conversation_id
        and messages.role = 'assistant'
        and messages.source_message_id = existing_user_message_id
      order by messages.created_at, messages.id
      limit 1;

    if existing_user_content is distinct from user_content then
      return query select
        'idempotency_key_reused'::text,
        existing_user_message_id,
        null::uuid,
        null::public.message_status;
      return;
    end if;

    return query select
      'idempotency_replay'::text,
      existing_user_message_id,
      existing_assistant_message_id,
      existing_assistant_message_status;
    return;
  end if;

  select messages.id
    into active_assistant_message_id
    from public.messages as messages
    where messages.conversation_id = target_conversation_id
      and messages.role = 'assistant'
      and messages.status = 'streaming'
    limit 1;

  if active_assistant_message_id is not null then
    return query select
      'generation_in_progress'::text,
      null::uuid,
      active_assistant_message_id,
      'streaming'::public.message_status;
    return;
  end if;

  insert into public.messages (
    conversation_id,
    role,
    content,
    status,
    client_idempotency_key
  )
  values (
    target_conversation_id,
    'user',
    user_content,
    'completed',
    idempotency_key
  )
  returning id into created_user_message_id;

  insert into public.messages (
    conversation_id,
    role,
    status,
    source_message_id
  )
  values (
    target_conversation_id,
    'assistant',
    'streaming',
    created_user_message_id
  )
  returning id into created_assistant_message_id;

  update public.conversations
  set updated_at = now()
  where id = target_conversation_id;

  return query select
    'created'::text,
    created_user_message_id,
    created_assistant_message_id,
    'streaming'::public.message_status;
end;
$$;

revoke execute on function public.create_message_submission(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.create_message_submission(uuid, text, text)
to service_role;

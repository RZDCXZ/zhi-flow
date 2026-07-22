create function public.create_message_attempt(
  target_conversation_id uuid,
  user_content text,
  idempotency_key text
)
returns table (
  user_message_id uuid,
  assistant_message_id uuid,
  duplicate boolean
)
language plpgsql
set search_path = ''
as $$
declare
  created_user_message_id uuid;
  created_assistant_message_id uuid;
begin
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
  on conflict (conversation_id, client_idempotency_key)
    where client_idempotency_key is not null
  do nothing
  returning id into created_user_message_id;

  if created_user_message_id is null then
    select id
      into created_user_message_id
      from public.messages
      where conversation_id = target_conversation_id
        and client_idempotency_key = idempotency_key;

    return query
      select created_user_message_id, null::uuid, true;
    return;
  end if;

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

  return query
    select created_user_message_id, created_assistant_message_id, false;
end;
$$;

revoke execute on function public.create_message_attempt(uuid, text, text)
from public, anon, authenticated;

grant execute on function public.create_message_attempt(uuid, text, text)
to service_role;

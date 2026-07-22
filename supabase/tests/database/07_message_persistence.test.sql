begin;

select plan(4);

insert into public.conversations (id, title, mode)
values (
  '70000000-0000-0000-0000-000000000030',
  'Message persistence integration',
  'general'
);

select is(
  (
    select duplicate
    from public.create_message_attempt(
      '70000000-0000-0000-0000-000000000030',
      '同一个客户端提交',
      'same-message-key'
    )
  ),
  false,
  'the first idempotency key creates a Message attempt'
);

select is(
  (
    select duplicate
    from public.create_message_attempt(
      '70000000-0000-0000-0000-000000000030',
      '同一个客户端提交',
      'same-message-key'
    )
  ),
  true,
  'the repeated idempotency key is reported as a duplicate'
);

select is(
  (
    select count(*)::integer
    from public.messages
    where conversation_id = '70000000-0000-0000-0000-000000000030'
      and role = 'user'
      and client_idempotency_key = 'same-message-key'
  ),
  1,
  'the same idempotency key persists exactly one user Message'
);

select is(
  (
    select count(*)::integer
    from public.messages
    where conversation_id = '70000000-0000-0000-0000-000000000030'
      and role = 'assistant'
  ),
  1,
  'an idempotency replay does not create a second assistant attempt'
);

select * from finish();
rollback;

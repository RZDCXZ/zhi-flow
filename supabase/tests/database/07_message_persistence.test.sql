begin;

select plan(10);

insert into public.conversations (id, title, mode)
values (
  '70000000-0000-0000-0000-000000000030',
  'Message persistence integration',
  'general'
);

select is(
  (
    select outcome
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '同一个客户端提交',
      'same-message-key'
    )
  ),
  'created',
  'the first idempotency key creates a Message submission'
);

select is(
  (
    select outcome
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '同一个客户端提交',
      'same-message-key'
    )
  ),
  'idempotency_replay',
  'the same content and idempotency key replay the existing submission'
);

select is(
  (
    select outcome
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '不同正文',
      'same-message-key'
    )
  ),
  'idempotency_key_reused',
  'different content cannot reuse an idempotency key'
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

select is(
  (
    select outcome
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '第二个并发提交',
      'second-message-key'
    )
  ),
  'generation_in_progress',
  'a distinct submission cannot start while an assistant Message is streaming'
);

select is(
  (
    select assistant_message_id
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '第二个并发提交',
      'second-message-key'
    )
  ),
  (
    select id
    from public.messages
    where conversation_id = '70000000-0000-0000-0000-000000000030'
      and role = 'assistant'
      and status = 'streaming'
  ),
  'the active-generation conflict identifies the streaming assistant Message'
);

select throws_ok(
  $$
    insert into public.messages (
      conversation_id,
      role,
      status,
      source_message_id
    )
    select
      conversation_id,
      'assistant',
      'streaming',
      id
    from public.messages
    where conversation_id = '70000000-0000-0000-0000-000000000030'
      and role = 'user'
      and client_idempotency_key = 'same-message-key'
  $$,
  '23505',
  null,
  'the database constraint rejects a second streaming assistant Message'
);

update public.messages
set status = 'completed', content = '完成正文'
where conversation_id = '70000000-0000-0000-0000-000000000030'
  and role = 'assistant'
  and status = 'streaming';

select is(
  (
    select assistant_message_status
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '同一个客户端提交',
      'same-message-key'
    )
  ),
  'completed'::public.message_status,
  'an idempotency replay returns the persisted assistant Message status'
);

select is(
  (
    select outcome
    from public.create_message_submission(
      '70000000-0000-0000-0000-000000000030',
      '终态后的新提交',
      'after-terminal-key'
    )
  ),
  'created',
  'a new submission can start after the active generation reaches a terminal state'
);

select * from finish();
rollback;

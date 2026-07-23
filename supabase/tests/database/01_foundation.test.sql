begin;

select plan(10);

select has_extension('vector', 'pgvector extension is enabled');
select has_extension('pgmq', 'PGMQ extension is enabled');
select has_table('public', 'knowledge_bases', 'Knowledge Base table exists');
select has_table('public', 'documents', 'Document table exists');
select has_table(
  'public',
  'document_ingestion_failures',
  'Document ingestion failure archive exists'
);
select has_table('public', 'document_chunks', 'Document Chunk table exists');
select has_table('public', 'conversations', 'Conversation table exists');
select has_table('public', 'messages', 'Message table exists');
select has_table('public', 'rag_runs', 'RAG Run table exists');
select has_table('public', 'citations', 'Citation table exists');

select * from finish();
rollback;

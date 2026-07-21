begin;

select plan(8);

select has_extension('vector', 'pgvector extension is enabled');
select has_table('public', 'knowledge_bases', 'Knowledge Base table exists');
select has_table('public', 'documents', 'Document table exists');
select has_table('public', 'document_chunks', 'Document Chunk table exists');
select has_table('public', 'conversations', 'Conversation table exists');
select has_table('public', 'messages', 'Message table exists');
select has_table('public', 'rag_runs', 'RAG Run table exists');
select has_table('public', 'citations', 'Citation table exists');

select * from finish();
rollback;

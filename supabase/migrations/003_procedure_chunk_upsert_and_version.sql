alter table public.procedure_chunks
  add constraint procedure_chunks_document_section_key unique (document_id, section);

drop function if exists public.match_procedure_chunks(vector, int);

create function public.match_procedure_chunks(query_embedding vector(384), match_count int default 4)
returns table (id uuid, document_id text, title text, section text, version text, content text, similarity float)
language sql stable as $$
  select p.id, p.document_id, p.title, p.section, p.version, p.content,
    1 - (p.embedding <=> query_embedding) as similarity
  from public.procedure_chunks p
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

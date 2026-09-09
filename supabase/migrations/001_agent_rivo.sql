create extension if not exists vector;

create type public.user_role as enum ('regional_manager');
create type public.visit_state as enum ('collecting', 'ready_for_review', 'validated', 'cancelled');
create type public.message_kind as enum ('text', 'audio', 'correction', 'procedural_question', 'validation');
create type public.processing_status as enum ('accepted', 'pending', 'completed', 'failed');

create table public.app_users (
  id text primary key,
  auth_user_id uuid unique references auth.users(id),
  display_name text not null,
  role public.user_role not null default 'regional_manager',
  whatsapp_sender_id text unique
);

create table public.stores (
  id text primary key,
  name text not null,
  city text not null,
  timezone text not null default 'Europe/Paris',
  local_contact_name text
);

create table public.user_store_memberships (
  user_id text not null references public.app_users(id) on delete cascade,
  store_id text not null references public.stores(id) on delete cascade,
  primary key (user_id, store_id)
);

create table public.visits (
  id text primary key,
  store_id text not null references public.stores(id),
  author_id text not null references public.app_users(id),
  state public.visit_state not null default 'collecting',
  started_at timestamptz not null default now(),
  validated_at timestamptz,
  validated_by text references public.app_users(id),
  latest_draft_version integer not null default 0
);

create unique index one_active_visit_per_user on public.visits(author_id)
where state in ('collecting', 'ready_for_review');

create table public.messages (
  id text primary key,
  provider_account_id text not null,
  provider_message_id text not null,
  visit_id text references public.visits(id),
  actor_id text not null references public.app_users(id),
  kind public.message_kind not null,
  text_content text,
  audio_storage_path text,
  transcript text,
  processing_status public.processing_status not null default 'accepted',
  processing_error text,
  received_at timestamptz not null default now(),
  unique (provider_account_id, provider_message_id)
);

create table public.report_drafts (
  id uuid primary key default gen_random_uuid(),
  visit_id text not null references public.visits(id) on delete cascade,
  version integer not null,
  title text not null,
  summary text not null,
  report_json jsonb not null,
  source_message_ids text[] not null default '{}',
  created_at timestamptz not null default now(),
  unique (visit_id, version)
);

create table public.validated_reports (
  id uuid primary key default gen_random_uuid(),
  visit_id text not null unique references public.visits(id),
  draft_id uuid not null references public.report_drafts(id),
  version integer not null,
  report_json jsonb not null,
  validated_by text not null references public.app_users(id),
  validated_at timestamptz not null default now(),
  validation_message_id text references public.messages(id)
);

create table public.procedure_chunks (
  id uuid primary key default gen_random_uuid(),
  document_id text not null,
  title text not null,
  section text not null,
  version text not null,
  content text not null,
  embedding vector(384) not null,
  metadata jsonb not null default '{}'
);

create index procedure_chunks_embedding_idx on public.procedure_chunks
using hnsw (embedding vector_cosine_ops);

create or replace function public.current_app_user_id()
returns text language sql stable security definer set search_path = public
as $$ select id from public.app_users where auth_user_id = auth.uid() $$;

alter table public.app_users enable row level security;
alter table public.stores enable row level security;
alter table public.user_store_memberships enable row level security;
alter table public.visits enable row level security;
alter table public.messages enable row level security;
alter table public.report_drafts enable row level security;
alter table public.validated_reports enable row level security;
alter table public.procedure_chunks enable row level security;

create policy app_users_self on public.app_users for select using (id = public.current_app_user_id());
create policy stores_in_scope on public.stores for select using (
  exists (select 1 from public.user_store_memberships m where m.store_id = stores.id and m.user_id = public.current_app_user_id())
);
create policy memberships_self on public.user_store_memberships for select using (user_id = public.current_app_user_id());
create policy visits_in_scope on public.visits for select using (
  author_id = public.current_app_user_id() or exists (
    select 1 from public.user_store_memberships m where m.store_id = visits.store_id and m.user_id = public.current_app_user_id()
  )
);
create policy messages_in_scope on public.messages for select using (exists (select 1 from public.visits v where v.id = messages.visit_id and (v.author_id = public.current_app_user_id() or exists (select 1 from public.user_store_memberships m where m.store_id = v.store_id and m.user_id = public.current_app_user_id()))));
create policy drafts_in_scope on public.report_drafts for select using (exists (select 1 from public.visits v where v.id = report_drafts.visit_id and v.author_id = public.current_app_user_id()));
create policy reports_in_scope on public.validated_reports for select using (exists (select 1 from public.visits v where v.id = validated_reports.visit_id and exists (select 1 from public.user_store_memberships m where m.store_id = v.store_id and m.user_id = public.current_app_user_id())));
create policy procedures_readable on public.procedure_chunks for select using (true);

create or replace function public.match_procedure_chunks(query_embedding vector(384), match_count int default 4)
returns table (id uuid, document_id text, title text, section text, content text, similarity float)
language sql stable as $$
  select p.id, p.document_id, p.title, p.section, p.content,
    1 - (p.embedding <=> query_embedding) as similarity
  from public.procedure_chunks p
  order by p.embedding <=> query_embedding
  limit match_count;
$$;

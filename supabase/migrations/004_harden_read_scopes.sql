-- Drafts and source evidence are private to their author until the report is validated.
-- This complements the API checks for direct Supabase access by authenticated users.
drop policy if exists visits_in_scope on public.visits;
create policy visits_in_scope on public.visits for select using (
  exists (
    select 1 from public.user_store_memberships m
    where m.store_id = visits.store_id and m.user_id = public.current_app_user_id()
  )
  and (visits.author_id = public.current_app_user_id() or visits.state = 'validated')
);

drop policy if exists messages_in_scope on public.messages;
create policy messages_in_scope on public.messages for select using (
  exists (
    select 1 from public.visits v
    where v.id = messages.visit_id
      and exists (
        select 1 from public.user_store_memberships m
        where m.store_id = v.store_id and m.user_id = public.current_app_user_id()
      )
      and (v.author_id = public.current_app_user_id() or v.state = 'validated')
  )
);

drop policy if exists procedures_readable on public.procedure_chunks;
create policy procedures_readable on public.procedure_chunks for select using (
  public.current_app_user_id() is not null
);

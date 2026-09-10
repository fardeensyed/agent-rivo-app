-- Finalise a visit and preserve the exact approved report in one database
-- transaction. The function is called only by the server-side Supabase client.
create or replace function public.finalize_visit_with_snapshot(
  p_visit_id text,
  p_version integer,
  p_validated_by text,
  p_validated_at timestamptz,
  p_validation_message_id text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_draft public.report_drafts%rowtype;
  v_existing public.validated_reports%rowtype;
begin
  select * into v_visit
  from public.visits
  where id = p_visit_id
  for update;

  if not found then
    raise exception 'VISIT_NOT_FOUND';
  end if;

  if v_visit.state = 'validated' then
    select * into v_existing
    from public.validated_reports
    where visit_id = p_visit_id;

    if found
      and v_existing.version = p_version
      and v_existing.validated_by = p_validated_by
      and v_existing.validation_message_id is not distinct from p_validation_message_id then
      return;
    end if;

    raise exception 'VISIT_FINAL';
  end if;

  if v_visit.state <> 'ready_for_review' then
    raise exception 'DRAFT_NOT_READY';
  end if;

  if v_visit.latest_draft_version <> p_version then
    raise exception 'STALE_DRAFT';
  end if;

  select * into v_draft
  from public.report_drafts
  where visit_id = p_visit_id
    and version = p_version;

  if not found then
    raise exception 'DRAFT_NOT_FOUND';
  end if;

  update public.visits
  set state = 'validated',
      validated_at = p_validated_at,
      validated_by = p_validated_by,
      latest_draft_version = p_version
  where id = p_visit_id;

  insert into public.validated_reports (
    visit_id,
    draft_id,
    version,
    report_json,
    validated_by,
    validated_at,
    validation_message_id
  ) values (
    p_visit_id,
    v_draft.id,
    v_draft.version,
    v_draft.report_json,
    p_validated_by,
    p_validated_at,
    p_validation_message_id
  );
end;
$$;

revoke all on function public.finalize_visit_with_snapshot(text, integer, text, timestamptz, text) from public;
revoke all on function public.finalize_visit_with_snapshot(text, integer, text, timestamptz, text) from anon;
revoke all on function public.finalize_visit_with_snapshot(text, integer, text, timestamptz, text) from authenticated;
grant execute on function public.finalize_visit_with_snapshot(text, integer, text, timestamptz, text) to service_role;

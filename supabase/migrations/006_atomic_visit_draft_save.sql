-- Keep a visit state change and its report draft in one transaction.
create or replace function public.save_visit_state_and_draft(
  p_visit_id text,
  p_state public.visit_state,
  p_validated_at timestamptz default null,
  p_validated_by text default null,
  p_latest_draft_version integer default 0,
  p_draft_version integer default null,
  p_title text default null,
  p_summary text default null,
  p_report_json jsonb default null,
  p_source_message_ids text[] default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_visit public.visits%rowtype;
  v_existing jsonb;
begin
  select * into v_visit
  from public.visits
  where id = p_visit_id
  for update;

  if not found then
    raise exception 'VISIT_NOT_FOUND';
  end if;

  if v_visit.state in ('validated', 'cancelled') and p_state <> v_visit.state then
    raise exception 'VISIT_FINAL';
  end if;

  if p_state = 'validated' then
    raise exception 'VALIDATION_MUST_USE_SNAPSHOT';
  end if;

  if p_report_json is not null then
    if p_draft_version is null or p_title is null or p_summary is null or p_source_message_ids is null then
      raise exception 'DRAFT_FIELDS_MISSING';
    end if;

    select report_json into v_existing
    from public.report_drafts
    where visit_id = p_visit_id
      and version = p_draft_version;

    if found then
      if v_existing <> p_report_json then
        raise exception 'DRAFT_VERSION_CONFLICT';
      end if;
    else
      insert into public.report_drafts (
        visit_id, version, title, summary, report_json, source_message_ids
      ) values (
        p_visit_id, p_draft_version, p_title, p_summary, p_report_json, p_source_message_ids
      );
    end if;
  end if;

  update public.visits
  set state = p_state,
      validated_at = p_validated_at,
      validated_by = p_validated_by,
      latest_draft_version = p_latest_draft_version
  where id = p_visit_id;
end;
$$;

revoke all on function public.save_visit_state_and_draft(text, public.visit_state, timestamptz, text, integer, integer, text, text, jsonb, text[]) from public;
revoke all on function public.save_visit_state_and_draft(text, public.visit_state, timestamptz, text, integer, integer, text, text, jsonb, text[]) from anon;
revoke all on function public.save_visit_state_and_draft(text, public.visit_state, timestamptz, text, integer, integer, text, text, jsonb, text[]) from authenticated;
grant execute on function public.save_visit_state_and_draft(text, public.visit_state, timestamptz, text, integer, integer, text, text, jsonb, text[]) to service_role;

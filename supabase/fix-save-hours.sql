create or replace function public.save_time_entry(
  p_project_id text,
  p_entry_date text,
  p_hours_text text,
  p_notes text default null
)
returns public.time_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  parsed_hours numeric;
  new_entry public.time_entries;
begin
  if auth.uid() is null then
    raise exception 'You must be logged in to save hours.';
  end if;

  parsed_hours := replace(trim(p_hours_text), ',', '.')::numeric;

  if parsed_hours <= 0 or parsed_hours > 24 then
    raise exception 'Hours must be more than 0 and no more than 24.';
  end if;

  insert into public.time_entries (employee_id, project_id, entry_date, hours, notes)
  values (auth.uid(), p_project_id::uuid, p_entry_date::date, parsed_hours, p_notes)
  returning * into new_entry;

  return new_entry;
exception
  when invalid_text_representation then
    raise exception 'Enter hours as a number, for example 8 or 7.5.';
end;
$$;

grant execute on function public.save_time_entry(text, text, text, text) to authenticated;

create or replace function public.save_grid_hours(
  p_project_id text,
  p_entry_date text,
  p_hours_text text,
  p_notes text default null,
  p_leave_type text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  parsed_hours numeric;
  clean_hours text;
  updated_count integer;
begin
  if auth.uid() is null then
    raise exception 'You must be logged in to save hours.';
  end if;

  clean_hours := trim(coalesce(p_hours_text, ''));

  if clean_hours = '' then
    delete from public.time_entries
    where employee_id = auth.uid()
      and (
        (p_leave_type is null and project_id = p_project_id::uuid)
        or (p_leave_type is not null and leave_type = p_leave_type)
      )
      and entry_date = p_entry_date::date;

    return jsonb_build_object('status', 'deleted');
  end if;

  parsed_hours := replace(clean_hours, ',', '.')::numeric;

  if parsed_hours <= 0 or parsed_hours > 24 then
    raise exception 'Hours must be more than 0 and no more than 24.';
  end if;

  update public.time_entries
  set hours = parsed_hours,
      notes = p_notes
  where employee_id = auth.uid()
    and (
      (p_leave_type is null and project_id = p_project_id::uuid)
      or (p_leave_type is not null and leave_type = p_leave_type)
    )
    and entry_date = p_entry_date::date;

  get diagnostics updated_count = row_count;

  if updated_count = 0 then
    insert into public.time_entries (employee_id, project_id, leave_type, entry_date, hours, notes)
    values (
      auth.uid(),
      case when p_leave_type is null then p_project_id::uuid else null end,
      p_leave_type,
      p_entry_date::date,
      parsed_hours,
      p_notes
    );
  end if;

  return jsonb_build_object('status', 'saved');
exception
  when invalid_text_representation then
    raise exception 'Enter hours as a number, for example 8 or 7.5.';
end;
$$;

grant execute on function public.save_grid_hours(text, text, text, text, text) to authenticated;

notify pgrst, 'reload schema';

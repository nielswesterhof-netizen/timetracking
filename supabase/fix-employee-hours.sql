alter table public.profiles
add column if not exists working_hours_per_week numeric(5, 2) not null default 40;

alter table public.profiles
add column if not exists hourly_rate_eur numeric(10, 2) not null default 0;

create or replace function public.save_employee_settings(
  p_employee_id uuid,
  p_role text,
  p_working_hours_text text,
  p_hourly_rate_text text
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  updated_profile public.profiles;
  parsed_working_hours numeric;
  parsed_hourly_rate numeric;
begin
  if not public.is_manager() then
    raise exception 'Only managers can update employee settings.';
  end if;

  if p_role not in ('employee', 'manager') then
    raise exception 'Role must be employee or manager.';
  end if;

  parsed_working_hours := replace(trim(coalesce(p_working_hours_text, '0')), ',', '.')::numeric;
  parsed_hourly_rate := replace(trim(coalesce(p_hourly_rate_text, '0')), ',', '.')::numeric;

  if parsed_working_hours < 0 or parsed_working_hours > 80 then
    raise exception 'Working hours per week must be between 0 and 80.';
  end if;

  if parsed_hourly_rate < 0 then
    raise exception 'Hourly rate cannot be negative.';
  end if;

  update public.profiles
  set role = p_role,
      working_hours_per_week = parsed_working_hours,
      hourly_rate_eur = parsed_hourly_rate
  where id = p_employee_id
  returning * into updated_profile;

  return updated_profile;
exception
  when invalid_text_representation then
    raise exception 'Enter working hours and hourly rate as numbers, for example 40 and 75.50.';
end;
$$;

grant execute on function public.save_employee_settings(uuid, text, text, text) to authenticated;

notify pgrst, 'reload schema';

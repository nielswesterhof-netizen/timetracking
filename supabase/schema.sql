create extension if not exists "uuid-ossp";

create table if not exists public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  full_name text,
  email text not null,
  role text not null default 'employee' check (role in ('employee', 'manager')),
  working_hours_per_week numeric(5, 2) not null default 40,
  hourly_rate_eur numeric(10, 2) not null default 0,
  created_at timestamp with time zone not null default now()
);

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

create or replace function public.ensure_my_profile(
  p_full_name text default '',
  p_email text default ''
)
returns public.profiles
language plpgsql
security definer
set search_path = public
as $$
declare
  existing_profile public.profiles;
begin
  if auth.uid() is null then
    raise exception 'You must be logged in.';
  end if;

  insert into public.profiles (id, full_name, email)
  values (
    auth.uid(),
    nullif(p_full_name, ''),
    coalesce(nullif(p_email, ''), auth.jwt()->>'email', '')
  )
  on conflict (id) do nothing;

  select * into existing_profile
  from public.profiles
  where id = auth.uid();

  return existing_profile;
end;
$$;

grant execute on function public.ensure_my_profile(text, text) to authenticated;

create table if not exists public.projects (
  id uuid primary key default uuid_generate_v4(),
  name text not null unique,
  project_code text,
  activate_hours boolean not null default true,
  is_active boolean not null default true,
  created_at timestamp with time zone not null default now()
);

alter table public.projects
add column if not exists project_code text;

alter table public.projects
add column if not exists activate_hours boolean not null default true;

create table if not exists public.time_entries (
  id uuid primary key default uuid_generate_v4(),
  employee_id uuid not null references public.profiles(id) on delete cascade,
  project_id uuid references public.projects(id) on delete restrict,
  leave_type text check (leave_type in ('sick', 'holiday')),
  entry_date date not null,
  hours numeric(5, 2) not null check (hours > 0 and hours <= 24),
  notes text,
  created_at timestamp with time zone not null default now()
);

alter table public.time_entries
alter column project_id drop not null;

alter table public.time_entries
add column if not exists leave_type text check (leave_type in ('sick', 'holiday'));

alter table public.time_entries
drop constraint if exists time_entries_project_or_leave_check;

alter table public.time_entries
add constraint time_entries_project_or_leave_check
check (
  (project_id is not null and leave_type is null)
  or (project_id is null and leave_type is not null)
);

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.profiles (id, full_name, email)
  values (new.id, new.raw_user_meta_data->>'full_name', new.email);
  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;

create trigger on_auth_user_created
after insert on auth.users
for each row execute procedure public.handle_new_user();

alter table public.profiles enable row level security;
alter table public.projects enable row level security;
alter table public.time_entries enable row level security;

drop policy if exists "Users can read their own profile" on public.profiles;
drop policy if exists "Managers can update profiles" on public.profiles;
drop policy if exists "Everyone can read active projects" on public.projects;
drop policy if exists "Managers can manage projects" on public.projects;
drop policy if exists "Employees can read own time entries" on public.time_entries;
drop policy if exists "Employees can create own time entries" on public.time_entries;
drop policy if exists "Employees can update own time entries" on public.time_entries;
drop policy if exists "Employees can delete own time entries" on public.time_entries;

create or replace function public.is_manager()
returns boolean
language sql
security definer
as $$
  select exists (
    select 1
    from public.profiles
    where id = auth.uid()
    and role = 'manager'
  );
$$;

create policy "Users can read their own profile"
on public.profiles for select
to authenticated
using (id = auth.uid() or public.is_manager());

create policy "Managers can update profiles"
on public.profiles for update
to authenticated
using (public.is_manager())
with check (public.is_manager());

create policy "Everyone can read active projects"
on public.projects for select
to authenticated
using (is_active = true or public.is_manager());

create policy "Managers can manage projects"
on public.projects for all
to authenticated
using (public.is_manager())
with check (public.is_manager());

create policy "Employees can read own time entries"
on public.time_entries for select
to authenticated
using (employee_id = auth.uid() or public.is_manager());

create policy "Employees can create own time entries"
on public.time_entries for insert
to authenticated
with check (employee_id = auth.uid());

create policy "Employees can update own time entries"
on public.time_entries for update
to authenticated
using (employee_id = auth.uid())
with check (employee_id = auth.uid());

create policy "Employees can delete own time entries"
on public.time_entries for delete
to authenticated
using (employee_id = auth.uid());

create or replace function public.add_time_entry(
  p_project_id uuid,
  p_entry_date date,
  p_hours numeric,
  p_notes text default null
)
returns public.time_entries
language plpgsql
security definer
set search_path = public
as $$
declare
  new_entry public.time_entries;
begin
  if auth.uid() is null then
    raise exception 'You must be logged in to save hours.';
  end if;

  insert into public.time_entries (employee_id, project_id, entry_date, hours, notes)
  values (auth.uid(), p_project_id, p_entry_date, p_hours, p_notes)
  returning * into new_entry;

  return new_entry;
end;
$$;

grant execute on function public.add_time_entry(uuid, date, numeric, text) to authenticated;

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

insert into public.projects (name)
values ('Internal work'), ('Client project'), ('Administration')
on conflict do nothing;

notify pgrst, 'reload schema';

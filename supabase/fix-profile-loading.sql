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

notify pgrst, 'reload schema';

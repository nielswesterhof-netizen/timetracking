alter table public.projects
add column if not exists project_code text;

alter table public.projects
add column if not exists activate_hours boolean not null default true;

notify pgrst, 'reload schema';

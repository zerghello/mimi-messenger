-- MiMi Messenger v5.6: profiles + avatars
alter table public.profiles
  add column if not exists avatar_path text;

insert into storage.buckets (id, name, public)
values ('profile-avatars', 'profile-avatars', false)
on conflict (id) do update set public = false;

drop policy if exists "profile avatars upload own folder" on storage.objects;
create policy "profile avatars upload own folder"
on storage.objects for insert to authenticated
with check (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

drop policy if exists "profile avatars read referenced" on storage.objects;
create policy "profile avatars read referenced"
on storage.objects for select to authenticated
using (
  bucket_id = 'profile-avatars'
  and exists (
    select 1 from public.profiles p
    where p.avatar_path = name
  )
);

drop policy if exists "profile avatars delete own folder" on storage.objects;
create policy "profile avatars delete own folder"
on storage.objects for delete to authenticated
using (
  bucket_id = 'profile-avatars'
  and (storage.foldername(name))[1] = auth.uid()::text
);

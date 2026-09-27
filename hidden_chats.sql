-- MiMi Messenger v5.9.0
-- "Удалить чат у себя": сообщения не удаляются.

create table if not exists public.hidden_chats (
  user_id uuid not null references public.profiles(id) on delete cascade,
  other_user_id uuid not null references public.profiles(id) on delete cascade,
  hidden_at timestamptz not null default now(),
  primary key (user_id, other_user_id),
  check (user_id <> other_user_id)
);

create index if not exists hidden_chats_user_idx
on public.hidden_chats(user_id, hidden_at desc);

alter table public.hidden_chats enable row level security;

drop policy if exists "users can read own hidden chats" on public.hidden_chats;
create policy "users can read own hidden chats"
on public.hidden_chats
for select
to authenticated
using (user_id = auth.uid());

drop policy if exists "users can hide chats for themselves" on public.hidden_chats;
create policy "users can hide chats for themselves"
on public.hidden_chats
for insert
to authenticated
with check (user_id = auth.uid());

drop policy if exists "users can update own hidden chats" on public.hidden_chats;
create policy "users can update own hidden chats"
on public.hidden_chats
for update
to authenticated
using (user_id = auth.uid())
with check (user_id = auth.uid());

drop policy if exists "users can unhide own chats" on public.hidden_chats;
create policy "users can unhide own chats"
on public.hidden_chats
for delete
to authenticated
using (user_id = auth.uid());

-- MiMi Messenger E2EE v5.3
-- Device-based E2EE: multiple browser/device keys per account.

alter table public.messages
  add column if not exists sender_device_id uuid;

create table if not exists public.e2ee_devices (
  id uuid primary key,
  user_id uuid not null references public.profiles(id) on delete cascade,
  public_key text not null,
  created_at timestamptz not null default now(),
  revoked_at timestamptz
);

create index if not exists e2ee_devices_user_idx on public.e2ee_devices(user_id, revoked_at);

alter table public.e2ee_devices enable row level security;

drop policy if exists "e2ee devices readable by authenticated users" on public.e2ee_devices;
create policy "e2ee devices readable by authenticated users"
on public.e2ee_devices for select to authenticated using (true);

drop policy if exists "users can register own e2ee devices" on public.e2ee_devices;
create policy "users can register own e2ee devices"
on public.e2ee_devices for insert to authenticated with check (user_id = auth.uid());

drop policy if exists "users can revoke own e2ee devices" on public.e2ee_devices;
create policy "users can revoke own e2ee devices"
on public.e2ee_devices for update to authenticated using (user_id = auth.uid()) with check (user_id = auth.uid());

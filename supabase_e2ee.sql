-- MiMi Messenger E2EE v5
-- Run once in Supabase SQL Editor.

alter table public.profiles
  add column if not exists e2ee_public_key text;

alter table public.messages
  add column if not exists image_iv text;

alter table public.messages
  add column if not exists image_mime text;

-- Existing RLS policies already allow authenticated users to read profiles
-- and each user to update their own profile, so no new policy is required.

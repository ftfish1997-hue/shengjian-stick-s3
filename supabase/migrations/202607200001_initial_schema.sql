create extension if not exists pgcrypto;

create table public.devices (
  id text primary key,
  token_hash text not null,
  enabled boolean not null default true,
  firmware_version text,
  last_seen_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.records (
  id uuid primary key default gen_random_uuid(),
  event_id uuid not null unique,
  device_id text not null references public.devices(id),
  kind text not null check (kind in ('voice_record', 'pomodoro_note', 'pomodoro_event')),
  device_session_id text,
  captured_at timestamptz,
  received_at timestamptz not null default now(),
  audio_path text not null,
  audio_deleted_at timestamptz,
  raw_text text,
  clean_text text,
  record_type text check (
    record_type is null or
    record_type in ('idea', 'activity', 'task', 'note', 'journal', 'pomodoro', 'inbox')
  ),
  title text,
  summary text,
  project text,
  tags text[] not null default '{}',
  duration_minutes integer check (duration_minutes is null or duration_minutes >= 0),
  completed boolean,
  follow_ups jsonb not null default '[]'::jsonb,
  confidence numeric check (confidence is null or confidence between 0 and 1),
  structured_result jsonb,
  prompt_version text,
  status text not null default 'uploaded' check (
    status in (
      'uploaded',
      'transcribing',
      'classifying',
      'processed',
      'notion_sync_pending',
      'synced',
      'transcription_failed',
      'classification_failed',
      'notion_sync_failed'
    )
  ),
  notion_page_id text,
  notion_manual_edited boolean not null default false,
  error_code text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index records_device_captured_idx on public.records (device_id, captured_at desc);
create index records_status_idx on public.records (status, received_at);
create index records_type_idx on public.records (record_type, captured_at desc);

create table public.pomodoro_sessions (
  id uuid primary key default gen_random_uuid(),
  device_session_id text not null unique,
  device_id text not null references public.devices(id),
  started_at timestamptz not null,
  ended_at timestamptz,
  planned_minutes integer not null default 25 check (planned_minutes > 0),
  actual_seconds integer generated always as (
    case
      when ended_at is null then null
      else greatest(0, floor(extract(epoch from (ended_at - started_at)))::integer)
    end
  ) stored,
  status text not null check (status in ('running', 'paused', 'completed', 'interrupted')),
  interruption_reason text,
  task_text text,
  project text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index pomodoro_device_started_idx
  on public.pomodoro_sessions (device_id, started_at desc);

create table public.daily_reviews (
  id uuid primary key default gen_random_uuid(),
  review_date date not null unique,
  timezone text not null default 'Asia/Shanghai',
  completed_items jsonb not null default '[]'::jsonb,
  pomodoro_count integer not null default 0,
  focus_minutes integer not null default 0,
  idea_count integer not null default 0,
  inbox_count integer not null default 0,
  source_record_ids uuid[] not null default '{}',
  facts jsonb not null default '{}'::jsonb,
  narrative text,
  prompt_version text,
  status text not null default 'pending' check (status in ('pending', 'generated', 'synced', 'failed')),
  notion_page_id text,
  notion_manual_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.weekly_reviews (
  id uuid primary key default gen_random_uuid(),
  week_start date not null unique,
  week_end date not null,
  timezone text not null default 'Asia/Shanghai',
  major_outcomes jsonb not null default '[]'::jsonb,
  project_investment jsonb not null default '{}'::jsonb,
  unfinished_items jsonb not null default '[]'::jsonb,
  next_focus jsonb not null default '[]'::jsonb,
  pomodoro_count integer not null default 0,
  focus_minutes integer not null default 0,
  source_daily_review_ids uuid[] not null default '{}',
  facts jsonb not null default '{}'::jsonb,
  narrative text,
  prompt_version text,
  status text not null default 'pending' check (status in ('pending', 'generated', 'synced', 'failed')),
  notion_page_id text,
  notion_manual_edited boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (week_end >= week_start)
);

create or replace function public.set_updated_at()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

create trigger devices_set_updated_at
before update on public.devices
for each row execute function public.set_updated_at();

create trigger records_set_updated_at
before update on public.records
for each row execute function public.set_updated_at();

create trigger pomodoro_sessions_set_updated_at
before update on public.pomodoro_sessions
for each row execute function public.set_updated_at();

create trigger daily_reviews_set_updated_at
before update on public.daily_reviews
for each row execute function public.set_updated_at();

create trigger weekly_reviews_set_updated_at
before update on public.weekly_reviews
for each row execute function public.set_updated_at();

alter table public.devices enable row level security;
alter table public.records enable row level security;
alter table public.pomodoro_sessions enable row level security;
alter table public.daily_reviews enable row level security;
alter table public.weekly_reviews enable row level security;

-- No public policies are created. Edge Functions use the service role and perform
-- device authentication before reading or writing these tables.

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('voice-recordings', 'voice-recordings', false, 10485760, array['audio/wav'])
on conflict (id) do update set
  public = excluded.public,
  file_size_limit = excluded.file_size_limit,
  allowed_mime_types = excluded.allowed_mime_types;

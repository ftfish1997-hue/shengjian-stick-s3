alter table public.records
  add column processing_attempts integer not null default 0,
  add column last_processing_started_at timestamptz;

alter table public.records
  add constraint records_processing_attempts_check
    check (processing_attempts >= 0);

update public.records
set processing_attempts = 1
where status in (
  'transcribing',
  'classifying',
  'transcription_failed',
  'classification_failed'
);

create index records_processing_retry_idx
  on public.records (status, updated_at)
  where status in (
    'uploaded',
    'transcribing',
    'classifying',
    'transcription_failed',
    'classification_failed'
  );

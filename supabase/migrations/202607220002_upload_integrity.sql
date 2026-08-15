alter table public.records
  add column audio_sha256 text,
  add column audio_size_bytes bigint;

alter table public.records
  add constraint records_audio_sha256_format_check
    check (audio_sha256 is null or audio_sha256 ~ '^[0-9a-f]{64}$'),
  add constraint records_audio_size_bytes_check
    check (audio_size_bytes is null or audio_size_bytes > 0);

create index records_audio_sha256_idx
  on public.records (audio_sha256)
  where audio_sha256 is not null;

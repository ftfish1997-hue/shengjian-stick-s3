-- Local-only token hash placeholder. Replace with a real one-way hash in the
-- upload-record implementation; never store plaintext device tokens.
insert into public.devices (id, token_hash, firmware_version)
values ('demo-device-001', 'LOCAL_SIMULATOR_ONLY', 'simulator-0.1.0')
on conflict (id) do nothing;

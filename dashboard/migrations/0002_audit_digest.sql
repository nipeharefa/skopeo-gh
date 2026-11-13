-- Migration 0002: simpan digest untuk audit hapus version.
ALTER TABLE audit_log ADD COLUMN digest TEXT;

-- Migration 0001: audit log untuk tindakan hapus di dashboard.
-- R2 tetap source of truth; tabel ini hanya catatan audit.
CREATE TABLE IF NOT EXISTS audit_log (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	action TEXT NOT NULL,
	repo TEXT NOT NULL,
	tag TEXT,
	created_at INTEGER NOT NULL
);
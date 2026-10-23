export type AuditAction = "delete_tag" | "delete_version" | "delete_repo";

export interface AuditEntry {
	id: number;
	action: AuditAction;
	repo: string;
	tag: string | null;
	digest: string | null;
	created_at: number;
}

export async function logAudit(
	db: D1Database,
	action: AuditAction,
	repo: string,
	tag: string | null,
	digest: string | null = null,
) {
	await db
		.prepare(
			"INSERT INTO audit_log (action, repo, tag, digest, created_at) VALUES (?, ?, ?, ?, ?)",
		)
		.bind(action, repo, tag, digest, Date.now())
		.run();
}

export async function recentAudit(db: D1Database, limit = 20): Promise<AuditEntry[]> {
	const { results } = await db
		.prepare(
			"SELECT id, action, repo, tag, digest, created_at FROM audit_log ORDER BY id DESC LIMIT ?",
		)
		.bind(limit)
		.all<AuditEntry>();
	return results;
}

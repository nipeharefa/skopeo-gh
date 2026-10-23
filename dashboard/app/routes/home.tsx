import { useMemo, useState } from "react";
import { Link, useNavigation } from "react-router";
import type { Route } from "./+types/home";
import { deleteRepo, listRepos } from "../lib/oci";
import { logAudit, recentAudit, type AuditAction } from "../lib/audit";
import { formatBytes, formatDate, shortDigest } from "../lib/format";

type ActionResult =
	| { ok: false; error: string }
	| { ok: true; repo: string; deleted: number };

const actionLabels: Record<AuditAction, string> = {
	delete_tag: "Hapus tag",
	delete_version: "Hapus version",
	delete_repo: "Hapus repo",
};

export function meta({}: Route.MetaArgs) {
	return [
		{ title: "OCI Registry Dashboard" },
		{ name: "description", content: "Kelola image container di Cloudflare R2" },
	];
}

export async function loader({ context }: Route.LoaderArgs) {
	const { env } = context.cloudflare;
	const [repos, audit] = await Promise.all([
		listRepos(env.OCI_BUCKET),
		recentAudit(env.DB, 20),
	]);
	return { repos, audit };
}

export async function action({
	request,
	context,
}: Route.ActionArgs): Promise<ActionResult> {
	const { env } = context.cloudflare;
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "delete_repo") {
		const repo = String(formData.get("repo") ?? "");
		const confirm = String(formData.get("confirm") ?? "");
		if (!repo || confirm.trim() !== repo) {
			return { ok: false, error: "Nama repo tidak cocok, hapus dibatalkan." };
		}
		const deleted = await deleteRepo(env.OCI_BUCKET, repo);
		await logAudit(env.DB, "delete_repo", repo, null);
		return { ok: true, repo, deleted };
	}

	return { ok: false, error: "Intent tidak dikenal." };
}

export default function Home({ loaderData, actionData }: Route.ComponentProps) {
	const navigation = useNavigation();
	const { repos, audit } = loaderData;
	const busy = navigation.state === "submitting";
	const [query, setQuery] = useState("");

	const visibleRepos = useMemo(() => {
		const needle = query.trim().toLowerCase();
		if (!needle) return repos;
		return repos.filter((repo) => repo.name.toLowerCase().includes(needle));
	}, [repos, query]);

	return (
		<div className="min-h-screen bg-[#f8f9fa] text-gray-900">
			<header className="border-b border-gray-200 bg-white">
				<div className="mx-auto flex max-w-6xl items-center gap-2 px-4 py-3">
					<span className="flex h-5 w-5 items-center justify-center rounded bg-blue-600 text-[10px] font-bold text-white">
						OC
					</span>
					<Link
						to="/"
						className="text-sm font-medium text-gray-900 hover:text-blue-600"
					>
						OCI Registry
					</Link>
				</div>
			</header>

			<main className="mx-auto max-w-6xl px-4 py-6">
				<nav className="text-sm text-gray-500" aria-label="Breadcrumb">
					<span className="text-gray-700">Repositories</span>
				</nav>

				<div className="mt-2 flex flex-wrap items-end justify-between gap-3">
					<div>
						<h1 className="text-2xl font-semibold tracking-tight text-gray-900">
							Repositories
						</h1>
						<p className="mt-1 text-sm text-gray-500">
							{repos.length} image · source of truth: R2 bucket{" "}
							<code className="font-mono text-gray-600">OCI_BUCKET</code>
						</p>
					</div>
				</div>

				{actionData && !actionData.ok && (
					<p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
						{actionData.error}
					</p>
				)}
				{actionData?.ok && (
					<p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
						{actionData.deleted} objek dihapus dari repo{" "}
						<code className="font-mono">{actionData.repo}</code>.
					</p>
				)}

				<div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="relative w-full sm:max-w-sm">
						<SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Filter image…"
							aria-label="Filter image"
							className="w-full rounded border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
						/>
					</div>
					<p className="text-xs text-gray-500">
						{visibleRepos.length} dari {repos.length} image
					</p>
				</div>

				{repos.length === 0 ? (
					<div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-500">
						Belum ada image di bucket.
					</div>
				) : visibleRepos.length === 0 ? (
					<div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-500">
						Tidak ada image yang cocok dengan filter.
					</div>
				) : (
					<div className="mt-3 overflow-hidden rounded-lg border border-gray-200 bg-white">
						<table className="w-full text-left text-sm">
							<thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
								<tr>
									<th className="px-4 py-3">Image</th>
									<th className="px-4 py-3">Tags</th>
									<th className="px-4 py-3">Ukuran blobs</th>
									<th className="px-4 py-3 text-right">Actions</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-100">
								{visibleRepos.map((repo) => (
									<tr key={repo.name} className="align-top hover:bg-gray-50">
										<td className="px-4 py-3">
											<Link
												to={`/repo/${repo.name}`}
												className="font-mono font-medium text-blue-600 hover:underline"
											>
												{repo.name}
											</Link>
										</td>
										<td className="px-4 py-3 text-gray-600">{repo.tagCount}</td>
										<td className="whitespace-nowrap px-4 py-3 text-gray-600">
											{formatBytes(repo.sizeBytes)}
										</td>
										<td className="px-4 py-3 text-right">
											<DeleteRepoForm repo={repo.name} busy={busy} />
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				<section className="mt-10">
					<h2 className="text-lg font-medium text-gray-900">Audit log (hapus)</h2>
					{audit.length === 0 ? (
						<div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white px-6 py-10 text-center text-sm text-gray-500">
							Belum ada aktivitas hapus.
						</div>
					) : (
						<div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
							<table className="w-full min-w-[640px] text-left text-sm">
								<thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
									<tr>
										<th className="px-4 py-3">Waktu</th>
										<th className="px-4 py-3">Aksi</th>
										<th className="px-4 py-3">Image</th>
										<th className="px-4 py-3">Reference</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-100">
									{audit.map((entry) => (
										<tr key={entry.id} className="hover:bg-gray-50">
											<td className="whitespace-nowrap px-4 py-2.5 text-gray-500">
												{formatDate(entry.created_at)}
											</td>
											<td className="whitespace-nowrap px-4 py-2.5">
												<span
													className={
														entry.action === "delete_repo"
															? "text-red-600"
															: entry.action === "delete_version"
																? "text-amber-600"
																: "text-blue-600"
													}
												>
													{actionLabels[entry.action]}
												</span>
											</td>
											<td className="px-4 py-2.5 font-mono text-gray-700">
												{entry.repo}
											</td>
											<td className="px-4 py-2.5 font-mono text-gray-500">
												{entry.digest
													? shortDigest(entry.digest)
													: (entry.tag ?? "—")}
											</td>
										</tr>
									))}
								</tbody>
							</table>
						</div>
					)}
				</section>
			</main>
		</div>
	);
}

function DeleteRepoForm({ repo, busy }: { repo: string; busy: boolean }) {
	return (
		<details className="text-left">
			<summary className="list-none inline-block cursor-pointer rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50">
				Hapus repo
			</summary>
			<form
				method="post"
				className="mt-2 w-64 rounded-lg border border-red-200 bg-red-50/50 p-3"
				onSubmit={(event) => {
					if (
						!window.confirm(
							`Hapus seluruh repo ${repo}? Semua tag, digest manifest, dan blob di v2/${repo}/ akan dihapus permanen.`,
						)
					) {
						event.preventDefault();
					}
				}}
			>
				<input type="hidden" name="intent" value="delete_repo" />
				<input type="hidden" name="repo" value={repo} />
				<label className="text-xs text-gray-600">
					Ketik <code className="font-mono text-gray-900">{repo}</code> untuk
					konfirmasi:
				</label>
				<input
					name="confirm"
					required
					placeholder={repo}
					className="mt-2 w-full rounded border border-gray-300 bg-white px-2 py-1.5 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				/>
				<button
					type="submit"
					disabled={busy}
					className="mt-2 w-full rounded bg-red-600 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-700 disabled:opacity-50"
				>
					{busy ? "Menghapus…" : "Hapus seluruh repo"}
				</button>
			</form>
		</details>
	);
}

function SearchIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			aria-hidden="true"
		>
			<circle cx="8.5" cy="8.5" r="5" />
			<path d="M12.5 12.5 16 16" strokeLinecap="round" />
		</svg>
	);
}

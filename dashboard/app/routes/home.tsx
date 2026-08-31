import type { Route } from "./+types/home";
import { Link, useNavigation } from "react-router";
import { listRepos, deleteRepo } from "../lib/oci";
import { logAudit, recentAudit } from "../lib/audit";
import { formatBytes, formatDate } from "../lib/format";

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

export async function action({ request, context }: Route.ActionArgs) {
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

	return (
		<div className="min-h-screen bg-gray-950 text-gray-100">
			<header className="border-b border-gray-800">
				<div className="mx-auto max-w-5xl px-4 py-6">
					<h1 className="text-2xl font-semibold tracking-tight">OCI Registry Dashboard</h1>
					<p className="mt-1 text-sm text-gray-400">
						Source of truth: R2 bucket <code>catetin-container</code>
					</p>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-4 py-8 space-y-10">
				<section>
					<div className="flex items-center justify-between">
						<h2 className="text-lg font-medium">Repositori</h2>
						<span className="text-sm text-gray-400">{repos.length} image</span>
					</div>

					{actionData && !actionData.ok && (
						<p className="mt-3 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
							{actionData.error}
						</p>
					)}
					{actionData?.ok && (
						<p className="mt-3 rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
							{actionData.deleted} objek dihapus dari repo{" "}
							<code>{actionData.repo}</code>
						</p>
					)}

					{repos.length === 0 ? (
						<p className="mt-4 text-gray-500">Belum ada image di bucket.</p>
					) : (
						<div className="mt-4 overflow-x-auto rounded-xl border border-gray-800">
							<table className="w-full text-left text-sm">
								<thead className="border-b border-gray-800 bg-gray-900 text-gray-400">
									<tr>
										<th className="px-4 py-3 font-medium">Image</th>
										<th className="px-4 py-3 font-medium">Tags</th>
										<th className="px-4 py-3 font-medium">Ukuran (blobs)</th>
										<th className="px-4 py-3 font-medium" />
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-800">
									{repos.map((repo) => (
										<tr key={repo.name} className="bg-gray-950">
											<td className="px-4 py-3">
												<Link
													to={`/repo/${repo.name}`}
													className="font-mono text-emerald-400 hover:underline"
												>
													{repo.name}
												</Link>
											</td>
											<td className="px-4 py-3 text-gray-300">{repo.tagCount}</td>
											<td className="px-4 py-3 text-gray-300">
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
				</section>

				<section>
					<h2 className="text-lg font-medium">Audit log (hapus)</h2>
					{audit.length === 0 ? (
						<p className="mt-4 text-gray-500">Belum ada aktivitas hapus.</p>
					) : (
						<div className="mt-4 overflow-x-auto rounded-xl border border-gray-800">
							<table className="w-full text-left text-sm">
								<thead className="border-b border-gray-800 bg-gray-900 text-gray-400">
									<tr>
										<th className="px-4 py-3 font-medium">Waktu</th>
										<th className="px-4 py-3 font-medium">Aksi</th>
										<th className="px-4 py-3 font-medium">Repo</th>
										<th className="px-4 py-3 font-medium">Tag</th>
									</tr>
								</thead>
								<tbody className="divide-y divide-gray-800">
									{audit.map((entry) => (
										<tr key={entry.id} className="bg-gray-950">
											<td className="px-4 py-2.5 text-gray-400">
												{formatDate(entry.created_at)}
											</td>
											<td className="px-4 py-2.5">
												<span
													className={
														entry.action === "delete_repo"
															? "text-red-400"
															: "text-amber-400"
													}
												>
													{entry.action}
												</span>
											</td>
											<td className="px-4 py-2.5 font-mono text-gray-300">{entry.repo}</td>
											<td className="px-4 py-2.5 font-mono text-gray-400">
												{entry.tag ?? "—"}
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
			<summary className="cursor-pointer rounded-md px-2 py-1 text-xs text-red-400 hover:bg-red-950/40">
				Hapus repo
			</summary>
			<form method="post" className="mt-2 flex flex-col gap-2 rounded-lg border border-red-900 bg-gray-900 p-3">
				<input type="hidden" name="intent" value="delete_repo" />
				<input type="hidden" name="repo" value={repo} />
				<label className="text-xs text-gray-400">
					Ketik <code className="text-gray-200">{repo}</code> untuk konfirmasi:
				</label>
				<input
					name="confirm"
					required
					placeholder={repo}
					className="rounded-md border border-gray-700 bg-gray-950 px-2 py-1.5 text-sm text-gray-200 placeholder-gray-600"
				/>
				<button
					type="submit"
					disabled={busy}
					className="rounded-md bg-red-700 px-3 py-1.5 text-xs font-medium text-white hover:bg-red-600 disabled:opacity-50"
				>
					{busy ? "Menghapus…" : "Hapus seluruh repo"}
				</button>
			</form>
		</details>
	);
}
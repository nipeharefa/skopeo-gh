import type { Route } from "./+types/repo";
import { Link, useNavigation } from "react-router";
import { listTags, deleteTag } from "../lib/oci";
import { logAudit } from "../lib/audit";
import { formatBytes, formatDate } from "../lib/format";

export function meta({ params }: Route.MetaArgs) {
	return [
		{ title: `repo/${params.name} · OCI Dashboard` },
		{ name: "description", content: `Tags untuk image ${params.name}` },
	];
}

export async function loader({ context, params }: Route.LoaderArgs) {
	const tags = await listTags(context.cloudflare.env.OCI_BUCKET, params.name);
	return { repo: params.name, tags };
}

export async function action({ request, context, params }: Route.ActionArgs) {
	const { env } = context.cloudflare;
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "delete_tag") {
		const tag = String(formData.get("tag") ?? "");
		if (!tag) return { ok: false, error: "Tag tidak valid." };
		await deleteTag(env.OCI_BUCKET, params.name, tag);
		await logAudit(env.DB, "delete_tag", params.name, tag);
		return { ok: true, tag };
	}

	return { ok: false, error: "Intent tidak dikenal." };
}

export default function Repo({ loaderData, actionData }: Route.ComponentProps) {
	const navigation = useNavigation();
	const { repo, tags } = loaderData;
	const busy = navigation.state === "submitting";

	return (
		<div className="min-h-screen bg-gray-950 text-gray-100">
			<header className="border-b border-gray-800">
				<div className="mx-auto max-w-5xl px-4 py-6">
					<Link to="/" className="text-sm text-gray-400 hover:text-gray-200">
						← Kembali
					</Link>
					<h1 className="mt-2 font-mono text-2xl font-semibold tracking-tight text-emerald-400">
						{repo}
					</h1>
					<p className="mt-1 text-sm text-gray-400">
						{tags.length} tag
					</p>
				</div>
			</header>

			<main className="mx-auto max-w-5xl px-4 py-8">
				{actionData && !actionData.ok && (
					<p className="mb-4 rounded-lg border border-red-800 bg-red-950/40 px-3 py-2 text-sm text-red-300">
						{actionData.error}
					</p>
				)}
				{actionData?.ok && (
					<p className="mb-4 rounded-lg border border-emerald-800 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-300">
						Tag <code>{actionData.tag}</code> dihapus.
					</p>
				)}

				{tags.length === 0 ? (
					<p className="text-gray-500">
						Tidak ada tag di repo ini.
					</p>
				) : (
					<div className="overflow-x-auto rounded-xl border border-gray-800">
						<table className="w-full text-left text-sm">
							<thead className="border-b border-gray-800 bg-gray-900 text-gray-400">
								<tr>
									<th className="px-4 py-3 font-medium">Tag</th>
									<th className="px-4 py-3 font-medium">Ukuran manifest</th>
									<th className="px-4 py-3 font-medium">Di-upload</th>
									<th className="px-4 py-3 font-medium" />
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-800">
								{tags.map((tag) => (
									<tr key={tag.tag} className="bg-gray-950">
										<td className="px-4 py-3 font-mono text-gray-200">{tag.tag}</td>
										<td className="px-4 py-3 text-gray-400">{formatBytes(tag.size)}</td>
										<td className="px-4 py-3 text-gray-400">{formatDate(tag.uploaded)}</td>
										<td className="px-4 py-3 text-right">
											<form
												method="post"
												onSubmit={(e) => {
													if (
														!window.confirm(
															`Hapus tag ${repo}:${tag.tag}? Ini tidak menghapus blobs/digest.`,
														)
													) {
														e.preventDefault();
													}
												}}
											>
												<input type="hidden" name="intent" value="delete_tag" />
												<input type="hidden" name="tag" value={tag.tag} />
												<button
													type="submit"
													disabled={busy}
													className="rounded-md px-2 py-1 text-xs text-red-400 hover:bg-red-950/40 disabled:opacity-50"
												>
													Hapus
												</button>
											</form>
										</td>
									</tr>
								))}
							</tbody>
						</table>
					</div>
				)}

				<p className="mt-6 text-xs text-gray-600">
					Menghapus tag hanya menghapus key <code>v2/{repo}/manifests/&lt;tag&gt;</code>.
					Digest manifest <code>sha256:…</code> dan blobs dibiarkan — mungkin masih
					dipakai tag lain.
				</p>
			</main>
		</div>
	);
}
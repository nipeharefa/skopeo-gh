import { Fragment, useMemo, useState, type ReactNode } from "react";
import { Link, redirect, useNavigation, useRevalidator } from "react-router";
import type { Route } from "./+types/repo";
import {
	deleteRepo,
	deleteTag,
	deleteVersion,
	gcOrphanBlobs,
	listTags,
	type Platform,
} from "../lib/oci";
import { logAudit } from "../lib/audit";
import {
	formatBytes,
	formatDate,
	formatPlatform,
	shortDigest,
} from "../lib/format";

type ActionResult =
	| { ok: false; error: string }
	| { ok: true; action: "delete_tag"; tag: string }
	| { ok: true; action: "delete_version"; digest: string; tags: string[] }
	| { ok: true; action: "gc"; deleted: number; kept: number; scanned: number };

type SortField = "tag" | "size" | "uploaded";

export function meta({ params }: Route.MetaArgs) {
	return [
		{ title: `repo/${params.name} · OCI Dashboard` },
		{ name: "description", content: `Tags untuk image ${params.name}` },
	];
}

export async function loader({ context, params }: Route.LoaderArgs) {
	const tags = await listTags(context.cloudflare.env.OCI_BUCKET, params.name);
	const totalSize = tags.reduce((sum, tag) => sum + tag.sizeBytes, 0);
	return { repo: params.name, tags, totalSize };
}

export async function action({
	request,
	context,
	params,
}: Route.ActionArgs): Promise<ActionResult> {
	const { env } = context.cloudflare;
	const formData = await request.formData();
	const intent = formData.get("intent");

	if (intent === "delete_tag") {
		const tag = String(formData.get("tag") ?? "");
		if (!tag) return { ok: false, error: "Tag tidak valid." };
		await deleteTag(env.OCI_BUCKET, params.name, tag);
		await logAudit(env.DB, "delete_tag", params.name, tag);
		return { ok: true, action: "delete_tag", tag };
	}

	if (intent === "delete_version") {
		const digest = String(formData.get("digest") ?? "");
		if (!/^sha256:[a-f0-9]{64}$/.test(digest)) {
			return { ok: false, error: "Digest tidak valid." };
		}
		const { tags } = await deleteVersion(env.OCI_BUCKET, params.name, digest);
		await logAudit(env.DB, "delete_version", params.name, null, digest);
		return { ok: true, action: "delete_version", digest, tags };
	}

	if (intent === "gc") {
		const result = await gcOrphanBlobs(env.OCI_BUCKET, params.name);
		return { ok: true, action: "gc", ...result };
	}

	if (intent === "delete_repo") {
		const confirm = String(formData.get("confirm") ?? "");
		if (confirm.trim() !== params.name) {
			return { ok: false, error: "Nama repo tidak cocok, hapus dibatalkan." };
		}
		await deleteRepo(env.OCI_BUCKET, params.name);
		await logAudit(env.DB, "delete_repo", params.name, null);
		throw redirect("/");
	}

	return { ok: false, error: "Intent tidak dikenal." };
}

export default function Repo({ loaderData, actionData }: Route.ComponentProps) {
	const { repo, tags, totalSize } = loaderData;
	const navigation = useNavigation();
	const revalidator = useRevalidator();
	const busy = navigation.state === "submitting";

	const [query, setQuery] = useState("");
	const [expanded, setExpanded] = useState<string | null>(null);
	const [copied, setCopied] = useState<string | null>(null);
	const [sort, setSort] = useState<{ field: SortField; dir: "asc" | "desc" }>({
		field: "uploaded",
		dir: "desc",
	});

	const visibleTags = useMemo(() => {
		const needle = query.trim().toLowerCase();
		const list = needle
			? tags.filter((tag) =>
					[tag.tag, tag.digest, ...tag.platforms.map(formatPlatform)]
						.join(" ")
						.toLowerCase()
						.includes(needle),
				)
			: [...tags];

		const direction = sort.dir === "asc" ? 1 : -1;
		list.sort((a, b) => {
			switch (sort.field) {
				case "tag":
					return a.tag.localeCompare(b.tag) * direction;
				case "size":
					return (a.sizeBytes - b.sizeBytes) * direction;
				case "uploaded":
					return (new Date(a.uploaded).getTime() - new Date(b.uploaded).getTime()) * direction;
			}
		});
		return list;
	}, [tags, query, sort]);

	const toggle = (tag: string) =>
		setExpanded((current) => (current === tag ? null : tag));

	const changeSort = (field: SortField) =>
		setSort((current) =>
			current.field === field
				? { field, dir: current.dir === "asc" ? "desc" : "asc" }
				: { field, dir: field === "uploaded" ? "desc" : "asc" },
		);

	async function copyDigest(digest: string) {
		try {
			await navigator.clipboard.writeText(digest);
			setCopied(digest);
			window.setTimeout(
				() => setCopied((current) => (current === digest ? null : current)),
				1500,
			);
		} catch {
			// Clipboard access can be denied; leave the digest selectable.
		}
	}

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
					<Link to="/" className="text-blue-600 hover:underline">
						Repositories
					</Link>
					<span className="mx-1.5">/</span>
					<span className="text-gray-700">{repo}</span>
				</nav>

				<div className="mt-2 flex flex-wrap items-start justify-between gap-3">
					<div>
						<h1 className="font-mono text-2xl font-semibold tracking-tight text-gray-900">
							{repo}
						</h1>
						<p className="mt-1 text-sm text-gray-500">
							{tags.length} tag · {formatBytes(totalSize)} total
						</p>
					</div>
					<div className="flex flex-wrap items-center gap-2">
						<button
							type="button"
							onClick={() => revalidator.revalidate()}
							disabled={revalidator.state !== "idle"}
							className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
						>
							{revalidator.state === "idle" ? "Refresh" : "Memuat…"}
						</button>
						<GcForm busy={busy} />
						<DeleteRepoMenu repo={repo} busy={busy} />
					</div>
				</div>

				{actionData && !actionData.ok && (
					<p className="mt-4 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">
						{actionData.error}
					</p>
				)}
				{actionData?.ok && actionData.action === "delete_tag" && (
					<p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
						Tag <code className="font-mono">{actionData.tag}</code> dihapus. Blob dan
						digest key tidak disentuh.
					</p>
				)}
				{actionData?.ok && actionData.action === "delete_version" && (
					<p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
						Version <code className="font-mono">{shortDigest(actionData.digest)}</code>{" "}
						dihapus beserta {actionData.tags.length} tag. Blob menunggu GC.
					</p>
				)}
				{actionData?.ok && actionData.action === "gc" && (
					<p className="mt-4 rounded-lg border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-700">
						GC selesai: {actionData.deleted} dari {actionData.scanned} blob dihapus,{" "}
						{actionData.kept} masih direferensikan.
					</p>
				)}

				<div className="mt-6 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
					<div className="relative w-full sm:max-w-sm">
						<SearchIcon className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-gray-400" />
						<input
							type="search"
							value={query}
							onChange={(event) => setQuery(event.target.value)}
							placeholder="Filter tag, digest, atau platform…"
							aria-label="Filter tag"
							className="w-full rounded border border-gray-300 bg-white py-1.5 pl-9 pr-3 text-sm text-gray-900 placeholder:text-gray-400 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
						/>
					</div>
					<p className="text-xs text-gray-500">
						{visibleTags.length} dari {tags.length} tag
					</p>
				</div>

				{tags.length === 0 ? (
					<div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-500">
						Belum ada tag di image ini.
					</div>
				) : visibleTags.length === 0 ? (
					<div className="mt-3 rounded-lg border border-dashed border-gray-300 bg-white px-6 py-12 text-center text-sm text-gray-500">
						Tidak ada tag yang cocok dengan filter.
					</div>
				) : (
					<div className="mt-3 overflow-x-auto rounded-lg border border-gray-200 bg-white">
						<table className="w-full min-w-[860px] text-left text-sm">
							<thead className="border-b border-gray-200 bg-gray-50 text-xs font-medium uppercase tracking-wide text-gray-500">
								<tr>
									<th className="w-10 px-3 py-3" />
									<th className="px-3 py-3">
										<SortButton
											label="Version"
											field="tag"
											sort={sort}
											onSort={changeSort}
										/>
									</th>
									<th className="px-3 py-3">Digest</th>
									<th className="px-3 py-3">Platforms</th>
									<th className="px-3 py-3">
										<SortButton
											label="Size"
											field="size"
											sort={sort}
											onSort={changeSort}
										/>
									</th>
									<th className="px-3 py-3">
										<SortButton
											label="Updated"
											field="uploaded"
											sort={sort}
											onSort={changeSort}
										/>
									</th>
									<th className="px-3 py-3 text-right">Actions</th>
								</tr>
							</thead>
							<tbody className="divide-y divide-gray-100">
								{visibleTags.map((tag) => {
									const open = expanded === tag.tag;
									const sharing = tags.filter((other) => other.digest === tag.digest);
									return (
										<Fragment key={tag.tag}>
											<tr className={open ? "bg-blue-50/50" : "hover:bg-gray-50"}>
												<td className="px-3 py-3 align-top">
													<button
														type="button"
														onClick={() => toggle(tag.tag)}
														aria-expanded={open}
														aria-label={`${open ? "Tutup" : "Buka"} detail ${tag.tag}`}
														className="rounded p-1 text-gray-500 hover:bg-gray-200"
													>
														<ChevronIcon
															className={`h-4 w-4 transition-transform ${open ? "rotate-90" : ""}`}
														/>
													</button>
												</td>
												<td className="px-3 py-3 align-top">
													<button
														type="button"
														onClick={() => toggle(tag.tag)}
														className="font-mono font-medium text-gray-900 hover:text-blue-600"
													>
														{tag.tag}
													</button>
												</td>
												<td className="px-3 py-3 align-top">
													<DigestCell
														digest={tag.digest}
														copied={copied === tag.digest}
														onCopy={copyDigest}
													/>
												</td>
												<td className="px-3 py-3 align-top">
													<PlatformChips platforms={tag.platforms} />
												</td>
												<td className="whitespace-nowrap px-3 py-3 align-top text-gray-600">
													{formatBytes(tag.sizeBytes)}
												</td>
												<td className="whitespace-nowrap px-3 py-3 align-top text-gray-600">
													{formatDate(tag.uploaded)}
												</td>
												<td className="px-3 py-3 align-top text-right">
													<DeleteTagForm tag={tag.tag} busy={busy} />
												</td>
											</tr>
											{open && (
												<tr className="bg-gray-50">
													<td colSpan={7} className="px-6 py-5">
														<dl className="grid grid-cols-1 gap-4 sm:grid-cols-2">
															<Detail label="Digest">
																<span className="flex items-start gap-2">
																	<code className="break-all font-mono text-xs text-gray-800">
																		{tag.digest || "—"}
																	</code>
																	{tag.digest && (
																		<CopyButton
																			digest={tag.digest}
																			copied={copied === tag.digest}
																			onCopy={copyDigest}
																		/>
																	)}
																</span>
															</Detail>
															<Detail label="Media type">
																<code className="break-all font-mono text-xs text-gray-800">
																	{tag.mediaType ?? "—"}
																</code>
															</Detail>
															<Detail label="Platforms">
																<PlatformChips platforms={tag.platforms} />
															</Detail>
															<Detail label="Ukuran image">
																{formatBytes(tag.sizeBytes)}
															</Detail>
															<Detail label="Di-upload">
																{formatDate(tag.uploaded)}
															</Detail>
															<Detail label="Tag dengan digest ini">
																{sharing.length > 0
																	? sharing.map((other) => other.tag).join(", ")
																	: "—"}
															</Detail>
														</dl>
														<div className="mt-5 flex flex-wrap items-center gap-2 border-t border-gray-200 pt-4">
															<DeleteVersionForm
																digest={tag.digest}
																sharing={sharing.map((other) => other.tag)}
																busy={busy}
															/>
															<p className="text-xs text-gray-500">
																Hapus version menghapus digest key dan semua tag yang
																menunjuk digest ini. Blob dibersihkan lewat GC.
															</p>
														</div>
													</td>
												</tr>
											)}
										</Fragment>
									);
								})}
							</tbody>
						</table>
					</div>
				)}

				<p className="mt-6 text-xs text-gray-500">
					Hapus tag hanya menghapus key <code>v2/{repo}/manifests/&lt;tag&gt;</code>.
					Hapus version menghapus digest key dan semua tag yang menunjuk ke digest
					tersebut. Hapus repo menghapus seluruh prefix <code>v2/{repo}/</code>{" "}
					termasuk blob.
				</p>
			</main>
		</div>
	);
}

function Detail({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div>
			<dt className="text-xs font-medium uppercase tracking-wide text-gray-500">
				{label}
			</dt>
			<dd className="mt-1 text-sm text-gray-800">{children}</dd>
		</div>
	);
}

function SortButton({
	label,
	field,
	sort,
	onSort,
}: {
	label: string;
	field: SortField;
	sort: { field: SortField; dir: "asc" | "desc" };
	onSort: (field: SortField) => void;
}) {
	const active = sort.field === field;
	return (
		<button
			type="button"
			onClick={() => onSort(field)}
			className="flex items-center gap-1 uppercase tracking-wide hover:text-gray-800"
		>
			{label}
			<span className={active ? "text-gray-700" : "text-gray-300"}>
				{active ? (sort.dir === "asc" ? "↑" : "↓") : "↕"}
			</span>
		</button>
	);
}

function PlatformChips({ platforms }: { platforms: Platform[] }) {
	if (platforms.length === 0) return <span className="text-gray-400">—</span>;
	return (
		<div className="flex flex-wrap gap-1">
			{platforms.map((platform) => (
				<span
					key={formatPlatform(platform)}
					className="inline-flex items-center rounded-full bg-gray-100 px-2 py-0.5 font-mono text-xs text-gray-700"
				>
					{formatPlatform(platform)}
				</span>
			))}
		</div>
	);
}

function DigestCell({
	digest,
	copied,
	onCopy,
}: {
	digest: string;
	copied: boolean;
	onCopy: (digest: string) => void;
}) {
	if (!digest) return <span className="text-gray-400">—</span>;
	return (
		<span className="flex items-center gap-1">
			<code className="font-mono text-xs text-gray-600" title={digest}>
				{shortDigest(digest)}
			</code>
			<CopyButton digest={digest} copied={copied} onCopy={onCopy} />
		</span>
	);
}

function CopyButton({
	digest,
	copied,
	onCopy,
}: {
	digest: string;
	copied: boolean;
	onCopy: (digest: string) => void;
}) {
	return (
		<button
			type="button"
			onClick={(event) => {
				event.stopPropagation();
				onCopy(digest);
			}}
			aria-label="Copy digest"
			title={copied ? "Copied" : "Copy digest"}
			className="rounded p-1 text-gray-400 hover:bg-gray-200 hover:text-gray-700"
		>
			{copied ? (
				<CheckIcon className="h-3.5 w-3.5 text-emerald-600" />
			) : (
				<CopyIcon className="h-3.5 w-3.5" />
			)}
		</button>
	);
}

function DeleteTagForm({ tag, busy }: { tag: string; busy: boolean }) {
	return (
		<form
			method="post"
			className="inline"
			onSubmit={(event) => {
				if (
					!window.confirm(
						`Hapus tag ${tag}? Manifest tag dihapus; blob dan digest key tetap ada.`,
					)
				) {
					event.preventDefault();
				}
			}}
		>
			<input type="hidden" name="intent" value="delete_tag" />
			<input type="hidden" name="tag" value={tag} />
			<button
				type="submit"
				disabled={busy}
				className="rounded px-2 py-1 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
			>
				Hapus tag
			</button>
		</form>
	);
}

function DeleteVersionForm({
	digest,
	sharing,
	busy,
}: {
	digest: string;
	sharing: string[];
	busy: boolean;
}) {
	if (!digest) return null;
	const sharedText =
		sharing.length > 0
			? `Tag berikut ikut terhapus: ${sharing.join(", ")}.`
			: "Tidak ada tag yang menunjuk digest ini.";
	return (
		<form
			method="post"
			className="inline"
			onSubmit={(event) => {
				if (
					!window.confirm(
						`Hapus version ${shortDigest(digest)}? ${sharedText} Blob tidak dihapus; jalankan GC untuk membersihkannya.`,
					)
				) {
					event.preventDefault();
				}
			}}
		>
			<input type="hidden" name="intent" value="delete_version" />
			<input type="hidden" name="digest" value={digest} />
			<button
				type="submit"
				disabled={busy}
				className="rounded border border-red-300 bg-white px-3 py-1.5 text-xs font-medium text-red-600 hover:bg-red-50 disabled:opacity-50"
			>
				Hapus version
			</button>
		</form>
	);
}

function GcForm({ busy }: { busy: boolean }) {
	return (
		<form
			method="post"
			className="inline"
			onSubmit={(event) => {
				if (
					!window.confirm(
						"Hapus blob yang tidak lagi direferensikan manifest mana pun di repo ini? Proses ini menghitung ulang semua referensi.",
					)
				) {
					event.preventDefault();
				}
			}}
		>
			<input type="hidden" name="intent" value="gc" />
			<button
				type="submit"
				disabled={busy}
				className="rounded border border-gray-300 bg-white px-3 py-1.5 text-sm font-medium text-gray-700 hover:bg-gray-50 disabled:opacity-50"
			>
				GC blob yatim
			</button>
		</form>
	);
}

function DeleteRepoMenu({ repo, busy }: { repo: string; busy: boolean }) {
	return (
		<details className="relative">
			<summary className="list-none cursor-pointer rounded border border-red-200 bg-white px-3 py-1.5 text-sm font-medium text-red-600 hover:bg-red-50">
				Hapus repo
			</summary>
			<form
				method="post"
				className="absolute right-0 z-20 mt-2 w-72 rounded-lg border border-gray-200 bg-white p-4 text-left shadow-lg"
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
				<p className="text-xs text-gray-600">
					Ketik <code className="font-mono text-gray-900">{repo}</code> untuk
					konfirmasi. Semua tag, digest manifest, dan blob di{" "}
					<code className="font-mono">v2/{repo}/</code> akan dihapus.
				</p>
				<input
					name="confirm"
					required
					placeholder={repo}
					className="mt-2 w-full rounded border border-gray-300 px-2 py-1.5 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
				/>
				<button
					type="submit"
					disabled={busy}
					className="mt-2 w-full rounded bg-red-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-red-700 disabled:opacity-50"
				>
					Hapus permanen
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

function ChevronIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.8}
			aria-hidden="true"
		>
			<path d="m7 5 5 5-5 5" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

function CopyIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth={1.6}
			aria-hidden="true"
		>
			<rect x="7" y="7" width="9" height="9" rx="1.5" />
			<path d="M13 7V5.5A1.5 1.5 0 0 0 11.5 4H5.5A1.5 1.5 0 0 0 4 5.5v6A1.5 1.5 0 0 0 5.5 13H7" />
		</svg>
	);
}

function CheckIcon({ className = "" }: { className?: string }) {
	return (
		<svg
			className={className}
			viewBox="0 0 20 20"
			fill="none"
			stroke="currentColor"
			strokeWidth={2}
			aria-hidden="true"
		>
			<path d="m4 10 4 4 8-8" strokeLinecap="round" strokeLinejoin="round" />
		</svg>
	);
}

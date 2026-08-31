export interface Repo {
	name: string;
	tagCount: number;
	sizeBytes: number;
}

export interface Tag {
	tag: string;
	size: number;
	uploaded: Date;
}

const manifestsPrefix = (repo: string) => `v2/${repo}/manifests/`;

function isDigestKey(key: string): boolean {
	return key.includes("/manifests/sha256:");
}

async function listAll(bucket: R2Bucket, prefix: string): Promise<R2Object[]> {
	const objects: R2Object[] = [];
	let cursor: string | undefined;
	do {
		const page = await bucket.list({ prefix, cursor, limit: 1000 });
		objects.push(...page.objects);
		cursor = page.truncated ? page.cursor : undefined;
	} while (cursor);
	return objects;
}

export async function listRepos(bucket: R2Bucket): Promise<Repo[]> {
	const page = await bucket.list({ prefix: "v2/", delimiter: "/", limit: 1000 });
	const names = page.delimitedPrefixes
		.filter((prefix) => prefix.endsWith("/"))
		.map((prefix) => prefix.split("/").filter(Boolean).at(-1))
		.filter((name): name is string => Boolean(name));

	return Promise.all(
		names.map(async (name) => {
			const [manifests, blobs] = await Promise.all([
				listAll(bucket, manifestsPrefix(name)),
				listAll(bucket, `v2/${name}/blobs/sha256/`),
			]);
			const tagCount = manifests.filter((o) => !isDigestKey(o.key)).length;
			const sizeBytes = blobs.reduce((sum, o) => sum + o.size, 0);
			return { name, tagCount, sizeBytes };
		}),
	);
}

export async function listTags(bucket: R2Bucket, repo: string): Promise<Tag[]> {
	const prefix = manifestsPrefix(repo);
	const objects = await listAll(bucket, prefix);
	return objects
		.filter((o) => !isDigestKey(o.key))
		.map((o) => ({
			tag: o.key.slice(prefix.length),
			size: o.size,
			uploaded: o.uploaded,
		}))
		.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
}

export async function deleteTag(bucket: R2Bucket, repo: string, tag: string) {
	await bucket.delete(`v2/${repo}/manifests/${tag}`);
}

export async function deleteRepo(bucket: R2Bucket, repo: string): Promise<number> {
	const objects = await listAll(bucket, `v2/${repo}/`);
	const keys = objects.map((o) => o.key);
	for (let i = 0; i < keys.length; i += 1000) {
		await bucket.delete(keys.slice(i, i + 1000));
	}
	return keys.length;
}
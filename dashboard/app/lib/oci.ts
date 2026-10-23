export interface Repo {
	name: string;
	tagCount: number;
	storageBytes: number;
}

export interface Platform {
	os: string;
	architecture: string;
	variant?: string;
}

export interface Tag {
	tag: string;
	digest: string;
	mediaType?: string;
	imageBytes: number;
	uploaded: Date;
	platforms: Platform[];
}

interface OciDescriptor {
	mediaType?: string;
	size?: number;
	digest: string;
	platform?: Platform;
}

interface ImageManifest {
	mediaType?: string;
	config?: { size?: number; digest?: string };
	layers?: { size?: number; digest?: string }[];
	manifests?: OciDescriptor[];
}

interface ImageConfig {
	os?: string;
	architecture?: string;
	variant?: string;
}

interface RawManifest {
	json: ImageManifest;
	digest: string;
}

const manifestsPrefix = (repo: string) => `v2/${repo}/manifests/`;
const blobsPrefix = (repo: string) => `v2/${repo}/blobs/sha256/`;
const blobKey = (repo: string, digest: string) =>
	`${blobsPrefix(repo)}${digest.replace("sha256:", "")}`;

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

async function sha256Hex(text: string): Promise<string> {
	const encoded = new TextEncoder().encode(text);
	const hash = await crypto.subtle.digest("SHA-256", encoded);
	return Array.from(new Uint8Array(hash))
		.map((b) => b.toString(16).padStart(2, "0"))
		.join("");
}

async function readManifest(bucket: R2Bucket, key: string): Promise<RawManifest | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	try {
		const text = await obj.text();
		const json = JSON.parse(text) as ImageManifest;
		return { json, digest: `sha256:${await sha256Hex(text)}` };
	} catch {
		return null;
	}
}

async function readBlobJson<T>(bucket: R2Bucket, key: string): Promise<T | null> {
	const obj = await bucket.get(key);
	if (!obj) return null;
	try {
		return await obj.json<T>();
	} catch {
		return null;
	}
}

function isKnownPlatform(platform?: Platform): platform is Platform {
	return (
		!!platform &&
		typeof platform.os === "string" &&
		typeof platform.architecture === "string" &&
		platform.os !== "unknown" &&
		platform.architecture !== "unknown"
	);
}

function platformKey(platform: Platform): string {
	return [platform.os, platform.architecture, platform.variant]
		.filter(Boolean)
		.join("/");
}

function dedupePlatforms(platforms: Platform[]): Platform[] {
	const seen = new Set<string>();
	const unique: Platform[] = [];
	for (const platform of platforms) {
		const key = platformKey(platform);
		if (seen.has(key)) continue;
		seen.add(key);
		unique.push(platform);
	}
	return unique.sort((a, b) => platformKey(a).localeCompare(platformKey(b)));
}

async function configPlatform(
	bucket: R2Bucket,
	repo: string,
	manifest: ImageManifest,
): Promise<Platform | null> {
	const digest = manifest.config?.digest;
	if (!digest) return null;
	const config = await readBlobJson<ImageConfig>(bucket, blobKey(repo, digest));
	if (!config?.os || !config.architecture) return null;
	const platform = {
		os: config.os,
		architecture: config.architecture,
		variant: config.variant,
	};
	return isKnownPlatform(platform) ? platform : null;
}

async function imagePlatforms(
	bucket: R2Bucket,
	repo: string,
	manifest: ImageManifest | null,
): Promise<Platform[]> {
	if (!manifest) return [];

	if (Array.isArray(manifest.manifests) && manifest.manifests.length > 0) {
		const fromIndex = manifest.manifests
			.map((descriptor) => descriptor.platform)
			.filter(isKnownPlatform);
		if (fromIndex.length > 0) return dedupePlatforms(fromIndex);

		// Older layouts may omit platform descriptors; inspect the sub-manifest config.
		const fromConfigs = await Promise.all(
			manifest.manifests.map(async (descriptor) => {
				const sub = await readManifest(bucket, blobKey(repo, descriptor.digest));
				return sub ? configPlatform(bucket, repo, sub.json) : null;
			}),
		);
		return dedupePlatforms(fromConfigs.filter((p): p is Platform => !!p));
	}

	const own = await configPlatform(bucket, repo, manifest);
	return own ? [own] : [];
}

function sizeOfManifest(manifest: ImageManifest): number {
	const config = manifest.config?.size ?? 0;
	const layers = manifest.layers?.reduce((sum, layer) => sum + (layer.size ?? 0), 0) ?? 0;
	return config + layers;
}

function isAttestation(descriptor: OciDescriptor): boolean {
	return descriptor.platform?.os === "unknown" || descriptor.platform?.architecture === "unknown";
}

async function imageSize(
	bucket: R2Bucket,
	repo: string,
	manifest: ImageManifest | null,
): Promise<number> {
	if (!manifest) return 0;

	if (Array.isArray(manifest.manifests) && manifest.manifests.length > 0) {
		const sizes = await Promise.all(
			manifest.manifests
				.filter((descriptor) => !isAttestation(descriptor))
				.map(async (descriptor) => {
					const sub = await readManifest(bucket, blobKey(repo, descriptor.digest));
					return sub ? sizeOfManifest(sub.json) : 0;
				}),
		);
		return sizes.reduce((sum, size) => sum + size, 0);
	}

	return sizeOfManifest(manifest);
}

export async function blobStorageSize(
	bucket: R2Bucket,
	repo: string,
): Promise<number> {
	const blobs = await listAll(bucket, blobsPrefix(repo));
	return blobs.reduce((sum, object) => sum + object.size, 0);
}

export async function listRepos(bucket: R2Bucket): Promise<Repo[]> {
	const page = await bucket.list({ prefix: "v2/", delimiter: "/", limit: 1000 });
	const names = page.delimitedPrefixes
		.filter((prefix) => prefix.endsWith("/"))
		.map((prefix) => prefix.split("/").filter(Boolean).at(-1))
		.filter((name): name is string => Boolean(name));

	return Promise.all(
		names.map(async (name) => {
			const [manifests, storageBytes] = await Promise.all([
				listAll(bucket, manifestsPrefix(name)),
				blobStorageSize(bucket, name),
			]);
			const tagCount = manifests.filter((o) => !isDigestKey(o.key)).length;
			return { name, tagCount, storageBytes };
		}),
	);
}

export async function listTags(bucket: R2Bucket, repo: string): Promise<Tag[]> {
	const prefix = manifestsPrefix(repo);
	const objects = await listAll(bucket, prefix);

	const tags = await Promise.all(
		objects
			.filter((o) => !isDigestKey(o.key))
			.map(async (o) => {
				const tag = o.key.slice(prefix.length);
				const manifest = await readManifest(bucket, o.key);
				const [imageBytes, platforms] = await Promise.all([
					imageSize(bucket, repo, manifest?.json ?? null),
					imagePlatforms(bucket, repo, manifest?.json ?? null),
				]);
				return {
					tag,
					digest: manifest?.digest ?? "",
					mediaType: manifest?.json.mediaType,
					imageBytes,
					platforms,
					uploaded: o.uploaded,
				};
			}),
	);

	return tags.sort((a, b) => b.uploaded.getTime() - a.uploaded.getTime());
}

export async function deleteTag(bucket: R2Bucket, repo: string, tag: string) {
	await bucket.delete(`${manifestsPrefix(repo)}${tag}`);
}

// Deletes several tag keys at once. Digest keys and blobs are untouched, so
// the affected versions remain pullable by digest until pruned.
export async function deleteTags(
	bucket: R2Bucket,
	repo: string,
	tags: string[],
): Promise<string[]> {
	const unique = [...new Set(tags.filter(Boolean))];
	const keys = unique.map((tag) => `${manifestsPrefix(repo)}${tag}`);
	for (let i = 0; i < keys.length; i += 1000) {
		await bucket.delete(keys.slice(i, i + 1000));
	}
	return unique;
}

// Deletes a version identified by its digest: the digest key plus every tag
// whose manifest bytes hash to that digest. Blobs are intentionally left in
// place; run gcOrphanBlobs() to reclaim them.
export async function deleteVersion(
	bucket: R2Bucket,
	repo: string,
	digest: string,
): Promise<{ tags: string[] }> {
	const prefix = manifestsPrefix(repo);
	const objects = await listAll(bucket, prefix);

	const matching: string[] = [];
	await Promise.all(
		objects
			.filter((o) => !isDigestKey(o.key))
			.map(async (o) => {
				const manifest = await readManifest(bucket, o.key);
				if (manifest?.digest === digest) matching.push(o.key);
			}),
	);

	const keys = [...matching, `${prefix}${digest}`];
	for (let i = 0; i < keys.length; i += 1000) {
		await bucket.delete(keys.slice(i, i + 1000));
	}
	return { tags: matching.map((key) => key.slice(prefix.length)).sort() };
}

export interface GcOptions {
	pruneUntagged?: boolean;
}

export interface GcResult {
	deleted: number;
	kept: number;
	scanned: number;
	untagged: number;
	pruned: string[];
	aborted: boolean;
}

interface ManifestIndex {
	tagManifests: RawManifest[];
	taggedDigests: Set<string>;
	untagged: string[];
	readFailures: string[];
}

async function indexManifests(
	bucket: R2Bucket,
	repo: string,
	objects: R2Object[],
): Promise<ManifestIndex> {
	const prefix = manifestsPrefix(repo);
	const digestKeys: string[] = [];
	const tagObjects: R2Object[] = [];

	for (const object of objects) {
		if (isDigestKey(object.key)) {
			digestKeys.push(object.key.slice(prefix.length));
		} else {
			tagObjects.push(object);
		}
	}

	const taggedDigests = new Set<string>();
	const tagManifests: RawManifest[] = [];
	const readFailures: string[] = [];

	for (const object of tagObjects) {
		const manifest = await readManifest(bucket, object.key);
		if (!manifest) {
			readFailures.push(object.key);
			continue;
		}
		tagManifests.push(manifest);
		taggedDigests.add(manifest.digest);
	}

	return {
		tagManifests,
		taggedDigests,
		untagged: digestKeys.filter((digest) => !taggedDigests.has(digest)).sort(),
		readFailures,
	};
}

// Digest keys that no tag points to. Their blobs stay pullable by digest, so
// GC keeps them until the version is explicitly pruned.
export async function listUntaggedVersions(
	bucket: R2Bucket,
	repo: string,
): Promise<string[]> {
	const objects = await listAll(bucket, manifestsPrefix(repo));
	const index = await indexManifests(bucket, repo, objects);
	return index.untagged;
}

// Removes blobs that are no longer reachable from any manifest left in the
// repository. By default every digest key is a GC root (untagged versions stay
// pullable by digest). With pruneUntagged, digest keys without a tag are
// removed first and their blobs become collectable.
export async function gcOrphanBlobs(
	bucket: R2Bucket,
	repo: string,
	options: GcOptions = {},
): Promise<GcResult> {
	const [manifestObjects, blobObjects] = await Promise.all([
		listAll(bucket, manifestsPrefix(repo)),
		listAll(bucket, blobsPrefix(repo)),
	]);

	const index = await indexManifests(bucket, repo, manifestObjects);
	const aborted = (reason: string): GcResult => {
		console.warn(reason);
		return {
			deleted: 0,
			kept: blobObjects.length,
			scanned: blobObjects.length,
			untagged: index.untagged.length,
			pruned: [],
			aborted: true,
		};
	};

	if (index.readFailures.length > 0) {
		return aborted(`gc: unreadable manifest(s): ${index.readFailures.join(", ")}`);
	}

	const roots: RawManifest[] = [];
	const seenTopLevel = new Set<string>();
	const addRoot = (manifest: RawManifest | null) => {
		if (!manifest || seenTopLevel.has(manifest.digest)) return;
		seenTopLevel.add(manifest.digest);
		roots.push(manifest);
	};

	for (const manifest of index.tagManifests) addRoot(manifest);

	const pruning = Boolean(options.pruneUntagged);
	if (!pruning) {
		for (const digest of index.untagged) {
			const manifest = await readManifest(bucket, `${manifestsPrefix(repo)}${digest}`);
			if (!manifest) {
				return aborted(`gc: unreadable untagged manifest: ${digest}`);
			}
			addRoot(manifest);
		}
	}

	const reachable = new Set<string>();
	const toParse: string[] = [];
	const queued = new Set<string>();

	for (const manifest of roots) {
		// The top-level manifest is also stored under blobs/ by skopeo.
		reachable.add(manifest.digest);
		collectReferences(manifest.json, reachable, toParse, queued);
	}

	while (toParse.length > 0) {
		const digest = toParse.shift();
		if (!digest) continue;
		const sub = await readManifest(bucket, blobKey(repo, digest));
		if (!sub) {
			return aborted(`gc: unreadable sub-manifest: ${digest}`);
		}
		collectReferences(sub.json, reachable, toParse, queued);
	}

	let pruned: string[] = [];
	if (pruning && index.untagged.length > 0) {
		const keys = index.untagged.map((digest) => `${manifestsPrefix(repo)}${digest}`);
		for (let i = 0; i < keys.length; i += 1000) {
			await bucket.delete(keys.slice(i, i + 1000));
		}
		pruned = index.untagged;
	}

	const prefix = blobsPrefix(repo);
	const orphans = blobObjects
		.map((object) => `sha256:${object.key.slice(prefix.length)}`)
		.filter((digest) => !reachable.has(digest));

	for (let i = 0; i < orphans.length; i += 1000) {
		await bucket.delete(orphans.slice(i, i + 1000).map((digest) => blobKey(repo, digest)));
	}

	return {
		deleted: orphans.length,
		kept: blobObjects.length - orphans.length,
		scanned: blobObjects.length,
		untagged: index.untagged.length,
		pruned,
		aborted: false,
	};
}

function collectReferences(
	manifest: ImageManifest,
	reachable: Set<string>,
	toParse: string[],
	queued: Set<string>,
) {
	if (manifest.config?.digest) reachable.add(manifest.config.digest);
	for (const layer of manifest.layers ?? []) {
		if (layer.digest) reachable.add(layer.digest);
	}
	for (const descriptor of manifest.manifests ?? []) {
		if (!descriptor.digest) continue;
		reachable.add(descriptor.digest);
		if (!queued.has(descriptor.digest)) {
			queued.add(descriptor.digest);
			toParse.push(descriptor.digest);
		}
	}
}

export async function deleteRepo(bucket: R2Bucket, repo: string): Promise<number> {
	const objects = await listAll(bucket, `v2/${repo}/`);
	const keys = objects.map((o) => o.key);
	for (let i = 0; i < keys.length; i += 1000) {
		await bucket.delete(keys.slice(i, i + 1000));
	}
	return keys.length;
}

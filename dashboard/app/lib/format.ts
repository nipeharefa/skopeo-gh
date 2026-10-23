import type { Platform } from "./oci";

export function formatBytes(bytes: number): string {
	if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
	const units = ["B", "KB", "MB", "GB", "TB"];
	const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
	const value = bytes / Math.pow(1024, i);
	return `${value.toFixed(value >= 100 || i === 0 ? 0 : 1)} ${units[i]}`;
}

export function formatDate(timestamp: number | Date): string {
	const date = timestamp instanceof Date ? timestamp : new Date(timestamp);
	return date.toLocaleString(undefined, {
		year: "numeric",
		month: "short",
		day: "numeric",
		hour: "2-digit",
		minute: "2-digit",
	});
}

export function formatPlatform(platform: Platform): string {
	return [platform.os, platform.architecture, platform.variant]
		.filter(Boolean)
		.join("/");
}

export function shortDigest(digest: string): string {
	if (!digest) return "—";
	const [algorithm, hash] = digest.split(":");
	return hash ? `${algorithm}:${hash.slice(0, 12)}…` : digest.slice(0, 16);
}

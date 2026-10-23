#!/usr/bin/env bash
# Helpers to build minimal, real OCI image layouts for the test suite.
#
# Each helper is side-effect free apart from writing into <dir>. Digests are
# computed over the exact bytes written, so the layouts are structurally valid.

# Print the sha256 (hex, no prefix) of a file.
sha256_hex() {
  local file="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$file" | awk '{print $1}'
  else
    shasum -a 256 "$file" | awk '{print $1}'
  fi
}

# oci_init <dir>: create an empty but valid OCI layout skeleton.
oci_init() {
  local dir="$1"
  mkdir -p "${dir}/blobs/sha256"
  printf '{"imageLayoutVersion":"1.0.0"}' > "${dir}/oci-layout"
  jq -n '{schemaVersion: 2, manifests: []}' > "${dir}/index.json"
}

# add_oci_manifest <dir> <media-type> [ref]
# Writes a manifest blob (the only field the script inspects is mediaType) and
# appends an index entry. Prints "sha256:<hex>". Pass an empty media-type to
# omit the field entirely (exercises the detect_ct() default branch).
add_oci_manifest() {
  local dir="$1" media_type="$2" ref="${3:-}"
  local tmp="${dir}/.manifest.tmp"
  local digest size file entry

  if [[ -n "$media_type" ]]; then
    jq -n --arg mt "$media_type" '{
      schemaVersion: 2,
      mediaType: $mt,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: ("sha256:" + ("0" * 64)),
        size: 2
      },
      layers: []
    }' > "$tmp"
  else
    jq -n '{
      schemaVersion: 2,
      config: {
        mediaType: "application/vnd.oci.image.config.v1+json",
        digest: ("sha256:" + ("0" * 64)),
        size: 2
      },
      layers: []
    }' > "$tmp"
  fi

  digest="sha256:$(sha256_hex "$tmp")"
  size="$(wc -c < "$tmp" | tr -d ' ')"
  file="${dir}/blobs/sha256/${digest#sha256:}"
  mv "$tmp" "$file"

  if [[ -n "$ref" ]]; then
    entry="$(jq -nc --arg d "$digest" --argjson s "$size" --arg mt "$media_type" --arg ref "$ref" '{
      mediaType: $mt,
      digest: $d,
      size: $s,
      annotations: {"org.opencontainers.image.ref.name": $ref}
    }')"
  else
    entry="$(jq -nc --arg d "$digest" --argjson s "$size" --arg mt "$media_type" '{
      mediaType: $mt,
      digest: $d,
      size: $s
    }')"
  fi

  jq --argjson e "$entry" '.manifests += [$e]' "${dir}/index.json" \
    > "${dir}/index.json.tmp"
  mv "${dir}/index.json.tmp" "${dir}/index.json"

  printf '%s\n' "$digest"
}

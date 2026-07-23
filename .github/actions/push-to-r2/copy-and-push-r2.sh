#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<EOF
Usage:
  Copy + push single tag (default):
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
    SOURCE_IMAGE=docker://nginx:alpine IMAGE_NAME=nginx TAG=latest \\
    ./copy-and-push-r2.sh

  Copy + push multiple tags:
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
    IMAGE_NAME=nginx SOURCE_TAGS="1.25 1.26 latest" \\
    ./copy-and-push-r2.sh

  Copy only (no R2 creds needed):
    COPY_ONLY=1 IMAGE_NAME=nginx SOURCE_TAGS="1.25 1.26 latest" \\
    OCI_DIR=./multi ./copy-and-push-r2.sh

  Copy from private registry (e.g. fly.io):
    SRC_NO_CREDS=0 COPY_ONLY=1 \\
    SOURCE_IMAGE=docker://registry.fly.io/myapp:tag \\
    IMAGE_NAME=myapp TAG=tag OCI_DIR=./tmp-myapp \\
    ./copy-and-push-r2.sh

  Push only (reuse existing OCI layout):
    AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=... \\
    PUSH_ONLY=1 OCI_DIR=./multi IMAGE_NAME=nginx \\
    ./copy-and-push-r2.sh

Required env (unless COPY_ONLY=1):
  AWS_ACCESS_KEY_ID         R2 access key
  AWS_SECRET_ACCESS_KEY     R2 secret key
  R2_BUCKET                 R2 bucket name
  R2_ENDPOINT               R2 S3 endpoint URL (https://<account_id>.r2.cloudflarestorage.com)

Required env (mode-dependent):
  IMAGE_NAME                target image name in registry (e.g. nginx)
  TAG                       single target tag (required unless SOURCE_TAGS or PUSH_ONLY)
  SOURCE_TAGS               space-separated list of tags (mutually exclusive with TAG/SOURCE_IMAGE)

Optional env:
  SOURCE_IMAGE              single source image with transport (default: docker://<IMAGE_NAME>:<TAG>)
  OCI_DIR                   local OCI layout dir (default: ./tmp/<IMAGE_NAME>)
  COPY_ONLY=1               only run skopeo copy, skip all R2 uploads
  PUSH_ONLY=1               skip skopeo copy, push existing OCI_DIR
  MULTI_ARCH=all|system|copy  skopeo --multi-arch value (default: all)
  ARCH=amd64|arm64          pin single arch (overrides MULTI_ARCH)
  OS=linux                  override source OS (default: linux)
  SRC_NO_CREDS=1|0          set 0 to use ~/.docker/config.json auth (default: 1, for private registries like fly.io/gcr/ecr)
  AWS_DEFAULT_REGION        (default: auto)
EOF
  exit 1
}

[[ "${1:-}" == "--help" || "${1:-}" == "-h" ]] && usage

: "${IMAGE_NAME:?IMAGE_NAME is required (see --help)}"

COPY_ONLY="${COPY_ONLY:-}"
PUSH_ONLY="${PUSH_ONLY:-}"
SOURCE_TAGS="${SOURCE_TAGS:-}"
TAG="${TAG:-}"
SOURCE_IMAGE="${SOURCE_IMAGE:-}"

if [[ -n "${COPY_ONLY}" && -n "${PUSH_ONLY}" ]]; then
  echo "❌ COPY_ONLY and PUSH_ONLY are mutually exclusive"
  exit 1
fi
if [[ -n "${SOURCE_TAGS}" && ( -n "${TAG}" || -n "${SOURCE_IMAGE}" ) ]]; then
  echo "❌ SOURCE_TAGS is mutually exclusive with TAG / SOURCE_IMAGE"
  exit 1
fi
if [[ -z "${PUSH_ONLY}" && -z "${SOURCE_TAGS}" && -z "${TAG}" ]]; then
  echo "❌ TAG (or SOURCE_TAGS) is required when not PUSH_ONLY"
  exit 1
fi

if [[ -z "${COPY_ONLY}" ]]; then
  : "${AWS_ACCESS_KEY_ID:?AWS_ACCESS_KEY_ID is required (or set COPY_ONLY=1)}"
  : "${AWS_SECRET_ACCESS_KEY:?AWS_SECRET_ACCESS_KEY is required (or set COPY_ONLY=1)}"
  export AWS_ACCESS_KEY_ID
  export AWS_SECRET_ACCESS_KEY
fi
export AWS_DEFAULT_REGION="${AWS_DEFAULT_REGION:-auto}"

OCI_DIR="${OCI_DIR:-./tmp/${IMAGE_NAME}}"
MULTI_ARCH="${MULTI_ARCH:-all}"
OS="${OS:-linux}"
ARCH="${ARCH:-}"
SRC_NO_CREDS="${SRC_NO_CREDS:-1}"

R2_BUCKET="${R2_BUCKET:-}"
R2_ENDPOINT="${R2_ENDPOINT:-}"
if [[ -z "${COPY_ONLY}" ]]; then
  : "${R2_BUCKET:?R2_BUCKET is required (or set COPY_ONLY=1)}"
  : "${R2_ENDPOINT:?R2_ENDPOINT is required (or set COPY_ONLY=1)}"
fi

SKOPEO_FLAGS=(--format oci --override-os "${OS}")
if [[ "${SRC_NO_CREDS}" == "1" ]]; then
  SKOPEO_FLAGS+=(--src-no-creds)
fi
if [[ -n "${ARCH}" ]]; then
  SKOPEO_FLAGS+=(--override-arch "${ARCH}")
else
  SKOPEO_FLAGS+=(--multi-arch "${MULTI_ARCH}")
fi

detect_ct() {
  local media_type="${1:-}"
  case "${media_type}" in
    *index*)                                echo "application/vnd.oci.image.index.v1+json" ;;
    *oci.image.manifest*)                   echo "application/vnd.oci.image.manifest.v1+json" ;;
    *docker.distribution.manifest.list*)    echo "application/vnd.docker.distribution.manifest.list.v2+json" ;;
    *docker.distribution.manifest.v2*)      echo "application/vnd.docker.distribution.manifest.v2+json" ;;
    *)                                      echo "application/vnd.oci.image.manifest.v1+json" ;;
  esac
}

if [[ -z "${PUSH_ONLY}" ]]; then
  rm -rf "${OCI_DIR}"
  mkdir -p "${OCI_DIR}"
  if [[ -n "${SOURCE_TAGS}" ]]; then
    echo "▶ skopeo copy multi-tag -> oci:${OCI_DIR}"
    echo "  flags: ${SKOPEO_FLAGS[*]}"
    echo "  tags:  ${SOURCE_TAGS}"
    for t in ${SOURCE_TAGS}; do
      echo "  - ${IMAGE_NAME}:${t}"
      nix-shell -p skopeo --run \
        "skopeo copy ${SKOPEO_FLAGS[*]} docker://${IMAGE_NAME}:${t} oci:${OCI_DIR}:${t}"
    done
  else
    SOURCE_IMAGE="${SOURCE_IMAGE:-docker://${IMAGE_NAME}:${TAG}}"
    echo "▶ skopeo copy ${SOURCE_IMAGE} -> oci:${OCI_DIR}:${TAG}"
    echo "  flags: ${SKOPEO_FLAGS[*]}"
    nix-shell -p skopeo --run \
      "skopeo copy ${SKOPEO_FLAGS[*]} ${SOURCE_IMAGE} oci:${OCI_DIR}:${TAG}"
  fi
else
  echo "▶ PUSH_ONLY=1, using existing ${OCI_DIR}"
fi

if [[ ! -d "${OCI_DIR}" ]]; then
  echo "❌ OCI_DIR not found: ${OCI_DIR}"
  exit 1
fi
if [[ ! -f "${OCI_DIR}/index.json" ]]; then
  echo "❌ not an OCI layout: ${OCI_DIR}/index.json missing"
  exit 1
fi

MANIFEST_COUNT=$(jq '.manifests | length' "${OCI_DIR}/index.json")
if [[ "${MANIFEST_COUNT}" -eq 0 ]]; then
  echo "❌ no manifests in ${OCI_DIR}/index.json"
  exit 1
fi

echo
echo "▶ Image:      ${IMAGE_NAME}"
echo "  Layout:     ${OCI_DIR}"
echo "  Manifests:  ${MANIFEST_COUNT}"

if [[ -n "${COPY_ONLY}" ]]; then
  echo
  echo "✅ COPY SUCCESS (COPY_ONLY=1, skip push)"
  jq -r '.manifests[] | "  - " + .digest + " (" + (.annotations["org.opencontainers.image.ref.name"] // "<no-ref>") + ")"' "${OCI_DIR}/index.json"
  exit 0
fi

echo
echo "▶ Upload blobs (s3 sync)"
aws s3 sync \
  "${OCI_DIR}/blobs" \
  "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/blobs" \
  --endpoint-url "${R2_ENDPOINT}" \
  --no-progress

echo
echo "▶ Upload oci-layout"
aws s3 cp \
  "${OCI_DIR}/oci-layout" \
  "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/oci-layout" \
  --endpoint-url "${R2_ENDPOINT}"

UPLOADED_DIGESTS=""
TAGS_PUSHED=0
DIGESTS_PUSHED=0

while IFS= read -r entry; do
  REF=$(jq -r '.annotations["org.opencontainers.image.ref.name"] // empty' <<<"${entry}")
  DGST=$(jq -r '.digest' <<<"${entry}")
  FILE="${OCI_DIR}/blobs/sha256/${DGST#sha256:}"

  if [[ ! -f "${FILE}" ]]; then
    echo "❌ manifest blob not found: ${FILE}"
    exit 1
  fi

  MEDIA_TYPE=$(jq -r '.mediaType // empty' "${FILE}")
  CT=$(detect_ct "${MEDIA_TYPE}")

  if [[ -n "${REF}" ]]; then
    echo "▶ Upload manifest by tag: ${IMAGE_NAME}:${REF}  (${MEDIA_TYPE:-<none>})"
    aws s3 cp \
      "${FILE}" \
      "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/manifests/${REF}" \
      --endpoint-url "${R2_ENDPOINT}" \
      --content-type "${CT}"
    TAGS_PUSHED=$((TAGS_PUSHED + 1))
  fi

  if [[ ",${UPLOADED_DIGESTS}," != *",${DGST},"* ]]; then
    echo "▶ Upload manifest by digest: ${DGST}"
    aws s3 cp \
      "${FILE}" \
      "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/manifests/${DGST}" \
      --endpoint-url "${R2_ENDPOINT}" \
      --content-type "${CT}"
    UPLOADED_DIGESTS="${UPLOADED_DIGESTS},${DGST}"
    DIGESTS_PUSHED=$((DIGESTS_PUSHED + 1))
  fi
done < <(jq -c '.manifests[]' "${OCI_DIR}/index.json")

echo
echo "=== VERIFICATION ==="
echo "Tags (${TAGS_PUSHED}):"
jq -r '.manifests[] | .annotations["org.opencontainers.image.ref.name"] // empty' "${OCI_DIR}/index.json" \
  | while IFS= read -r ref; do
      [[ -z "${ref}" ]] && continue
      aws s3 ls "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/manifests/${ref}" \
        --endpoint-url "${R2_ENDPOINT}" || echo "  MISSING: ${ref}"
    done
echo
echo "Digests (${DIGESTS_PUSHED}):"
for d in ${UPLOADED_DIGESTS//,/ }; do
  [[ -z "${d}" ]] && continue
  aws s3 ls "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/manifests/${d}" \
    --endpoint-url "${R2_ENDPOINT}" || echo "  MISSING: ${d}"
done
echo
echo "Blob count:"
aws s3 ls "s3://${R2_BUCKET}/v2/${IMAGE_NAME}/blobs/sha256/" \
  --endpoint-url "${R2_ENDPOINT}" --recursive | wc -l | tr -d ' '

echo
echo "✅ PUSH SUCCESS"
echo "Image:    ${IMAGE_NAME}"
echo "Tags:     ${TAGS_PUSHED}"
echo "Digests:  ${DIGESTS_PUSHED}"
echo "Layout:   ${OCI_DIR}"

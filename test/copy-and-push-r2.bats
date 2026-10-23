#!/usr/bin/env bats
#
# Unit tests for copy-and-push-r2.sh.
#
# The script is executed as a subprocess with `nix-shell` and `aws` stubbed out
# (see helpers/stubs/), so these tests are fully offline: no skopeo, no R2, no
# credentials. Each case asserts on the process exit code, its output, or the
# arguments the stubs recorded.

bats_require_minimum_version 1.5.0

load 'helpers/oci-fixture'

REPO_ROOT="$(cd "${BATS_TEST_DIRNAME}/.." && pwd)"
SCRIPT="${REPO_ROOT}/copy-and-push-r2.sh"
ACTION_SCRIPT="${REPO_ROOT}/.github/actions/push-to-r2/copy-and-push-r2.sh"

OCI_MANIFEST="application/vnd.oci.image.manifest.v1+json"
OCI_INDEX="application/vnd.oci.image.index.v1+json"
DOCKER_V2="application/vnd.docker.distribution.manifest.v2+json"
DOCKER_LIST="application/vnd.docker.distribution.manifest.list.v2+json"

setup() {
  # Put stubs first on PATH.
  STUB_BIN="${BATS_TEST_TMPDIR}/bin"
  mkdir -p "$STUB_BIN"
  install -m 0755 "${BATS_TEST_DIRNAME}/helpers/stubs/nix-shell" "${STUB_BIN}/nix-shell"
  install -m 0755 "${BATS_TEST_DIRNAME}/helpers/stubs/aws" "${STUB_BIN}/aws"
  export PATH="${STUB_BIN}:${PATH}"

  export AWS_LOG="${BATS_TEST_TMPDIR}/aws.log"
  export STUB_NIX_LOG="${BATS_TEST_TMPDIR}/nix.log"
  : > "$AWS_LOG"
  : > "$STUB_NIX_LOG"

  # Never inherit the caller's configuration.
  unset IMAGE_NAME TAG SOURCE_TAGS SOURCE_IMAGE OCI_DIR COPY_ONLY PUSH_ONLY \
    PUSH_TAGS R2_BUCKET R2_ENDPOINT AWS_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY \
    AWS_DEFAULT_REGION MULTI_ARCH ARCH OS SRC_NO_CREDS \
    STUB_OCI_FIXTURE STUB_OCI_DIR STUB_AWS_FAIL_LS
}

# --- assertions -------------------------------------------------------------

assert_output_contains() {
  case "$output" in
    *"$1"*) ;;
    *)
      fail "expected output to contain: $1"$'\n'"--- output ---"$'\n'"$output"
      ;;
  esac
}

assert_output_matches() {
  printf '%s\n' "$output" | grep -Eq -- "$1" || \
    fail "expected output to match: $1"$'\n'"--- output ---"$'\n'"$output"
}

assert_log_contains() {
  local log="$1" needle="$2"
  grep -Fq -- "$needle" "$log" || \
    fail "expected $(basename "$log") to contain: $needle"$'\n'"--- log ---"$'\n'"$(cat "$log")"
}

refute_log_contains() {
  local log="$1" needle="$2"
  if grep -Fq -- "$needle" "$log"; then
    fail "expected $(basename "$log") NOT to contain: $needle"$'\n'"--- log ---"$'\n'"$(cat "$log")"
  fi
}

assert_aws_log_contains() { assert_log_contains "$AWS_LOG" "$1"; }
refute_aws_log_contains() { refute_log_contains "$AWS_LOG" "$1"; }
assert_nix_log_contains() { assert_log_contains "$STUB_NIX_LOG" "$1"; }
refute_nix_log_contains() { refute_log_contains "$STUB_NIX_LOG" "$1"; }

# Count `aws s3 cp` uploads whose arguments contain <needle>. Verification
# `aws s3 ls` calls also mention /manifests/, so they must be excluded.
count_manifest_uploads() {
  { grep -F 's3 cp' "$AWS_LOG" | grep -F -- "$1" || true; } | wc -l | tr -d ' '
}

# --- fixture helpers --------------------------------------------------------

# prepare_copy_fixture <dir>: valid single-manifest layout used by copy tests.
prepare_copy_fixture() {
  oci_init "$1"
  add_oci_manifest "$1" "$OCI_MANIFEST" latest >/dev/null
}

# prepare_push_fixture <dir> <media-type> [ref]
prepare_push_fixture() {
  local dir="$1" media_type="$2" ref="${3:-t}"
  oci_init "$dir"
  add_oci_manifest "$dir" "$media_type" "$ref" >/dev/null
}

# copy_run <out-dir> <extra env assignments...>
# Exports the fixture pointer, then runs the script in COPY_ONLY mode.
copy_run() {
  local out="$1"
  shift
  export STUB_OCI_FIXTURE="${BATS_TEST_TMPDIR}/fixture"
  export STUB_OCI_DIR="$out"
  run env IMAGE_NAME=nginx COPY_ONLY=1 OCI_DIR="$out" "$@" bash "$SCRIPT"
}

# push_run <oci-dir> [extra env assignments...]
push_run() {
  local dir="$1"
  shift
  run env IMAGE_NAME=nginx PUSH_ONLY=1 OCI_DIR="$dir" \
    AWS_ACCESS_KEY_ID=test-key \
    AWS_SECRET_ACCESS_KEY=test-secret \
    R2_BUCKET=test-bucket \
    R2_ENDPOINT=https://r2.example.invalid \
    "$@" bash "$SCRIPT"
}

# ============================================================================
# CLI / help
# ============================================================================

@test "help: --help prints usage and exits non-zero" {
  run bash "$SCRIPT" --help
  [ "$status" -eq 1 ]
  assert_output_contains "Usage:"
  assert_output_contains "COPY_ONLY=1"
  assert_output_contains "PUSH_TAGS"
}

@test "help: -h is an alias for --help" {
  run bash "$SCRIPT" -h
  [ "$status" -eq 1 ]
  assert_output_contains "Usage:"
}

# ============================================================================
# Validation
# ============================================================================

@test "validation: IMAGE_NAME is required" {
  run bash "$SCRIPT"
  [ "$status" -ne 0 ]
  assert_output_contains "IMAGE_NAME is required"
}

@test "validation: COPY_ONLY and PUSH_ONLY are mutually exclusive" {
  run env IMAGE_NAME=nginx TAG=latest COPY_ONLY=1 PUSH_ONLY=1 bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "COPY_ONLY and PUSH_ONLY are mutually exclusive"
}

@test "validation: SOURCE_TAGS and TAG are mutually exclusive" {
  run env IMAGE_NAME=nginx SOURCE_TAGS="1 2" TAG=latest bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "SOURCE_TAGS is mutually exclusive with TAG / SOURCE_IMAGE"
}

@test "validation: SOURCE_TAGS and SOURCE_IMAGE are mutually exclusive" {
  run env IMAGE_NAME=nginx SOURCE_TAGS="1 2" SOURCE_IMAGE=docker://x:y bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "SOURCE_TAGS is mutually exclusive with TAG / SOURCE_IMAGE"
}

@test "validation: TAG is required when not PUSH_ONLY and no SOURCE_TAGS" {
  run env IMAGE_NAME=nginx bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "TAG (or SOURCE_TAGS) is required when not PUSH_ONLY"
}

@test "validation: AWS_ACCESS_KEY_ID is required outside COPY_ONLY" {
  run env IMAGE_NAME=nginx TAG=latest bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "AWS_ACCESS_KEY_ID is required"
}

@test "validation: AWS_SECRET_ACCESS_KEY is required outside COPY_ONLY" {
  run env IMAGE_NAME=nginx TAG=latest AWS_ACCESS_KEY_ID=k bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "AWS_SECRET_ACCESS_KEY is required"
}

@test "validation: R2_BUCKET is required outside COPY_ONLY" {
  run env IMAGE_NAME=nginx TAG=latest \
    AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "R2_BUCKET is required"
}

@test "validation: R2_ENDPOINT is required outside COPY_ONLY" {
  run env IMAGE_NAME=nginx TAG=latest \
    AWS_ACCESS_KEY_ID=k AWS_SECRET_ACCESS_KEY=s R2_BUCKET=b bash "$SCRIPT"
  [ "$status" -eq 1 ]
  assert_output_contains "R2_ENDPOINT is required"
}

# ============================================================================
# Copy path (skopeo invocation, stubbed)
# ============================================================================

@test "copy: single tag uses default flags and default source" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" TAG=latest

  [ "$status" -eq 0 ]
  assert_output_contains "COPY SUCCESS"
  assert_nix_log_contains "skopeo copy --format oci --override-os linux --src-no-creds --multi-arch all docker://nginx:latest oci:${out}:latest"
}

@test "copy: SOURCE_IMAGE overrides the default source" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" TAG=tag SRC_NO_CREDS=0 \
    SOURCE_IMAGE=docker://registry.fly.io/myapp:tag

  [ "$status" -eq 0 ]
  assert_nix_log_contains "docker://registry.fly.io/myapp:tag oci:${out}:tag"
}

@test "copy: SRC_NO_CREDS=0 omits --src-no-creds" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" TAG=latest SRC_NO_CREDS=0

  [ "$status" -eq 0 ]
  refute_nix_log_contains "--src-no-creds"
}

@test "copy: ARCH pins a single arch and drops --multi-arch" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" TAG=latest ARCH=arm64 MULTI_ARCH=system

  [ "$status" -eq 0 ]
  assert_nix_log_contains "--override-arch arm64"
  refute_nix_log_contains "--multi-arch"
}

@test "copy: MULTI_ARCH is forwarded to skopeo" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" TAG=latest MULTI_ARCH=system

  [ "$status" -eq 0 ]
  assert_nix_log_contains "--multi-arch system"
}

@test "copy: OS overrides the source OS" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" TAG=latest OS=windows

  [ "$status" -eq 0 ]
  assert_nix_log_contains "--override-os windows"
}

@test "copy: SOURCE_TAGS copies every tag into the layout" {
  local out="${BATS_TEST_TMPDIR}/out"
  prepare_copy_fixture "${BATS_TEST_TMPDIR}/fixture"

  copy_run "$out" SOURCE_TAGS="1.25 1.26 latest"

  [ "$status" -eq 0 ]
  [ "$(grep -c 'skopeo copy' "$STUB_NIX_LOG")" -eq 3 ]
  assert_nix_log_contains "docker://nginx:1.25 oci:${out}:1.25"
  assert_nix_log_contains "docker://nginx:1.26 oci:${out}:1.26"
  assert_nix_log_contains "docker://nginx:latest oci:${out}:latest"
  assert_output_contains "  - nginx:1.25"
  assert_output_contains "  - nginx:1.26"
  assert_output_contains "  - nginx:latest"
  assert_output_contains "COPY SUCCESS"
}

# ============================================================================
# Push path: detect_ct() content-type mapping
# ============================================================================

@test "push: OCI image index maps to index content-type" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$OCI_INDEX"

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_aws_log_contains "--content-type application/vnd.oci.image.index.v1+json"
}

@test "push: OCI image manifest maps to manifest content-type" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$OCI_MANIFEST"

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_aws_log_contains "--content-type application/vnd.oci.image.manifest.v1+json"
}

@test "push: docker manifest list maps to list content-type" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$DOCKER_LIST"

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_aws_log_contains "--content-type application/vnd.docker.distribution.manifest.list.v2+json"
}

@test "push: docker manifest v2 maps to docker v2 content-type" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$DOCKER_V2"

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_aws_log_contains "--content-type application/vnd.docker.distribution.manifest.v2+json"
}

@test "push: missing mediaType falls back to OCI manifest content-type" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" ""

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_aws_log_contains "--content-type application/vnd.oci.image.manifest.v1+json"
}

# ============================================================================
# Push path: upload behaviour
# ============================================================================

@test "push: uploads blobs, oci-layout and runs verification" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$OCI_MANIFEST" latest

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_aws_log_contains "s3 sync"
  assert_aws_log_contains "s3://test-bucket/v2/nginx/blobs"
  assert_aws_log_contains "s3://test-bucket/v2/nginx/oci-layout"
  assert_aws_log_contains "/manifests/latest"
  assert_output_contains "=== VERIFICATION ==="
  assert_output_contains "Blob count:"
  assert_output_contains "PUSH SUCCESS"
}

@test "push: tags sharing a digest upload the digest only once" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  oci_init "$dir"
  add_oci_manifest "$dir" "$OCI_MANIFEST" v1 >/dev/null
  add_oci_manifest "$dir" "$OCI_MANIFEST" latest >/dev/null

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_output_matches '^Tags: +2$'
  assert_output_matches '^Digests: +1$'
  [ "$(count_manifest_uploads '/manifests/')" -eq 3 ]

  local digest
  digest="$(jq -r '.manifests[0].digest' "$dir/index.json")"
  [ "$(count_manifest_uploads "manifests/${digest}")" -eq 1 ]
  [ "$(count_manifest_uploads 'manifests/v1')" -eq 1 ]
  [ "$(count_manifest_uploads 'manifests/latest')" -eq 1 ]
}

@test "push: entry without ref is uploaded by digest only" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  oci_init "$dir"
  add_oci_manifest "$dir" "$OCI_MANIFEST" >/dev/null

  push_run "$dir"

  [ "$status" -eq 0 ]
  assert_output_matches '^Tags: +0$'
  assert_output_matches '^Digests: +1$'
  assert_output_contains "Tags (0):"
  [ "$(count_manifest_uploads '/manifests/')" -eq 1 ]

  local digest
  digest="$(jq -r '.manifests[0].digest' "$dir/index.json")"
  assert_aws_log_contains "/manifests/${digest}"
}

@test "push: PUSH_TAGS overrides refs baked into the layout" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$OCI_MANIFEST" original
  local digest
  digest="$(jq -r '.manifests[0].digest' "$dir/index.json")"

  push_run "$dir" PUSH_TAGS="v1 v2"

  [ "$status" -eq 0 ]
  assert_output_contains "PUSH_TAGS override: v1 v2"
  assert_output_matches '^Tags: +2$'
  assert_output_matches '^Digests: +1$'
  assert_aws_log_contains "/manifests/v1 "
  assert_aws_log_contains "/manifests/v2 "
  assert_aws_log_contains "/manifests/${digest}"
  refute_aws_log_contains "/manifests/original"
}

# ============================================================================
# Error paths
# ============================================================================

@test "error: PUSH_ONLY with a missing OCI_DIR" {
  local dir="${BATS_TEST_TMPDIR}/does-not-exist"

  push_run "$dir"

  [ "$status" -eq 1 ]
  assert_output_contains "OCI_DIR not found"
}

@test "error: directory without index.json is not an OCI layout" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  mkdir -p "$dir"
  printf '{"imageLayoutVersion":"1.0.0"}' > "$dir/oci-layout"

  push_run "$dir"

  [ "$status" -eq 1 ]
  assert_output_contains "not an OCI layout"
  assert_output_contains "index.json missing"
}

@test "error: index.json with zero manifests" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  oci_init "$dir"

  push_run "$dir"

  [ "$status" -eq 1 ]
  assert_output_contains "no manifests in"
}

@test "error: index entry pointing at a missing manifest blob" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$OCI_MANIFEST" latest
  rm -f "$dir"/blobs/sha256/*

  push_run "$dir"

  [ "$status" -eq 1 ]
  assert_output_contains "manifest blob not found"
  refute_aws_log_contains "/manifests/"
}

@test "error: PUSH_TAGS with a missing primary manifest blob" {
  local dir="${BATS_TEST_TMPDIR}/oci"
  prepare_push_fixture "$dir" "$OCI_MANIFEST" latest
  rm -f "$dir"/blobs/sha256/*

  push_run "$dir" PUSH_TAGS="v1"

  [ "$status" -eq 1 ]
  assert_output_contains "primary manifest blob not found"
}

# ============================================================================
# Repo consistency
# ============================================================================

@test "scripts: root and composite-action copies are identical" {
  run cmp -s "$SCRIPT" "$ACTION_SCRIPT"
  if [ "$status" -ne 0 ]; then
    fail "scripts differ:"$'\n'"$(diff -u "$SCRIPT" "$ACTION_SCRIPT" || true)"
  fi
}

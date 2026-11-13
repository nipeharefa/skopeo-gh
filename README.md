# skopeo → R2 pipeline

Pipeline for copying container images from any registry into **Cloudflare R2** as an OCI layout, then serving them back as an OCI/Docker registry via a **Cloudflare Worker**.

## Architecture

```
[Source Registry]                        [Cloudflare R2]                  [Client]
 docker://nginx ──┐                    ┌─ v2/<image>/blobs/         ┌─ skopeo copy
                  │                    ├─ v2/<image>/manifests/<tag>│  docker pull
                  ▼                    ├─ v2/<image>/manifests/<dgst>▼
        ┌─────────────────┐           └─────────────────┘    ┌──────────────────┐
        │ copy-and-push   │ ── aws s3 ────────────────────►   │ worker.js        │
        │   -r2.sh        │            sync                   │ (OCI registry)   │
        │ (skopeo copy)   │                                  │                  │
        └─────────────────┘                                  └──────────────────┘
              ▲                                                       │
              │                                                       ▼
        [local OCI layout]                                      GET/HEAD /v2/...
        tmp/<image>/
          index.json
          oci-layout
          blobs/sha256/...
```

## Prerequisites

| Tool | How to install it in this repo |
|---|---|
| `nix-shell` + `skopeo` | automatically via `nix-shell -p skopeo` (handled by the script) |
| `aws-cli` v2 | already installed at `~/.nix-profile/bin/aws` |
| `jq` | for parsing the OCI index.json |
| `colima` (optional) | only if you want to load images into the local docker daemon |

Check with:
```bash
nix-shell --version && aws --version && jq --version
```

## Files in this repo

| File | Purpose |
|---|---|
| `copy-and-push-r2.sh` | Main script: copy the image via skopeo + push to R2 |
| `worker.js` | Cloudflare Worker: serves R2 as an OCI/Docker registry (patched, multi-arch compatible) |
| `.github/actions/push-to-r2/` | Composite GitHub Action for `PUSH_ONLY` mode (reusable from other repos) |
| `test/` | bats unit tests for `copy-and-push-r2.sh` (offline: `nix-shell` and `aws` are stubbed) |
| `Makefile` | `make test` to run the suite |
| `.github/images.yaml` | List of source images to copy, scan, and push |
| `.github/workflows/scan-push.yaml` | Manual pipeline (no schedule): copy → Trivy scan → push R2 per image |
| `sample/` | Sample OCI layout for `nginx:alpine` (linux/arm64, single-arch manifest) |

## Quick start

### 1. Copy + push a single tag
```bash
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
R2_BUCKET=my-bucket \
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
IMAGE_NAME=nginx TAG=latest \
./copy-and-push-r2.sh
```

### 2. Copy + push multiple tags at once
```bash
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
R2_BUCKET=my-bucket \
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
IMAGE_NAME=nginx SOURCE_TAGS="1.25 1.26 latest" \
./copy-and-push-r2.sh
```

### 3. Copy only (no R2 creds)
```bash
COPY_ONLY=1 IMAGE_NAME=nginx SOURCE_TAGS="1.25 1.26 latest" \
OCI_DIR=./multi ./copy-and-push-r2.sh
```

### 4. Push only from an existing layout
```bash
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
R2_BUCKET=my-bucket \
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
PUSH_ONLY=1 OCI_DIR=./multi IMAGE_NAME=nginx \
./copy-and-push-r2.sh
```

### 5. Copy from a private registry (fly.io, GCR, ECR, etc.)
Make sure you are logged in (`flyctl auth docker`, `docker login`, etc.) so the token is stored in `~/.docker/config.json`. Then set `SRC_NO_CREDS=0`:
```bash
SRC_NO_CREDS=0 COPY_ONLY=1 \
SOURCE_IMAGE=docker://registry.fly.io/myapp:tag \
IMAGE_NAME=myapp TAG=tag OCI_DIR=./tmp-myapp \
./copy-and-push-r2.sh
```

## Unit tests

The script is tested with [bats-core](https://github.com/bats-core/bats-core) offline: `nix-shell` and `aws` are replaced by stubs, and an OCI layout is created as a fixture. No skopeo, network, or R2 credentials are required.

```bash
make test          # run all tests
make test-verbose  # show passing test output
```

Prerequisites: `bats` and `jq`.

```bash
brew install bats-core jq          # macOS
sudo apt-get install -y bats jq    # Debian/Ubuntu
```

Coverage: env validation, skopeo flag assembly, `detect_ct()` mapping, tag/digest upload + dedup, `PUSH_TAGS` override, and every OCI layout error path. CI runs it in `.github/workflows/test.yaml` (Ubuntu + macOS).

## Operation modes

| Mode | Flag | skopeo copy | R2 push | AWS creds |
|---|---|---|---|---|
| Copy + push | (default) | ✅ | ✅ | required |
| Copy only | `COPY_ONLY=1` | ✅ | ❌ | not needed |
| Push only | `PUSH_ONLY=1` | ❌ | ✅ | required |

Rules:
- `COPY_ONLY` and `PUSH_ONLY` are mutually exclusive.
- `SOURCE_TAGS` and (`TAG` / `SOURCE_IMAGE`) are mutually exclusive.
- Without `SOURCE_TAGS` and without `PUSH_ONLY` → `TAG` is required (single-tag mode).

## Environment variables

### Required (unless `COPY_ONLY=1`)
| Var | Description |
|---|---|
| `AWS_ACCESS_KEY_ID` | R2 access key |
| `AWS_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET` | R2 bucket name |
| `R2_ENDPOINT` | R2 S3 endpoint URL (`https://<account_id>.r2.cloudflarestorage.com`) |

### Required (mode-dependent)
| Var | Description |
|---|---|
| `IMAGE_NAME` | image name in the target registry (e.g. `nginx`, `pneuma-backend`) |
| `TAG` | single tag (required unless using `SOURCE_TAGS` or `PUSH_ONLY`) |
| `SOURCE_TAGS` | space-separated list of tags (e.g. `"1.25 1.26 latest"`) |

### Optional
| Var | Default | Description |
|---|---|---|
| `SOURCE_IMAGE` | `docker://<IMAGE_NAME>:<TAG>` | full source image including the transport |
| `OCI_DIR` | `./tmp/<IMAGE_NAME>` | local OCI layout folder |
| `MULTI_ARCH` | `all` | `skopeo --multi-arch` value (`all` / `system` / `copy`) |
| `ARCH` | (empty) | pin arch (`amd64` / `arm64`), overrides `MULTI_ARCH` |
| `OS` | `linux` | override the source OS |
| `SRC_NO_CREDS` | `1` | set `0` to use auth from `~/.docker/config.json` (private registries like fly.io/GCR/ECR) |
| `AWS_DEFAULT_REGION` | `auto` | region |

## Multi-version workflow (recommended)

Separate copy and push so the source registry is hit only once, then push all versions at once:

```bash
# Phase 1: pull 3 versions into one OCI folder (blobs dedup automatically)
COPY_ONLY=1 \
  IMAGE_NAME=nginx \
  SOURCE_TAGS="1.25-alpine 1.26-alpine latest" \
  OCI_DIR=./multi-nginx \
  ./copy-and-push-r2.sh

# Phase 2: push all tags + digests to R2 (blobs synced once)
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
  R2_BUCKET=my-bucket \
  R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
  PUSH_ONLY=1 \
  IMAGE_NAME=nginx \
  OCI_DIR=./multi-nginx \
  ./copy-and-push-r2.sh
```

Result in R2:
```
v2/nginx/blobs/sha256/...                  # all blobs (config, layer, manifest)
v2/nginx/manifests/1.25-alpine             # tag → manifest file
v2/nginx/manifests/1.26-alpine
v2/nginx/manifests/latest
v2/nginx/manifests/sha256:<digest-1>       # manifest by digest (dedup)
v2/nginx/manifests/sha256:<digest-2>
v2/nginx/oci-layout
```

Dedup: when two tags point to the same manifest (e.g. `latest` and `1.26-alpine` are identical images), both tags are still uploaded as 2 keys, but the manifest by digest is uploaded only once.

## GitHub Actions (reusable)

This repo provides a composite action for `PUSH_ONLY` mode that can be used from any repo:

```yaml
- uses: nipeharefa/skopeo/.github/actions/push-to-r2@v1
  env:
    AWS_ACCESS_KEY_ID: ${{ secrets.R2_AWS_ACCESS_KEY_ID }}
    AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_AWS_SECRET_ACCESS_KEY }}
  with:
    image-name: myapp
    oci-dir: ./tmp/myapp
    r2-bucket: ${{ vars.R2_BUCKET }}
    r2-endpoint: ${{ vars.R2_ENDPOINT }}
```

The caller is responsible for building the OCI layout (e.g. via `docker buildx build --output type=oci,oci-layout=true,dest=./tmp/myapp .`) before calling this action.

Full details (inputs, setting up secrets/vars in the caller repo, multi-arch example, security, pinning): see [`.github/actions/push-to-r2/README.md`](.github/actions/push-to-r2/README.md).

One-time setup in the caller repo → **Settings → Secrets and variables → Actions**:

- **Secrets:** `R2_AWS_ACCESS_KEY_ID`, `R2_AWS_SECRET_ACCESS_KEY`
- **Variables:** `R2_BUCKET`, `R2_ENDPOINT`

### Sample: build with `docker/build-push-action` → R2

If the caller already uses [`docker/build-push-action`](https://github.com/docker/build-push-action), just point `outputs` at an OCI layout (instead of pushing to a registry) and pass it to the `push-to-r2` composite action:

```yaml
name: build-oci-push-r2

on:
  push:
    tags: ['v*']

jobs:
  build-and-push:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4

      - name: Set up Docker Buildx
        uses: docker/setup-buildx-action@v3

      - name: Build OCI layout
        uses: docker/build-push-action@v6
        with:
          context: .
          file: ./Dockerfile
          tags: myapp:${{ github.ref_name }}
          outputs: type=oci,oci-layout=true,dest=./tmp/myapp

      - name: Push to R2
        uses: nipeharefa/skopeo/.github/actions/push-to-r2@v1
        env:
          AWS_ACCESS_KEY_ID: ${{ secrets.R2_AWS_ACCESS_KEY_ID }}
          AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_AWS_SECRET_ACCESS_KEY }}
        with:
          image-name: myapp
          oci-dir: ./tmp/myapp
          r2-bucket: ${{ vars.R2_BUCKET }}
          r2-endpoint: ${{ vars.R2_ENDPOINT }}
```

Notes:

- `outputs: type=oci,oci-layout=true,dest=./tmp/myapp` produces an OCI image layout in a folder — it does **not** push to any registry, so `push: false` or registry creds are not needed. The `oci-dir` value in the next step must match `dest` here **exactly**.
- `tags: myapp:...` is required so the `org.opencontainers.image.ref.name` annotation is written to `index.json`; without it the tag will not be uploaded to R2 (see the action's troubleshooting section).
- Multi-arch: add `platforms: linux/amd64,linux/arm64` — buildx automatically produces an OCI image **index**, and `detect_ct()` in the script maps it to `application/vnd.oci.image.index.v1+json`. The patched worker (`worker.js` in this repo) is required to serve multi-arch images.
- buildx cache (optional): add `cache-from`/`cache-to` as usual; it does not affect the OCI layout output.

## Pipeline: YAML → scan → R2

`.github/workflows/scan-push.yaml` reads `.github/images.yaml`, then runs the copy → scan → push flow for each entry:

1. `prepare`: read `images.yaml` with Ruby's YAML stdlib, validate the entries, and produce a matrix of `{source, image, tag, oci_dir}`.
2. Per image (matrix, `fail-fast: false`): `actions/checkout@v7`, install `skopeo` + `jq`, then copy the image into an OCI layout via `copy-and-push-r2.sh` (`COPY_ONLY=1`).
3. Scan with Trivy (`CRITICAL,HIGH`, `ignore-unfixed`). The SARIF result is uploaded to code scanning (category `trivy-<image>`) and as an artifact.
4. Push the OCI layout to R2 via the `push-to-r2` composite action using the tag from the config.

Trigger: **manual only** (`workflow_dispatch`); there is no schedule. Inputs:

| Input | Default | Purpose |
|---|---|---|
| `only` | empty | Process only one target `image` (e.g. `alpine`); empty = all |
| `severity` | `CRITICAL,HIGH` | Trivy severity that fails the push |
| `fail-on-findings` | `true` | `false` = push anyway despite findings |

Format of `.github/images.yaml`:

```yaml
images:
  - source: mirror.gcr.io/library/alpine:3.21
    image: alpine
  - source: gcr.io/distroless/nodejs26-debian13:latest
    image: nodejs26-debian13
```

- `source`: full ref including registry and tag (or digest). Any registry pullable through skopeo's `docker://` transport — `docker.io`, `quay.io`, `ghcr.io`, `gcr.io`, `mirror.gcr.io`, etc.
- `image`: target name in R2 (`v2/<image>/...`). Required, lowercase, registry-safe.
- `tag`: optional; defaults to the tag in `source`. Required when `source` uses a digest (`@sha256:...`).

Entries with a duplicate `image:tag` are rejected. The push is skipped when Trivy finds vulnerabilities; set `fail-on-findings=false` to push anyway.

For a quick check, run manually with `only: alpine`.

Requires the same secrets as the `push-to-r2` action:

- Secrets: `R2_AWS_ACCESS_KEY_ID`, `R2_AWS_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`

Note: the Ubuntu runner does not have Nix, so the workflow creates a small `nix-shell` shim that runs the `--run` command using the apt-installed `skopeo`.

## R2 key structure

Identical across all modes, so it stays compatible with `worker.js`:

```
v2/<image>/blobs/sha256/<hash>          # blob (config, layers, manifest)
v2/<image>/manifests/<tag>              # manifest by tag
v2/<image>/manifests/sha256:<hash>      # manifest by digest
v2/<image>/oci-layout
```

## Worker (`worker.js`)

The worker reads from R2 and serves OCI Registry v2 endpoints:
- `GET/HEAD /v2/` → ping
- `GET/HEAD /v2/<image>/manifests/<reference>` → manifest (tag or digest)
- `GET/HEAD /v2/<image>/blobs/sha256/<hash>` → blob

### Important patch (already applied in this file)

The original worker **hardcodes** `Content-Type: application/vnd.oci.image.manifest.v1+json`. This breaks multi-arch images (whose manifest is an OCI image **index**). The patch in this file adds a function:

```js
function manifestContentType(mediaType) {
  if (mediaType?.includes('oci.image.index'))              return '...index.v1+json';
  if (mediaType?.includes('docker.distribution.manifest.list')) return '...list.v2+json';
  if (mediaType?.includes('docker.distribution.manifest.v2'))   return '...v2+json';
  return 'application/vnd.oci.image.manifest.v1+json'; // default = old behavior
}
```

The default stays the manifest type → **backward-compatible** with already-deployed images. For multi-arch images (`MULTI_ARCH=all` output), the worker automatically serves the index Content-Type.

### Deploy

`worker.js` in this repo is a working copy. Copy it to the original Cloudflare Worker project, then:
```bash
wrangler deploy
```

Make sure `wrangler.toml` has the R2 binding:
```toml
[[r2_buckets]]
binding = "OCI_BUCKET"
bucket_name = "<your-bucket-name>"
```

## Pull back from the worker

After deploying the worker, images can be pulled via skopeo or docker:

```bash
# via skopeo (anonymous, no creds)
nix-shell -p skopeo --run \
  "skopeo copy --src-no-creds --dest-oci-mediatypes=true \
   docker://<worker-host>/nginx:latest oci:./pull-test:latest"

# via docker (colima)
docker pull <worker-host>/nginx:latest
```

## Gotchas & limitations

1. **Multi-arch requires the patched worker** — the original worker cannot serve image indexes correctly. Use the `worker.js` from this repo.
2. **Anonymous auth on the worker** — the worker does not implement auth. Suitable for public images, **not** for private ones.
3. **Range requests are not handled** — the worker still sets `Accept-Ranges: bytes` but streams the full body. Wasteful bandwidth for large layers.
4. **`MULTI_ARCH=all` on nginx produces 16 sub-images** → large size. To save bandwidth, consider `ARCH=amd64` (or `arm64`) when the target platform is known.
5. **An expired Docker Hub PAT** in `~/.docker/config.json` will be used by skopeo by default. The script uses `--src-no-creds` to bypass it. For private sources, remove `--src-no-creds` or provide your own auth file.
6. **Darwin host** requires `--override-os linux` (already automatic in the script).

## Troubleshooting

| Error | Cause | Fix |
|---|---|---|
| `unknown flag: --dest-oci-mediatypes` | skopeo 1.23+ removed that flag | the script uses `--format oci` (replacement) |
| `incorrect username/password` on Docker Hub | expired PAT in `~/.docker/config.json` | `--src-no-creds` is automatic; or update the PAT |
| `no image found ... OS "darwin"` | host = macOS | `--override-os linux` is automatic |
| `choosing an image from manifest list ... no image found for architecture` | source has no binary for the target arch | set `ARCH=<arch>` available in the source |
| `manifest blob not found` | OCI_DIR is corrupt / incomplete | delete the folder, re-run the copy |
| aws `AccessDenied` | wrong R2 creds / no bucket access | check `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` and the bucket policy |
| `The Authorization header is malformed` | wrong region | set `AWS_DEFAULT_REGION=auto` |

## Manual verification

```bash
# check the R2 structure
aws s3 ls s3://${R2_BUCKET}/v2/nginx/ --endpoint-url ${R2_ENDPOINT} --recursive

# check a specific manifest
aws s3 cp s3://${R2_BUCKET}/v2/nginx/manifests/latest - \
  --endpoint-url ${R2_ENDPOINT} | jq '.mediaType'
```

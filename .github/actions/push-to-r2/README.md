# push-to-r2

Composite GitHub Action that runs [`copy-and-push-r2.sh`](../../../copy-and-push-r2.sh) in `PUSH_ONLY` mode, uploading an existing OCI image layout to a Cloudflare R2 bucket so it can be served as an OCI/Docker registry via the bundled [`worker.js`](../../../worker.js).

Use this as a single step inside any job that has already produced an OCI layout (typically via `docker buildx build --output type=oci,oci-layout=true`).

## Inputs

| Input | Required | Description |
|---|---|---|
| `image-name` | yes | Target image name in the registry (e.g. `myapp`). Becomes the `v2/<image-name>/...` prefix in R2. |
| `oci-dir` | yes | Local OCI layout directory containing `index.json`, `oci-layout`, and `blobs/sha256/...`. |
| `r2-bucket` | yes | Cloudflare R2 bucket name. |
| `r2-endpoint` | yes | Cloudflare R2 S3 endpoint URL (`https://<account_id>.r2.cloudflarestorage.com`). |
| `aws-region` | no | AWS region for S3 API calls. Default: `auto`. |

## Required environment

The action expects `AWS_ACCESS_KEY_ID` and `AWS_SECRET_ACCESS_KEY` to be present in the job's environment. Pass them from caller secrets:

```yaml
env:
  AWS_ACCESS_KEY_ID: ${{ secrets.R2_AWS_ACCESS_KEY_ID }}
  AWS_SECRET_ACCESS_KEY: ${{ secrets.R2_AWS_SECRET_ACCESS_KEY }}
```

The script reads these env vars directly and exports them before calling `aws s3`. No `aws-actions/configure-aws-credentials` step is needed.

## Caller setup

In the calling repository, go to **Settings → Secrets and variables → Actions**:

**Secrets** (sensitive):

- `R2_AWS_ACCESS_KEY_ID` — R2 access key
- `R2_AWS_SECRET_ACCESS_KEY` — R2 secret key

**Variables** (non-sensitive config; could also be secrets if you prefer):

- `R2_BUCKET` — R2 bucket name
- `R2_ENDPOINT` — R2 S3 endpoint URL

## Usage

### Minimal single-arch example

```yaml
name: build-and-push

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
        run: |
          docker buildx build \
            -f Dockerfile \
            -t myapp:${{ github.ref_name }} \
            --output type=oci,oci-layout=true,dest=./tmp/myapp \
            .

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

### Multi-arch example

```yaml
- name: Build multi-arch OCI layout
  run: |
    docker buildx build \
      --platform linux/amd64,linux/arm64 \
      -f Dockerfile \
      -t myapp:latest \
      --output type=oci,oci-layout=true,dest=./tmp/myapp \
      .

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

The action handles multi-arch automatically — `buildx` produces an OCI image **index** at `index.json`, and the script's `detect_ct()` function maps the index to `application/vnd.oci.image.index.v1+json` for the manifest upload.

## What the action does

1. Verifies the OCI layout is complete (`index.json` + `oci-layout` present).
2. Runs `copy-and-push-r2.sh` with `PUSH_ONLY=1`, which:
   - `aws s3 sync` uploads `blobs/` to `s3://<bucket>/v2/<image>/blobs/`.
   - `aws s3 cp` uploads `oci-layout`.
   - For each entry in `index.json`, uploads the manifest by tag (from the `org.opencontainers.image.ref.name` annotation) and by digest, with the correct `Content-Type` derived from the manifest's `mediaType`.
   - Runs a verification pass that lists the uploaded keys.

## Producing the OCI layout

The action does **not** build anything. The caller must produce a directory with this structure:

```
<oci-dir>/
  index.json
  oci-layout
  blobs/
    sha256/
      <config-digest>
      <layer-digest-1>
      <layer-digest-2>
      <manifest-digest>
```

Any tool that emits a standard OCI image layout works:

- `docker buildx build --output type=oci,oci-layout=true,dest=<dir>` (recommended)
- `buildctl build --output type=oci,oci-layout=true,dest=<dir>`
- `skopeo copy ... oci:<dir>:<tag>` (also from this repo's script, in `COPY_ONLY` mode)

## Security

- **No secrets or account-specific values are baked into this action.** All R2 connection details come from the caller via inputs.
- AWS credentials are passed via `env:` (never via `with:`) so they don't appear in workflow input breadcrumbs.
- The script verifies the OCI layout before any upload, preventing partial pushes from corrupted inputs.
- Caller should set `permissions: contents: read` (or tighter) — this action needs no GitHub API access.
- The R2 credentials used should have the minimum permissions needed: `s3:PutObject`, `s3:ListBucket`, `s3:GetObject` on the target bucket only.

## Pinning

Pin to a tagged release (`@v1`, `@v1.2`, or `@v1.2.3`) rather than `@main`. The `@main` branch can change at any time and a future commit could change behavior in ways that break caller workflows.

For maximum supply-chain safety, pin to a full commit SHA:

```yaml
- uses: nipeharefa/skopeo/.github/actions/push-to-r2@<full-commit-sha>
```

## Action permissions on caller side

If the calling repository has **Settings → Actions → General → Action permissions** set to "Allow select actions and reusable workflows", you must add `nipeharefa/skopeo` to the allowlist.

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `OCI layout incomplete at ...` | `oci-dir` missing or build step didn't produce an OCI layout | Verify the `--output type=oci,oci-layout=true,dest=...` flag matches `oci-dir` exactly. |
| `R2_BUCKET is required` / `R2_ENDPOINT is required` | Inputs not passed or empty | Check the `with:` block; ensure `vars.R2_BUCKET` / `vars.R2_ENDPOINT` are defined. |
| `AccessDenied` from `aws s3` | Wrong creds or insufficient R2 token permissions | Verify `R2_AWS_ACCESS_KEY_ID` / `R2_AWS_SECRET_ACCESS_KEY` and the R2 API token's permissions. |
| `manifest blob not found` | OCI layout was modified between build and push | Re-run from a clean checkout. |
| Tag not visible after push | `org.opencontainers.image.ref.name` annotation missing from `index.json` | Ensure the build used `-t <name>:<tag>`; without it, buildx writes an anonymous ref. |

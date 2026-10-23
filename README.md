# skopeo → R2 pipeline

Pipeline untuk menyalin container image dari registry manapun ke **Cloudflare R2** dengan format OCI layout, dan menyajikannya kembali sebagai OCI/Docker registry via **Cloudflare Worker**.

## Arsitektur

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
        [OCI layout lokal]                                  GET/HEAD /v2/...
        tmp/<image>/
          index.json
          oci-layout
          blobs/sha256/...
```

## Prasyarat

| Tool | Cara install di repo ini |
|---|---|
| `nix-shell` + `skopeo` | otomatis via `nix-shell -p skopeo` (sudah di-handle script) |
| `aws-cli` v2 | sudah terinstall di `~/.nix-profile/bin/aws` |
| `jq` | untuk parsing OCI index.json |
| `colima` (opsional) | hanya kalau mau load image ke docker daemon lokal |

Cek dengan:
```bash
nix-shell --version && aws --version && jq --version
```

## File di repo ini

| File | Fungsi |
|---|---|
| `copy-and-push-r2.sh` | Script utama: copy image via skopeo + push ke R2 |
| `worker.js` | Cloudflare Worker: serve R2 sebagai OCI/Docker registry (patched, multi-arch compatible) |
| `.github/actions/push-to-r2/` | Composite GitHub Action untuk mode `PUSH_ONLY` (reusable dari repo lain) |
| `test/` | Unit test bats untuk `copy-and-push-r2.sh` (offline: `nix-shell` + `aws` di-stub) |
| `Makefile` | `make test` untuk menjalankan suite |
| `.github/workflows/nginx-scan-push.yaml` | Pipeline nginx: copy → Trivy scan → push R2 |
| `sample/` | Contoh OCI layout `nginx:alpine` (linux/arm64, single-arch manifest) |

## Quick start

### 1. Copy + push single tag
```bash
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
R2_BUCKET=my-bucket \
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
IMAGE_NAME=nginx TAG=latest \
./copy-and-push-r2.sh
```

### 2. Copy + push multi tag sekaligus
```bash
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
R2_BUCKET=my-bucket \
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
IMAGE_NAME=nginx SOURCE_TAGS="1.25 1.26 latest" \
./copy-and-push-r2.sh
```

### 3. Copy saja (tanpa R2 creds)
```bash
COPY_ONLY=1 IMAGE_NAME=nginx SOURCE_TAGS="1.25 1.26 latest" \
OCI_DIR=./multi ./copy-and-push-r2.sh
```

### 4. Push saja dari layout existing
```bash
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
R2_BUCKET=my-bucket \
R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
PUSH_ONLY=1 OCI_DIR=./multi IMAGE_NAME=nginx \
./copy-and-push-r2.sh
```

### 5. Copy dari private registry (fly.io, GCR, ECR, dll)
Pastikan sudah login (`flyctl auth docker`, `docker login`, dll) sehingga token tersimpan di `~/.docker/config.json`. Lalu set `SRC_NO_CREDS=0`:
```bash
SRC_NO_CREDS=0 COPY_ONLY=1 \
SOURCE_IMAGE=docker://registry.fly.io/myapp:tag \
IMAGE_NAME=myapp TAG=tag OCI_DIR=./tmp-myapp \
./copy-and-push-r2.sh
```

## Unit test

Script diuji dengan [bats-core](https://github.com/bats-core/bats-core) secara offline: `nix-shell` dan `aws` diganti stub, dan layout OCI dibuat sebagai fixture. Tidak butuh skopeo, network, atau kredensial R2.

```bash
make test          # jalankan semua test
make test-verbose  # tampilkan output test yang lulus
```

Prasyarat: `bats` dan `jq`.

```bash
brew install bats-core jq          # macOS
sudo apt-get install -y bats jq    # Debian/Ubuntu
```

Cakupan: validasi env, penyusunan flag skopeo, mapping `detect_ct()`, upload tag/digest + dedup, override `PUSH_TAGS`, dan semua error path layout OCI. CI menjalankannya di `.github/workflows/test.yaml` (Ubuntu + macOS).

## Mode operasi

| Mode | Flag | skopeo copy | R2 push | AWS creds |
|---|---|---|---|---|
| Copy + push | (default) | ✅ | ✅ | wajib |
| Copy only | `COPY_ONLY=1` | ✅ | ❌ | tidak |
| Push only | `PUSH_ONLY=1` | ❌ | ✅ | wajib |

Aturan:
- `COPY_ONLY` dan `PUSH_ONLY` mutually exclusive.
- `SOURCE_TAGS` dan (`TAG` / `SOURCE_IMAGE`) mutually exclusive.
- Tanpa `SOURCE_TAGS` & tanpa `PUSH_ONLY` → `TAG` wajib (mode single-tag).

## Environment variables

### Required (unless `COPY_ONLY=1`)
| Var | Keterangan |
|---|---|
| `AWS_ACCESS_KEY_ID` | R2 access key |
| `AWS_SECRET_ACCESS_KEY` | R2 secret key |
| `R2_BUCKET` | nama R2 bucket |
| `R2_ENDPOINT` | R2 S3 endpoint URL (`https://<account_id>.r2.cloudflarestorage.com`) |

### Required (mode-dependent)
| Var | Keterangan |
|---|---|
| `IMAGE_NAME` | nama image di registry target (mis. `nginx`, `pneuma-backend`) |
| `TAG` | tag tunggal (wajib kecuali pakai `SOURCE_TAGS` atau `PUSH_ONLY`) |
| `SOURCE_TAGS` | daftar tag dipisah spasi (mis. `"1.25 1.26 latest"`) |

### Optional
| Var | Default | Keterangan |
|---|---|---|
| `SOURCE_IMAGE` | `docker://<IMAGE_NAME>:<TAG>` | source image lengkap dengan transport |
| `OCI_DIR` | `./tmp/<IMAGE_NAME>` | folder OCI layout lokal |
| `MULTI_ARCH` | `all` | nilai `skopeo --multi-arch` (`all` / `system` / `copy`) |
| `ARCH` | (kosong) | pin arch (`amd64` / `arm64`), override `MULTI_ARCH` |
| `OS` | `linux` | override OS source |
| `SRC_NO_CREDS` | `1` | set `0` untuk pakai auth dari `~/.docker/config.json` (private registry seperti fly.io/GCR/ECR) |
| `AWS_DEFAULT_REGION` | `auto` | region |

## Workflow multi-version (rekomendasi)

Pisahkan copy dan push supaya banding source registry hanya sekali pakai, lalu push semua versi sekaligus:

```bash
# Phase 1: pull 3 versi ke satu folder OCI (dedup blob otomatis)
COPY_ONLY=1 \
  IMAGE_NAME=nginx \
  SOURCE_TAGS="1.25-alpine 1.26-alpine latest" \
  OCI_DIR=./multi-nginx \
  ./copy-and-push-r2.sh

# Phase 2: push semua tag + digest ke R2 (blob sekali sync)
AWS_ACCESS_KEY_ID=xxx AWS_SECRET_ACCESS_KEY=yyy \
  R2_BUCKET=my-bucket \
  R2_ENDPOINT=https://<account_id>.r2.cloudflarestorage.com \
  PUSH_ONLY=1 \
  IMAGE_NAME=nginx \
  OCI_DIR=./multi-nginx \
  ./copy-and-push-r2.sh
```

Hasilnya di R2:
```
v2/nginx/blobs/sha256/...                  # semua blob (config, layer, manifest)
v2/nginx/manifests/1.25-alpine             # tag → manifest file
v2/nginx/manifests/1.26-alpine
v2/nginx/manifests/latest
v2/nginx/manifests/sha256:<digest-1>       # manifest by digest (dedup)
v2/nginx/manifests/sha256:<digest-2>
v2/nginx/oci-layout
```

Dedup: bila dua tag menunjuk ke manifest yang sama (mis. `latest` dan `1.26-alpine` adalah image identik), tag tetap di-upload sebagai 2 key, tetapi manifest by digest hanya di-upload 1x.

## GitHub Actions (reusable)

Repo ini menyediakan composite action untuk mode `PUSH_ONLY` yang bisa dipakai dari repo manapun:

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

Caller bertanggung jawab membangun OCI layout (mis. via `docker buildx build --output type=oci,oci-layout=true,dest=./tmp/myapp .`) sebelum memanggil action ini.

Detail lengkap (inputs, setup secrets/vars di repo caller, contoh multi-arch, security, pinning): lihat [`.github/actions/push-to-r2/README.md`](.github/actions/push-to-r2/README.md).

Setup sekali di repo caller → **Settings → Secrets and variables → Actions**:

- **Secrets:** `R2_AWS_ACCESS_KEY_ID`, `R2_AWS_SECRET_ACCESS_KEY`
- **Variables:** `R2_BUCKET`, `R2_ENDPOINT`

### Sample: build dengan `docker/build-push-action` → R2

Kalau caller sudah memakai [`docker/build-push-action`](https://github.com/docker/build-push-action), cukup arahkan `outputs` ke OCI layout (bukan push ke registry) lalu teruskan ke composite action `push-to-r2`:

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

Catatan:

- `outputs: type=oci,oci-layout=true,dest=./tmp/myapp` menghasilkan OCI image layout di folder — **tidak** push ke registry manapun, jadi tidak perlu `push: false` atau creds registry. Nilai `oci-dir` di step berikutnya harus **persis sama** dengan `dest` di sini.
- `tags: myapp:...` wajib agar annotation `org.opencontainers.image.ref.name` tertulis di `index.json`; tanpa itu tag tidak akan ter-upload ke R2 (lihat troubleshooting action).
- Multi-arch: tambahkan `platforms: linux/amd64,linux/arm64` — buildx otomatis menghasilkan OCI image **index**, dan `detect_ct()` di script akan memetakan ke `application/vnd.oci.image.index.v1+json`. Worker patched (`worker.js` di repo ini) wajib untuk serve image multi-arch.
- Cache buildx (opsional): tambahkan `cache-from`/`cache-to` seperti biasa; tidak mempengaruhi output OCI layout.

## Pipeline: nginx → scan → R2

`.github/workflows/nginx-scan-push.yaml` menjalankan alur lengkap untuk nginx:

1. `actions/checkout@v7`.
2. Install `skopeo` + `jq`, lalu salin image ke OCI layout via `copy-and-push-r2.sh` (`COPY_ONLY=1`).
3. Scan dengan Trivy (`CRITICAL,HIGH`, `ignore-unfixed`). Hasil SARIF di-upload ke code scanning dan sebagai artifact.
4. Push OCI layout ke R2 via composite action `push-to-r2`.

Trigger: manual (`workflow_dispatch`, dengan input source image, tag, severity, dan `fail-on-findings`) serta nightly `03:00 UTC`. Push dilewati bila Trivy menemukan kerentanan; set `fail-on-findings=false` untuk tetap push.

Butuh secrets/vars yang sama seperti action `push-to-r2`:

- Secrets: `R2_AWS_ACCESS_KEY_ID`, `R2_AWS_SECRET_ACCESS_KEY`, `R2_BUCKET`, `R2_ENDPOINT`

Catatan: runner Ubuntu tidak punya Nix, jadi workflow membuat shim `nix-shell` kecil yang menjalankan perintah `--run` memakai `skopeo` dari apt.

## Struktur key R2

Identik untuk semua mode, supaya kompatibel dengan `worker.js`:

```
v2/<image>/blobs/sha256/<hash>          # blob (config, layers, manifest)
v2/<image>/manifests/<tag>              # manifest by tag
v2/<image>/manifests/sha256:<hash>      # manifest by digest
v2/<image>/oci-layout
```

## Worker (`worker.js`)

Worker membaca dari R2 dan menyajikan endpoint OCI Registry v2:
- `GET/HEAD /v2/` → ping
- `GET/HEAD /v2/<image>/manifests/<reference>` → manifest (tag atau digest)
- `GET/HEAD /v2/<image>/blobs/sha256/<hash>` → blob

### Patch penting (sudah diterapkan di file ini)

Worker asli **hardcode** `Content-Type: application/vnd.oci.image.manifest.v1+json`. Ini rusak untuk image multi-arch (yang manifest-nya berupa OCI image **index**). Patch di file ini menambahkan fungsi:

```js
function manifestContentType(mediaType) {
  if (mediaType?.includes('oci.image.index'))              return '...index.v1+json';
  if (mediaType?.includes('docker.distribution.manifest.list')) return '...list.v2+json';
  if (mediaType?.includes('docker.distribution.manifest.v2'))   return '...v2+json';
  return 'application/vnd.oci.image.manifest.v1+json'; // default = behavior lama
}
```

Default tetap manifest type → **backward-compatible** dengan image yang sudah ter-deploy. Untuk image multi-arch (output `MULTI_ARCH=all`), worker otomatis serve Content-Type index.

### Deploy

`worker.js` di repo ini adalah working copy. Copy ke project Cloudflare Worker asli lalu:
```bash
wrangler deploy
```

Pastikan `wrangler.toml` punya binding R2:
```toml
[[r2_buckets]]
binding = "OCI_BUCKET"
bucket_name = "<your-bucket-name>"
```

## Pull kembali dari worker

Setelah deploy worker, image bisa di-pull via skopeo atau docker:

```bash
# via skopeo (anon, tanpa creds)
nix-shell -p skopeo --run \
  "skopeo copy --src-no-creds --dest-oci-mediatypes=true \
   docker://<worker-host>/nginx:latest oci:./pull-test:latest"

# via docker (colima)
docker pull <worker-host>/nginx:latest
```

## Gotcha & batasan

1. **Multi-arch butuh worker patched** — worker asli tidak bisa serve image index dengan benar. Gunakan `worker.js` dari repo ini.
2. **Auth anon di worker** — worker tidak implement auth. Cocok untuk image publik, **tidak** untuk image privat.
3. **Range request tidak di-handle** — worker tetap set `Accept-Ranges: bytes` tapi stream full body. Boros bandwith untuk layer besar.
4. **`MULTI_ARCH=all` di nginx menghasilkan 16 sub-image** → size besar. Untuk hemat bandwith, pertimbangkan `ARCH=amd64` (atau `arm64`) bila target platform sudah jelas.
5. **PAT Docker Hub yang expired** di `~/.docker/config.json` akan dipakai skopeo secara default. Script pakai `--src-no-creds` untuk bypass. Untuk source privat, hapus `--src-no-creds` atau sediakan auth file sendiri.
6. **Host darwin** wajib `--override-os linux` (sudah otomatis di script).

## Troubleshooting

| Error | Penyebab | Solusi |
|---|---|---|
| `unknown flag: --dest-oci-mediatypes` | skopeo 1.23+ sudah hapus flag itu | script pakai `--format oci` (pengganti) |
| `incorrect username/password` di Docker Hub | PAT expired di `~/.docker/config.json` | `--src-no-creds` otomatis; atau update PAT |
| `no image found ... OS "darwin"` | host = macOS | `--override-os linux` otomatis |
| `choosing an image from manifest list ... no image found for architecture` | source tidak punya binary untuk arch target | set `ARCH=<arch>` yang tersedia di source |
| `manifest blob not found` | OCI_DIR rusak / tidak lengkap | hapus folder, ulangi copy |
| aws `AccessDenied` | R2 creds salah / tidak punya akses bucket | cek `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` dan policy bucket |
| `The Authorization header is malformed` | region salah | set `AWS_DEFAULT_REGION=auto` |

## Verifikasi manual

```bash
# cek struktur R2
aws s3 ls s3://${R2_BUCKET}/v2/nginx/ --endpoint-url ${R2_ENDPOINT} --recursive

# cek manifest tertentu
aws s3 cp s3://${R2_BUCKET}/v2/nginx/manifests/latest - \
  --endpoint-url ${R2_ENDPOINT} | jq '.mediaType'
```

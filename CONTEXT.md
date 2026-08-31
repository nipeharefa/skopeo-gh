# OCI Registry Pipeline & Dashboard

Ekosistem untuk menyalin container image dari registry manapun ke **Cloudflare R2** sebagai OCI layout, menyajikannya kembali sebagai OCI/Docker registry via **Cloudflare Worker**, dan mengelolanya lewat **dashboard** (list + hapus repo/tag).

## Language

**Image (repo)**:
Sebuah container image yang disimpan di R2, diidentifikasi oleh prefix `v2/<image>/` (mis. `v2/nginx/`).
_Avoid_: repository, container

**Tag**:
Referensi bernama pada sebuah image, disimpan sebagai key `v2/<image>/manifests/<tag>` (mis. `v2/nginx/manifests/latest`).
_Avoid_: version, label

**Digest key**:
Manifest yang disimpan berdasarkan digest-nya di `v2/<image>/manifests/sha256:<hash>`. Dibuat saat push untuk dedup antar tag; **bukan** referensi yang dikelola user.
_Avoid_: hash reference

**Blob**:
Layer, config, dan manifest yang disimpan di `v2/<image>/blobs/sha256/<hash>`. Di-share antar tag dalam satu image.
_Avoid_: object, layer only

**R2 bucket (`catetin-container`)**:
Tempat penyimpanan OCI image. **Source of truth** untuk semua data image — layout key harus selalu cocok dengan `worker.js` dan `copy-and-push-r2.sh`.
_Avoid_: database, store

**Registry worker**:
Cloudflare Worker (`worker.js`) yang menyajikan R2 sebagai OCI Registry v2 endpoint (GET/HEAD saja, anonim, read-only).
_Avoid_: server, API

**Dashboard**:
Worker terpisah (React Router 7 + Cloudflare, di `dashboard/`) untuk melihat daftar image & tag serta menghapusnya. Binding: `OCI_BUCKET` (R2) + `DB` (D1).
_Avoid_: admin panel, console

**D1 (`oci-dashboard`)**:
Database Cloudflare D1 yang hanya menyimpan **audit log** hapus (`audit_log`: action, repo, tag, timestamp). Bukan source of truth — jangan simpan data image di sini.
_Avoid_: cache, index

**Hapus tag**:
Delete key `v2/<image>/manifests/<tag>` saja. Digest keys dan blobs **tidak** disentuh karena mungkin dipakai tag lain.
_Avoid_: purge, cleanup

**Hapus image (repo)**:
Delete **seluruh** key di prefix `v2/<image>/` (termasuk blobs). Blobs tidak dishare antar image, jadi aman.
_Avoid_: delete blob only

**Zero Trust**:
Auth yang direncanakan untuk melindungi dashboard (Cloudflare Zero Trust), ditunda — dashboard saat ini publik.

## Relationships

- Sebuah **image** memiliki satu atau lebih **tag**
- Sebuah **image** memiliki banyak **blob**; blob dishare antar **tag** pada image yang sama
- Sebuah **tag** menunjuk ke satu **digest key** (dedup) atau manifest langsung
- **Dashboard** membaca daftar image/tag langsung dari **R2 bucket** (bukan D1)
- Menghapus **tag** mencatat `delete_tag` ke **D1**; menghapus **image** mencatat `delete_repo`
- **Registry worker** dan **Dashboard** memakai **R2 bucket** yang sama, layout `v2/...` yang sama

## Example dialogue

> **Dev:** "Kalau user hapus satu tag, blobs-nya ikut hilang juga?"
> **Domain expert:** "Tidak — hapus tag hanya menghapus key `manifests/<tag>`. Digest keys dan blobs dibiarkan, karena tag lain pada image yang sama bisa masih menunjuk ke sana."
>
> **Dev:** "Berarti untuk lihat daftar image, dashboard query D1?"
> **Domain expert:** "Tidak. D1 cuma audit log. Daftar image dan tag di-list langsung dari R2 — R2 adalah source of truth."

## Flagged ambiguities

- "image" sempat rancu antara "file container image" dan "repo/registry entry" — resolved: **image** = entry di prefix `v2/<image>/`.
- "repository" sempat dipakai untuk menyebut image — resolved: pakai **image** (repo dalam arti git/GH Action berbeda konteks).
- D1 sempat diusulkan sebagai index/cache listing — resolved: **D1 hanya audit log**; listing selalu dari R2 untuk menghindari drift.
- Express awalnya direncanakan untuk SSR — resolved: ganti ke **React Router 7 + Cloudflare Vite plugin** (native Workers, binding langsung).
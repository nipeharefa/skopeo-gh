export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const pathname = url.pathname;

    if (!['GET', 'HEAD'].includes(request.method)) {
      return new Response('Method Not Allowed', { status: 405 });
    }

    if (pathname === '/v2/' || pathname === '/v2') {
      return new Response('', { status: 200 });
    }

    const path = pathname.slice(1);

    const manifestMatch = path.match(/^v2\/(.+)\/manifests\/(.+)$/);
    if (manifestMatch) {
      const [, imageName, reference] = manifestMatch;
      return handleManifest(env, imageName, reference, request);
    }

    const blobMatch = path.match(/^v2\/(.+)\/blobs\/(sha256:[a-f0-9]{64})$/) ||
                      path.match(/^v2\/(.+)\/blobs\/sha256\/([a-f0-9]{64})$/);
    if (blobMatch) {
      let imageName, digest;
      if (blobMatch[2]?.includes(':')) {
        imageName = blobMatch[1];
        digest = blobMatch[2];
      } else {
        imageName = blobMatch[1];
        digest = `sha256:${blobMatch[2]}`;
      }
      return handleBlob(env, imageName, digest, request);
    }

    return new Response('Not Found', { status: 404 });
  }
};

function manifestContentType(mediaType) {
  if (typeof mediaType !== 'string') {
    return 'application/vnd.oci.image.manifest.v1+json';
  }
  if (mediaType.includes('oci.image.index')) {
    return 'application/vnd.oci.image.index.v1+json';
  }
  if (mediaType.includes('docker.distribution.manifest.list')) {
    return 'application/vnd.docker.distribution.manifest.list.v2+json';
  }
  if (mediaType.includes('docker.distribution.manifest.v2')) {
    return 'application/vnd.docker.distribution.manifest.v2+json';
  }
  return 'application/vnd.oci.image.manifest.v1+json';
}

async function handleManifest(env, imageName, reference, request) {
  try {
    let object;
    let manifestKey = `v2/${imageName}/manifests/${reference}`;

    console.log('Trying to fetch manifest:', manifestKey);
    object = await env.OCI_BUCKET.get(manifestKey);

    if (!object && reference.match(/^sha256:[a-f0-9]{64}$/)) {
      const digestWithoutPrefix = reference.replace('sha256:', '');
      manifestKey = `v2/${imageName}/blobs/sha256/${digestWithoutPrefix}`;
      console.log('Manifest not found, trying blob:', manifestKey);
      object = await env.OCI_BUCKET.get(manifestKey);
    }

    if (!object) {
      console.log('Manifest not found:', manifestKey);
      return new Response('Not Found', { status: 404 });
    }

    const manifestText = await object.text();
    const manifest = JSON.parse(manifestText);

    const originalDigest = await computeSHA256(manifestText);
    const contentType = manifestContentType(manifest.mediaType);

    const headers = {
      'Content-Type': contentType,
      'Docker-Content-Digest': `sha256:${originalDigest}`,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': new TextEncoder().encode(manifestText).length.toString()
    };

    const body = request.method === 'HEAD' ? null : manifestText;

    return new Response(body, {
      status: 200,
      headers
    });
  } catch (error) {
    console.error('Manifest error:', error.message, error.stack);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function handleBlob(env, imageName, digest, request) {
  try {
    const normalizedDigest = digest.includes(':') ? digest : `sha256:${digest}`;
    const digestHash = normalizedDigest.replace('sha256:', '');

    const blobKey = `v2/${imageName}/blobs/sha256/${digestHash}`;
    console.log('Trying to fetch blob:', blobKey);

    if (request.method === 'HEAD') {
      try {
        const object = await env.OCI_BUCKET.head(blobKey);
        return new Response(null, {
          status: 200,
          headers: {
            'Content-Length': object.size.toString(),
            'Docker-Content-Digest': normalizedDigest,
            'Cache-Control': 'public, max-age=31536000, immutable'
          }
        });
      } catch (error) {
        console.log('Blob HEAD not found:', blobKey);
        return new Response('Not Found', { status: 404 });
      }
    }

    const object = await env.OCI_BUCKET.get(blobKey);

    if (!object) {
      console.log('Blob GET not found:', blobKey);
      return new Response('Not Found', { status: 404 });
    }

    return new Response(object.body, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Content-Length': object.size.toString(),
        'Docker-Content-Digest': normalizedDigest,
        'Accept-Ranges': 'bytes',
        'Cache-Control': 'public, max-age=31536000, immutable'
      }
    });
  } catch (error) {
    console.error('Blob error:', error.message, error.stack);
    return new Response('Internal Server Error', { status: 500 });
  }
}

async function computeSHA256(data) {
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  const hashBuffer = await crypto.subtle.digest('SHA-256', buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  return hashArray.map(b => b.toString(16).padStart(2, '0')).join('');
}

function convertOCIToDocker(manifest) {
  const docker = JSON.parse(JSON.stringify(manifest));

  if (docker.mediaType === 'application/vnd.oci.image.manifest.v1+json') {
    docker.mediaType = 'application/vnd.docker.distribution.manifest.v2+json';
  }

  if (docker.config?.mediaType === 'application/vnd.oci.image.config.v1+json') {
    docker.config.mediaType = 'application/vnd.docker.container.image.v1+json';
  }

  if (docker.layers && Array.isArray(docker.layers)) {
    docker.layers = docker.layers.map(layer => ({
      ...layer,
      mediaType: 'application/vnd.docker.image.rootfs.diff.tar.gzip'
    }));
  }

  return docker;
}

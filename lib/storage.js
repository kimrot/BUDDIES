// Object storage for profile photos.
//   s3    — any S3-compatible service: AWS S3, Cloudflare R2, Backblaze B2, MinIO (S3_* settings)
//   local — files under ./data/photos (development; or a single server with a persistent disk)
//
// The bucket stays private: photos are only reachable through the server's access-checked
// /api/photos/... URLs, which either stream the bytes (default) or redirect to a short-lived
// signed URL (PHOTO_DELIVERY=redirect, offloads bandwidth to the storage provider/CDN).

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const env = process.env;
const PRODUCTION = env.NODE_ENV === 'production';
const driver = env.STORAGE_DRIVER || (env.S3_BUCKET ? 's3' : PRODUCTION ? 'none' : 'local');
const delivery = env.PHOTO_DELIVERY === 'redirect' && driver === 's3' ? 'redirect' : 'proxy';
const KEY_RE = /^[a-z0-9][a-z0-9/_.-]{0,200}$/i;
const checkKey = (key) => { if (!KEY_RE.test(key) || key.includes('..')) throw new Error('bad storage key'); return key; };

// ---------- local ----------
function localDriver() {
  const root = path.resolve(env.STORAGE_DIR || path.join(__dirname, '..', 'data', 'photos'));
  const file = (key) => path.join(root, checkKey(key));
  return {
    name: 'local',
    async check() { fs.mkdirSync(root, { recursive: true, mode: 0o700 }); },
    async put(key, body) {
      const f = file(key);
      fs.mkdirSync(path.dirname(f), { recursive: true, mode: 0o700 });
      const tmp = `${f}.${crypto.randomBytes(4).toString('hex')}.tmp`;
      await fs.promises.writeFile(tmp, body, { mode: 0o600 });
      await fs.promises.rename(tmp, f);
    },
    async get(key) { return fs.promises.readFile(file(key)); },
    async del(key) { await fs.promises.rm(file(key), { force: true }); },
    async list() { // for tests / audits
      const out = [];
      const walk = (d, pre) => { if (!fs.existsSync(d)) return; for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.isDirectory()) walk(path.join(d, e.name), pre + e.name + '/'); else if (!e.name.endsWith('.tmp')) out.push(pre + e.name); } };
      walk(root, '');
      return out;
    },
  };
}

// ---------- S3-compatible ----------
function s3Driver() {
  const { S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand, HeadBucketCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');
  const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
  const Bucket = env.S3_BUCKET;
  const client = new S3Client({
    region: env.S3_REGION || 'auto',
    endpoint: env.S3_ENDPOINT || undefined,                 // R2: https://<account>.r2.cloudflarestorage.com
    forcePathStyle: env.S3_FORCE_PATH_STYLE === '1',       // MinIO and some self-hosted servers
    credentials: env.S3_ACCESS_KEY_ID ? { accessKeyId: env.S3_ACCESS_KEY_ID, secretAccessKey: env.S3_SECRET_ACCESS_KEY } : undefined,
    maxAttempts: 3,
  });
  const HOUR = 3600e3;
  return {
    name: 's3',
    async check() { await client.send(new HeadBucketCommand({ Bucket })); },
    async put(key, body, mime) {
      await client.send(new PutObjectCommand({
        Bucket, Key: checkKey(key), Body: body, ContentType: mime,
        CacheControl: 'private, max-age=31536000, immutable',
        ...(env.S3_SSE ? { ServerSideEncryption: env.S3_SSE } : {}), // e.g. AES256 on AWS (R2 encrypts by default)
      }));
    },
    async get(key) {
      const r = await client.send(new GetObjectCommand({ Bucket, Key: checkKey(key) }));
      return Buffer.from(await r.Body.transformToByteArray());
    },
    async del(key) { await client.send(new DeleteObjectCommand({ Bucket, Key: checkKey(key) })); }, // idempotent
    async list() {
      const out = [];
      let token;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket, ContinuationToken: token }));
        for (const o of r.Contents || []) out.push(o.Key);
        token = r.IsTruncated ? r.NextContinuationToken : undefined;
      } while (token);
      return out;
    },
    // Signed with the start of the current hour and valid for 2 hours, so the URL is identical for a
    // whole hour (browsers can cache the image) and always still valid while that redirect is cached.
    async signedUrl(key, mime) {
      const bucketStart = Math.floor(Date.now() / HOUR) * HOUR;
      const url = await getSignedUrl(client, new GetObjectCommand({
        Bucket, Key: checkKey(key), ResponseContentType: mime, ResponseCacheControl: 'private, max-age=3600',
      }), { expiresIn: 7200, signingDate: new Date(bucketStart) });
      return { url, cacheSeconds: Math.max(60, Math.floor((bucketStart + HOUR - Date.now()) / 1000)) };
    },
    async origin() { return new URL((await this.signedUrl('probe/origin', 'image/jpeg')).url).origin; },
  };
}

function noneDriver() {
  const off = async () => { throw new Error('Photo storage is not configured (set S3_BUCKET or STORAGE_DRIVER=local)'); };
  return { name: 'none', check: off, put: off, get: off, del: off, list: async () => [] };
}

const store = driver === 's3' ? s3Driver() : driver === 'local' ? localDriver() : noneDriver();
const EXT = { 'image/jpeg': 'jpg', 'image/png': 'png', 'image/webp': 'webp' };
// Keys carry no user id or name: just a random id.
const newKey = (photoId, mime) => `photos/${photoId}-${crypto.randomBytes(6).toString('base64url').toLowerCase().replace(/[^a-z0-9]/g, 'x')}.${EXT[mime] || 'bin'}`;

module.exports = { ...store, driver: store.name, delivery, newKey };

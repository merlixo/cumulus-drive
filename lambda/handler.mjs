// cumulus-auth Lambda logic, without AWS SDK: S3 accesses are
// injected (deps), making it testable with node --test.
import { createHash, timingSafeEqual } from 'node:crypto';
import {
  generateKey, isValidKey, isValidLogin, isValidSignPath, uploadHeaders, KEY_LENGTH,
} from '../site/lib.js';

const MAX_NAME_LENGTH = 200;
const MAX_OBJECTS = 50;
const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;        // single S3 PUT limit (like client-side)
const PROJECT_QUOTA_BYTES = 10 * 1024 ** 3;    // safety limit: 10 GiB per project
const BUCKET_QUOTA_BYTES = 100 * 1024 ** 3;    // safety limit: 100 GiB for entire bucket
const BUCKET_USAGE_TTL_MS = 5 * 60 * 1000;     // bucket total re-measured at most every 5 min
// Dummy hash compared when login is unknown: identical response
// and timing, no account existence oracle.
const DUMMY_HASH = createHash('sha256').update('cumulus-dummy').digest('hex');

function json(statusCode, payload) {
  return {
    statusCode,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  };
}

function hashMatches(password, expectedHexHash) {
  const actual = createHash('sha256').update(password, 'utf8').digest();
  const expected = Buffer.from(expectedHexHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// true if login/password pair matches an account in the registry.
async function accountMatches(login, password, deps) {
  if (typeof password !== 'string') return false;
  const accounts = await deps.loadAccounts();
  const expected = accounts[login];
  if (typeof expected !== 'string') {
    hashMatches(password, DUMMY_HASH);
    return false;
  }
  return hashMatches(password, expected);
}

// deps : { loadAccounts, getManifest(login, key) → object | null,
//          putManifest(login, key, body) (create only), writeManifest(login, key, body) (overwrite),
//          presignPut(objectKey, contentType, contentLength),
//          listObjectsUnder(prefix) → [{key, size}],
//          getObjectText(objectKey), deleteObjects(objectKeys) }
// now: injectable clock (tests).
export function createHandler(deps, { now = Date.now } = {}) {
  // Bucket-wide usage, kept by a warm instance: listing every project on each
  // sign made uploads slower as the bucket grew. Signed sizes are added on
  // top, so the estimate only errs high; other instances' uploads are missed
  // for at most the TTL — acceptable for a safety limit, not a billing one.
  const bucketUsage = { bytes: 0, measuredAt: -Infinity };
  async function bucketBytes() {
    if (now() - bucketUsage.measuredAt > BUCKET_USAGE_TTL_MS) {
      const objects = await deps.listObjectsUnder('projects/');
      bucketUsage.bytes = objects.reduce((total, o) => total + o.size, 0);
      bucketUsage.measuredAt = now();
    }
    return bucketUsage.bytes;
  }
  const signDeps = { ...deps, bucketBytes, addBucketBytes: (n) => { bucketUsage.bytes += n; } };

  return async function handle(event) {
    if (event?.requestContext?.http?.method !== 'POST') {
      return json(400, { error: 'méthode invalide' });
    }
    let body;
    try {
      const raw = event.isBase64Encoded
        ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
        : event.body ?? '';
      body = JSON.parse(raw);
    } catch {
      return json(400, { error: 'JSON invalide' });
    }
    if (!isValidLogin(body?.login)) return json(400, { error: 'login invalide' });
    if (body.action === 'create') return create(body, deps);
    if (body.action === 'sign') return sign(body, signDeps);
    if (body.action === 'list') return list(body, deps);
    if (body.action === 'delete') return destroy(body, deps);
    if (body.action === 'setReadOnly') return setReadOnly(body, deps);
    return json(400, { error: 'action inconnue' });
  };
}

async function create({ login, password, name }, deps) {
  if (!(await accountMatches(login, password, deps))) {
    return json(401, { error: 'identifiants incorrects' });
  }
  const trimmed = typeof name === 'string' ? name.trim() : '';
  if (!trimmed || trimmed.length > MAX_NAME_LENGTH) {
    return json(400, { error: 'nom invalide' });
  }
  const key = generateKey();
  await deps.putManifest(login, key, JSON.stringify({ name: trimmed, createdAt: new Date().toISOString() }));
  return json(201, { key });
}

async function sign({ login, key, objects }, deps) {
  if (!isValidKey(key)) return json(400, { error: 'clé invalide' });
  if (!Array.isArray(objects) || objects.length === 0 || objects.length > MAX_OBJECTS) {
    return json(400, { error: 'objets invalides' });
  }
  for (const o of objects) {
    if (!o || !isValidSignPath(o.path) || typeof o.type !== 'string' || !o.type
        || !Number.isInteger(o.size) || o.size < 1 || o.size > MAX_UPLOAD_BYTES) {
      return json(400, { error: 'objets invalides' });
    }
  }
  const manifest = await deps.getManifest(login, key);
  if (!manifest) return json(403, { error: 'projet introuvable' });
  // Checked before any listing: a frozen project costs nothing to refuse.
  if (manifest.readOnly === true) return json(403, { error: 'projet en lecture seule' });
  // Storage safety limits: the project is measured exactly on every call (its
  // own prefix only), the bucket total comes from the per-instance cache.
  // Declared sizes are tamper-proof: they are signed in the URLs
  // (Content-Length) and verified by S3.
  const incoming = objects.reduce((total, o) => total + o.size, 0);
  const projectPrefix = `projects/${login}/${key}/`;
  const [projectObjects, bucketBytes] = await Promise.all([
    deps.listObjectsUnder(projectPrefix),
    deps.bucketBytes(),
  ]);
  const projectBytes = projectObjects
    .filter((o) => o.key.startsWith(projectPrefix))
    .reduce((total, o) => total + o.size, 0);
  if (projectBytes + incoming > PROJECT_QUOTA_BYTES) {
    return json(413, { error: 'quota du projet atteint (10 Go)' });
  }
  if (bucketBytes + incoming > BUCKET_QUOTA_BYTES) {
    return json(413, { error: 'stockage saturé — contactez le propriétaire' });
  }
  // uploadHeaders, never o.type as sent: the client chooses the file, never how
  // S3 will serve it back on the site's own origin.
  const signed = await Promise.all(objects.map((o) => {
    const { contentType, contentDisposition } = uploadHeaders(o.type);
    return deps.presignPut(`projects/${login}/${key}/${o.path}`, contentType, o.size, contentDisposition);
  }));
  const urls = Object.fromEntries(objects.map((o, i) => [o.path, signed[i]]));
  deps.addBucketBytes(incoming);
  return json(200, { urls });
}

const DELETE_BATCH = 1000;

async function list({ login, password }, deps) {
  if (!(await accountMatches(login, password, deps))) {
    return json(401, { error: 'identifiants incorrects' });
  }
  const objectKeys = (await deps.listObjectsUnder(`projects/${login}/`)).map((o) => o.key);
  const manifestRe = new RegExp(`^projects/${login}/([a-z0-9]{${KEY_LENGTH}})/manifest\\.json$`);
  const projects = [];
  for (const objectKey of objectKeys) {
    const match = objectKey.match(manifestRe);
    if (!match) continue;
    const key = match[1];
    let name = key;
    let createdAt = '';
    let readOnly = false;
    try {
      const manifest = JSON.parse(await deps.getObjectText(objectKey));
      if (typeof manifest.name === 'string' && manifest.name) name = manifest.name;
      if (typeof manifest.createdAt === 'string') createdAt = manifest.createdAt;
      readOnly = manifest.readOnly === true;
    } catch { /* unreadable manifest: key used as name */ }
    projects.push({ key, name, createdAt, readOnly });
  }
  projects.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return json(200, { projects });
}

// "delete" is the action name; function is named destroy (reserved keyword).
async function destroy({ login, password, key }, deps) {
  if (!(await accountMatches(login, password, deps))) {
    return json(401, { error: 'identifiants incorrects' });
  }
  if (!isValidKey(key)) return json(400, { error: 'clé invalide' });
  const objectKeys = (await deps.listObjectsUnder(`projects/${login}/${key}/`)).map((o) => o.key);
  for (let i = 0; i < objectKeys.length; i += DELETE_BATCH) {
    await deps.deleteObjects(objectKeys.slice(i, i + DELETE_BATCH));
  }
  return json(200, { deleted: objectKeys.length });
}

// Owner only: freezes (or reopens) a project. Visitors keep viewing and
// downloading; sign refuses new uploads while readOnly is true.
async function setReadOnly({ login, password, key, readOnly }, deps) {
  if (!(await accountMatches(login, password, deps))) {
    return json(401, { error: 'identifiants incorrects' });
  }
  if (!isValidKey(key)) return json(400, { error: 'clé invalide' });
  if (typeof readOnly !== 'boolean') return json(400, { error: 'readOnly invalide' });
  const manifest = await deps.getManifest(login, key);
  if (!manifest) return json(404, { error: 'projet introuvable' });
  await deps.writeManifest(login, key, JSON.stringify({ ...manifest, readOnly }));
  return json(200, { readOnly });
}

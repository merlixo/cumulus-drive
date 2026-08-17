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

// deps : { loadAccounts, headManifest(login, key), putManifest(login, key, body),
//          presignPut(objectKey, contentType, contentLength),
//          listObjectsUnder(prefix) → [{key, size}],
//          getObjectText(objectKey), deleteObjects(objectKeys) }
export function createHandler(deps) {
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
    if (body.action === 'sign') return sign(body, deps);
    if (body.action === 'list') return list(body, deps);
    if (body.action === 'delete') return destroy(body, deps);
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
  if (!(await deps.headManifest(login, key))) {
    return json(403, { error: 'projet introuvable' });
  }
  // Storage safety limits: existing storage is measured in one pass over projects/
  // (project + bucket totals). Declared sizes are tamper-proof: they
  // are signed in the URLs (Content-Length) and verified by S3.
  const incoming = objects.reduce((total, o) => total + o.size, 0);
  const projectPrefix = `projects/${login}/${key}/`;
  let bucketBytes = 0;
  let projectBytes = 0;
  for (const existing of await deps.listObjectsUnder('projects/')) {
    bucketBytes += existing.size;
    if (existing.key.startsWith(projectPrefix)) projectBytes += existing.size;
  }
  if (projectBytes + incoming > PROJECT_QUOTA_BYTES) {
    return json(413, { error: 'quota du projet atteint (10 Go)' });
  }
  if (bucketBytes + incoming > BUCKET_QUOTA_BYTES) {
    return json(413, { error: 'stockage saturé — contactez le propriétaire' });
  }
  // uploadHeaders, never o.type as sent: the client chooses the file, never how
  // S3 will serve it back on the site's own origin.
  const urls = {};
  for (const o of objects) {
    const { contentType, contentDisposition } = uploadHeaders(o.type);
    urls[o.path] = await deps.presignPut(
      `projects/${login}/${key}/${o.path}`, contentType, o.size, contentDisposition,
    );
  }
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
    try {
      const manifest = JSON.parse(await deps.getObjectText(objectKey));
      if (typeof manifest.name === 'string' && manifest.name) name = manifest.name;
      if (typeof manifest.createdAt === 'string') createdAt = manifest.createdAt;
    } catch { /* unreadable manifest: key used as name */ }
    projects.push({ key, name, createdAt });
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

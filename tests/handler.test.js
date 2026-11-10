import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHandler } from '../lambda/handler.mjs';

const sha = (s) => createHash('sha256').update(s, 'utf8').digest('hex');
const ACCOUNTS = { alice: sha('sésame'), bob: sha('tournesol') };
const KEY = 'a'.repeat(16);

function makeDeps(overrides = {}) {
  return {
    loadAccounts: async () => ({ ...ACCOUNTS }),
    getManifest: async () => ({ name: 'X', createdAt: '2026-01-01T00:00:00Z' }),
    putManifest: async () => {},
    writeManifest: async () => {},
    presignPut: async (objectKey) => `https://signed.example/${objectKey}`,
    listObjectsUnder: async () => [],
    getObjectText: async () => '{}',
    deleteObjects: async () => {},
    ...overrides,
  };
}

function post(body) {
  return {
    requestContext: { http: { method: 'POST' } },
    body: JSON.stringify(body),
    isBase64Encoded: false,
  };
}

test('missing or invalid format login → 400, regardless of action', async () => {
  const handle = createHandler(makeDeps());
  assert.equal((await handle(post({ action: 'create', password: 'sésame', name: 'X' }))).statusCode, 400);
  assert.equal((await handle(post({
    action: 'sign', login: 'Alice!', key: KEY, objects: [{ path: 'files/1-a.jpg', type: 'x', size: 100 }],
  }))).statusCode, 400);
});

test('create: wrong password or unknown login → 401 strictly identical, nothing written', async () => {
  const writes = [];
  const handle = createHandler(makeDeps({ putManifest: async (l, k) => writes.push(`${l}/${k}`) }));
  const bad = await handle(post({ action: 'create', login: 'alice', password: 'faux', name: 'X' }));
  const ghost = await handle(post({ action: 'create', login: 'zorro', password: 'sésame', name: 'X' }));
  assert.equal(bad.statusCode, 401);
  assert.equal(ghost.statusCode, 401);
  assert.equal(bad.body, ghost.body);
  assert.equal(writes.length, 0);
});

test('create: valid account → 201, 16 char key, manifest written under login', async () => {
  const writes = [];
  const handle = createHandler(makeDeps({
    putManifest: async (login, key, body) => writes.push({ login, key, body }),
  }));
  const res = await handle(post({ action: 'create', login: 'alice', password: 'sésame', name: ' Vacances ' }));
  assert.equal(res.statusCode, 201);
  const { key } = JSON.parse(res.body);
  assert.match(key, /^[a-z2-7]{16}$/);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].login, 'alice');
  assert.equal(writes[0].key, key);
  const manifest = JSON.parse(writes[0].body);
  assert.equal(manifest.name, 'Vacances');
  assert.ok(manifest.createdAt);
});

test('create: empty or overlong name → 400', async () => {
  const handle = createHandler(makeDeps());
  assert.equal((await handle(post({ action: 'create', login: 'alice', password: 'sésame', name: '  ' }))).statusCode, 400);
  assert.equal((await handle(post({ action: 'create', login: 'alice', password: 'sésame', name: 'x'.repeat(201) }))).statusCode, 400);
});

test('sign: without password (capability = link); missing manifest → 403', async () => {
  const seen = [];
  const handle = createHandler(makeDeps({
    getManifest: async (login, key) => { seen.push(`${login}/${key}`); return null; },
  }));
  const res = await handle(post({
    action: 'sign', login: 'alice', key: KEY, objects: [{ path: 'files/1-a.jpg', type: 'x', size: 100 }],
  }));
  assert.equal(res.statusCode, 403);
  assert.deepEqual(seen, [`alice/${KEY}`]);
});

test('sign: valid paths → 200, URLs under projects/<login>/<key>/', async () => {
  const handle = createHandler(makeDeps());
  const res = await handle(post({
    action: 'sign',
    login: 'alice',
    key: KEY,
    objects: [
      { path: 'files/1-chat.jpg', type: 'image/jpeg', size: 2048 },
      { path: 'thumbs/1-chat.jpg.jpg', type: 'image/jpeg', size: 512 },
    ],
  }));
  assert.equal(res.statusCode, 200);
  const { urls } = JSON.parse(res.body);
  assert.equal(urls['files/1-chat.jpg'], `https://signed.example/projects/alice/${KEY}/files/1-chat.jpg`);
  assert.equal(urls['thumbs/1-chat.jpg.jpg'], `https://signed.example/projects/alice/${KEY}/thumbs/1-chat.jpg.jpg`);
});

test('sign: signs a normalized Content-Type and disposition, never the one supplied', async () => {
  const signed = [];
  const handle = createHandler(makeDeps({
    presignPut: async (objectKey, type, size, disposition) => {
      signed.push([type, disposition]);
      return 'https://signed.example/';
    },
  }));
  const res = await handle(post({
    action: 'sign',
    login: 'alice',
    key: KEY,
    objects: [
      { path: 'files/1-x.html', type: 'text/html', size: 10 },
      { path: 'files/2-x.svg', type: 'image/svg+xml', size: 10 },
      { path: 'files/3-chat.jpg', type: 'image/jpeg', size: 10 },
      { path: 'files/4-clip.mp4', type: 'video/mp4', size: 10 },
    ],
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(signed, [
    ['application/octet-stream', 'attachment'],
    ['application/octet-stream', 'attachment'],
    ['image/jpeg', 'inline'],
    ['video/mp4', 'inline'],
  ]);
});

test('sign: invalid key → 400 without querying S3; invalid paths, empty or > 50 → 400', async () => {
  let headCalled = false;
  const handle = createHandler(makeDeps({
    getManifest: async () => { headCalled = true; return { name: 'X' }; },
  }));
  assert.equal((await handle(post({
    action: 'sign', login: 'alice', key: 'courte', objects: [{ path: 'files/1-a.jpg', type: 'x', size: 100 }],
  }))).statusCode, 400);
  assert.equal(headCalled, false);
  for (const path of ['manifest.json', 'files/a/b.jpg', 'files/..', '../files/a.jpg']) {
    const res = await handle(post({ action: 'sign', login: 'alice', key: KEY, objects: [{ path, type: 'x', size: 100 }] }));
    assert.equal(res.statusCode, 400, `chemin accepté à tort : ${path}`);
  }
  assert.equal((await handle(post({ action: 'sign', login: 'alice', key: KEY, objects: [] }))).statusCode, 400);
  const tooMany = Array.from({ length: 51 }, (_, i) => ({ path: `files/${i}-a.jpg`, type: 'x', size: 100 }));
  assert.equal((await handle(post({ action: 'sign', login: 'alice', key: KEY, objects: tooMany }))).statusCode, 400);
});

test('GET method, invalid JSON, unknown action → 400', async () => {
  const handle = createHandler(makeDeps());
  assert.equal((await handle({ requestContext: { http: { method: 'GET' } } })).statusCode, 400);
  assert.equal((await handle({ requestContext: { http: { method: 'POST' } }, body: '{oups' })).statusCode, 400);
  assert.equal((await handle(post({ action: 'rename', login: 'alice' }))).statusCode, 400);
});

test('base64 encoded body accepted (Function URL)', async () => {
  const handle = createHandler(makeDeps({ getManifest: async () => null }));
  const payload = { action: 'sign', login: 'alice', key: KEY, objects: [{ path: 'files/1-a.jpg', type: 'x', size: 100 }] };
  const res = await handle({
    requestContext: { http: { method: 'POST' } },
    body: Buffer.from(JSON.stringify(payload), 'utf8').toString('base64'),
    isBase64Encoded: true,
  });
  assert.equal(res.statusCode, 403);
});

test('list: bad credentials → 401', async () => {
  const handle = createHandler(makeDeps());
  assert.equal((await handle(post({ action: 'list', login: 'alice', password: 'faux' }))).statusCode, 401);
});

test('list: manifests for login only, descending sort, corrupted manifest → key used as name', async () => {
  const K1 = 'b'.repeat(16);
  const K2 = 'c'.repeat(16);
  const K3 = 'd'.repeat(16);
  const handle = createHandler(makeDeps({
    listObjectsUnder: async (prefix) => {
      assert.equal(prefix, 'projects/alice/');
      return [
        { key: `projects/alice/${K1}/manifest.json`, size: 70 },
        { key: `projects/alice/${K1}/files/1-a.jpg`, size: 1000 },
        { key: `projects/alice/${K2}/manifest.json`, size: 70 },
        { key: `projects/alice/${K3}/manifest.json`, size: 70 },
        { key: 'projects/alice/court/manifest.json', size: 70 },
      ];
    },
    getObjectText: async (objectKey) => {
      if (objectKey.includes(K1)) return JSON.stringify({ name: 'Ancien', createdAt: '2026-01-01T00:00:00Z' });
      if (objectKey.includes(K2)) return JSON.stringify({ name: 'Récent', createdAt: '2026-08-01T00:00:00Z' });
      return '{pas du json';
    },
  }));
  const res = await handle(post({ action: 'list', login: 'alice', password: 'sésame' }));
  assert.equal(res.statusCode, 200);
  const { projects } = JSON.parse(res.body);
  assert.deepEqual(projects.map((p) => p.name), ['Récent', 'Ancien', K3]);
  assert.deepEqual(projects.map((p) => p.key), [K2, K1, K3]);
  assert.deepEqual(projects.map((p) => p.readOnly), [false, false, false]);
});

test('list: readOnly exposed from the manifest', async () => {
  const handle = createHandler(makeDeps({
    listObjectsUnder: async () => [{ key: `projects/alice/${KEY}/manifest.json`, size: 70 }],
    getObjectText: async () => JSON.stringify({ name: 'Figé', createdAt: '2026-01-01T00:00:00Z', readOnly: true }),
  }));
  const { projects } = JSON.parse((await handle(post({ action: 'list', login: 'alice', password: 'sésame' }))).body);
  assert.equal(projects[0].readOnly, true);
});

test('delete: batches of 1000, total returned, idempotent when empty', async () => {
  const many = Array.from({ length: 2300 }, (_, i) => ({ key: `projects/alice/${KEY}/files/${i}.jpg`, size: 1 }));
  const batches = [];
  const handle = createHandler(makeDeps({
    listObjectsUnder: async (prefix) => {
      assert.equal(prefix, `projects/alice/${KEY}/`);
      return many;
    },
    deleteObjects: async (keys) => batches.push(keys.length),
  }));
  const res = await handle(post({ action: 'delete', login: 'alice', password: 'sésame', key: KEY }));
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).deleted, 2300);
  assert.deepEqual(batches, [1000, 1000, 300]);

  const empty = createHandler(makeDeps({ listObjectsUnder: async () => [] }));
  const res2 = await empty(post({ action: 'delete', login: 'alice', password: 'sésame', key: KEY }));
  assert.equal(res2.statusCode, 200);
  assert.equal(JSON.parse(res2.body).deleted, 0);
});

test('delete: bad credentials → 401 first; invalid key → 400', async () => {
  let listed = false;
  const handle = createHandler(makeDeps({ listObjectsUnder: async () => { listed = true; return []; } }));
  assert.equal((await handle(post({ action: 'delete', login: 'alice', password: 'faux', key: KEY }))).statusCode, 401);
  assert.equal((await handle(post({ action: 'delete', login: 'alice', password: 'sésame', key: 'courte' }))).statusCode, 400);
  assert.equal(listed, false);
});

test('sign: missing, non-integer, zero or > 5 GiB size → 400', async () => {
  const handle = createHandler(makeDeps());
  for (const size of [undefined, '100', 3.5, 0, -1, 5 * 1024 ** 3 + 1]) {
    const res = await handle(post({
      action: 'sign', login: 'alice', key: KEY, objects: [{ path: 'files/1-a.jpg', type: 'x', size }],
    }));
    assert.equal(res.statusCode, 400, `taille acceptée à tort : ${size}`);
  }
});

test('sign: project quota (10 GiB) exceeded → 413, under quota → 200', async () => {
  const GIB = 1024 ** 3;
  const existing = [
    { key: `projects/alice/${KEY}/files/1-gros.mp4`, size: 9 * GIB },
    { key: 'projects/bob/cccccccccccccccc/files/1-autre.mp4', size: 2 * GIB },
  ];
  const handle = createHandler(makeDeps({ listObjectsUnder: async () => existing }));
  const over = await handle(post({
    action: 'sign', login: 'alice', key: KEY,
    objects: [{ path: 'files/2-a.mp4', type: 'video/mp4', size: 2 * GIB }],
  }));
  assert.equal(over.statusCode, 413);
  assert.match(JSON.parse(over.body).error, /quota du projet/);
  const ok = await handle(post({
    action: 'sign', login: 'alice', key: KEY,
    objects: [{ path: 'files/2-a.jpg', type: 'image/jpeg', size: GIB / 2 }],
  }));
  assert.equal(ok.statusCode, 200);
});

test('sign: bucket quota (100 GiB) exceeded → 413', async () => {
  const GIB = 1024 ** 3;
  const existing = [
    { key: `projects/alice/${KEY}/files/1-a.mp4`, size: 1 * GIB },
    { key: 'projects/bob/cccccccccccccccc/files/1-b.mp4', size: 99 * GIB },
  ];
  const handle = createHandler(makeDeps({ listObjectsUnder: async () => existing }));
  const res = await handle(post({
    action: 'sign', login: 'alice', key: KEY,
    objects: [{ path: 'files/2-a.jpg', type: 'image/jpeg', size: GIB }],
  }));
  assert.equal(res.statusCode, 413);
  assert.match(JSON.parse(res.body).error, /saturé/);
});

test('sign: presignPut receives size (signed Content-Length)', async () => {
  const sizes = [];
  const handle = createHandler(makeDeps({
    presignPut: async (objectKey, type, size) => {
      sizes.push(size);
      return `https://signed.example/${objectKey}`;
    },
  }));
  const res = await handle(post({
    action: 'sign', login: 'alice', key: KEY,
    objects: [
      { path: 'files/1-chat.jpg', type: 'image/jpeg', size: 2048 },
      { path: 'thumbs/1-chat.jpg.jpg', type: 'image/jpeg', size: 512 },
    ],
  }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(sizes, [2048, 512]);
});

test('sign: bucket total listed once per TTL, project measured on its own prefix every call', async () => {
  const prefixes = [];
  let clock = 0;
  const handle = createHandler(makeDeps({
    listObjectsUnder: async (prefix) => { prefixes.push(prefix); return []; },
  }), { now: () => clock });
  const sign = () => handle(post({
    action: 'sign', login: 'alice', key: KEY, objects: [{ path: 'files/1-a.jpg', type: 'image/jpeg', size: 10 }],
  }));
  await sign();
  await sign();
  assert.deepEqual(prefixes.filter((p) => p === 'projects/'), ['projects/']);
  assert.equal(prefixes.filter((p) => p === `projects/alice/${KEY}/`).length, 2);
  clock = 5 * 60 * 1000 + 1;
  await sign();
  assert.equal(prefixes.filter((p) => p === 'projects/').length, 2);
});

test('sign: sizes signed since the last measurement count toward the bucket quota', async () => {
  const GIB = 1024 ** 3;
  const handle = createHandler(makeDeps({
    listObjectsUnder: async (prefix) => (prefix === 'projects/'
      ? [{ key: 'projects/bob/cccccccccccccccc/files/1-b.mp4', size: 96 * GIB }]
      : []),
  }), { now: () => 0 });
  const sign = (k) => handle(post({
    action: 'sign', login: 'alice', key: k, objects: [{ path: 'files/1-a.mp4', type: 'video/mp4', size: 3 * GIB }],
  }));
  assert.equal((await sign(KEY)).statusCode, 200);
  const second = await sign('b'.repeat(16));
  assert.equal(second.statusCode, 413);
  assert.match(JSON.parse(second.body).error, /saturé/);
});

test('sign: unknown project never lists the bucket', async () => {
  let listed = false;
  const handle = createHandler(makeDeps({
    getManifest: async () => null,
    listObjectsUnder: async () => { listed = true; return []; },
  }));
  const res = await handle(post({
    action: 'sign', login: 'alice', key: KEY, objects: [{ path: 'files/1-a.jpg', type: 'image/jpeg', size: 10 }],
  }));
  assert.equal(res.statusCode, 403);
  assert.equal(listed, false);
});

test('sign: read-only project → 403, never lists nor signs', async () => {
  let touched = false;
  const handle = createHandler(makeDeps({
    getManifest: async () => ({ name: 'Figé', readOnly: true }),
    listObjectsUnder: async () => { touched = true; return []; },
    presignPut: async () => { touched = true; return 'x'; },
  }));
  const res = await handle(post({
    action: 'sign', login: 'alice', key: KEY, objects: [{ path: 'thumbs/1-a.jpg.jpg', type: 'image/jpeg', size: 10 }],
  }));
  assert.equal(res.statusCode, 403);
  assert.match(JSON.parse(res.body).error, /lecture seule/);
  assert.equal(touched, false);
});

test('setReadOnly: bad credentials → 401, nothing written; invalid key or flag → 400; unknown project → 404', async () => {
  const writes = [];
  const handle = createHandler(makeDeps({ writeManifest: async (...args) => writes.push(args) }));
  const base = { action: 'setReadOnly', login: 'alice', password: 'sésame', key: KEY, readOnly: true };
  assert.equal((await handle(post({ ...base, password: 'faux' }))).statusCode, 401);
  assert.equal((await handle(post({ ...base, login: 'zorro' }))).statusCode, 401);
  assert.equal((await handle(post({ ...base, key: 'courte' }))).statusCode, 400);
  assert.equal((await handle(post({ ...base, readOnly: 'oui' }))).statusCode, 400);
  const missing = createHandler(makeDeps({
    getManifest: async () => null,
    writeManifest: async (...args) => writes.push(args),
  }));
  assert.equal((await missing(post(base))).statusCode, 404);
  assert.equal(writes.length, 0);
});

test('setReadOnly: rewrites the manifest keeping name and createdAt, reversible', async () => {
  let stored = { name: 'Vacances', createdAt: '2026-07-01T00:00:00Z' };
  const handle = createHandler(makeDeps({
    getManifest: async (login, key) => {
      assert.deepEqual([login, key], ['alice', KEY]);
      return stored;
    },
    writeManifest: async (login, key, body) => {
      assert.deepEqual([login, key], ['alice', KEY]);
      stored = JSON.parse(body);
    },
  }));
  const base = { action: 'setReadOnly', login: 'alice', password: 'sésame', key: KEY };
  const res = await handle(post({ ...base, readOnly: true }));
  assert.equal(res.statusCode, 200);
  assert.deepEqual(JSON.parse(res.body), { readOnly: true });
  assert.deepEqual(stored, { name: 'Vacances', createdAt: '2026-07-01T00:00:00Z', readOnly: true });
  await handle(post({ ...base, readOnly: false }));
  assert.equal(stored.readOnly, false);
  assert.equal(stored.name, 'Vacances');
});

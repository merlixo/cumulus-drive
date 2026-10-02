import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  generateKey, KEY_ALPHABET, KEY_LENGTH, isValidKey, isValidSignPath,
  isValidLogin, parseProjectRef,
  buildShareLink, parseListXml, makeObjectName, displayName, thumbKeyFor,
  isImage, isVideo, formatSize, encodeKeyPath, safeContentType, uploadHeaders,
  formatDuration, isRetriableStatus, retryDelayMs, RETRY_DELAYS_MS,
} from '../site/lib.js';

test('formatDuration: seconds rounded up to 5, then minutes, then hours', () => {
  assert.equal(formatDuration(2), '~5 s');
  assert.equal(formatDuration(42), '~45 s');
  assert.equal(formatDuration(61), '~2 min');
  assert.equal(formatDuration(3600), '~1 h 00');
  assert.equal(formatDuration(3900), '~1 h 05');
});

test('formatDuration: unknown estimate → empty string', () => {
  assert.equal(formatDuration(Infinity), '');
  assert.equal(formatDuration(NaN), '');
  assert.equal(formatDuration(-1), '');
});

test('isRetriableStatus: network loss, timeout, throttling, 5xx', () => {
  for (const s of [0, 408, 429, 500, 502, 503]) assert.ok(isRetriableStatus(s), `${s}`);
  for (const s of [200, 400, 403, 404, 412, 413]) assert.ok(!isRetriableStatus(s), `${s}`);
});

test('retryDelayMs: increasing backoff, capped at the last delay', () => {
  assert.equal(retryDelayMs(1), RETRY_DELAYS_MS[0]);
  assert.ok(retryDelayMs(2) > retryDelayMs(1));
  assert.equal(retryDelayMs(99), RETRY_DELAYS_MS.at(-1));
});

test('generateKey: length = KEY_LENGTH, no arguments', () => {
  assert.equal(generateKey().length, KEY_LENGTH);
});

test('generateKey: all characters in base32 alphabet', () => {
  for (const c of generateKey()) {
    assert.ok(KEY_ALPHABET.includes(c), `character outside alphabet: ${c}`);
  }
});

test('generateKey: two calls produce different keys', () => {
  assert.notEqual(generateKey(), generateKey());
});

test('isValidKey: accepts a 16-character lowercase alphanumeric key', () => {
  assert.ok(isValidKey(generateKey()));
  assert.ok(isValidKey(`ab12${'x'.repeat(12)}`));
});

test('isValidKey: rejects wrong length (including old 30), uppercase, special chars, non-string', () => {
  assert.ok(!isValidKey('a'.repeat(15)));
  assert.ok(!isValidKey('a'.repeat(17)));
  assert.ok(!isValidKey('a'.repeat(30)));
  assert.ok(!isValidKey('A'.repeat(16)));
  assert.ok(!isValidKey(`${'a'.repeat(15)}/`));
  assert.ok(!isValidKey(42));
  assert.ok(!isValidKey(''));
});

test('isValidSignPath: accepts files/<name> and thumbs/<name>.jpg', () => {
  assert.ok(isValidSignPath('files/1700000000000-été à la plage.jpg'));
  assert.ok(isValidSignPath('thumbs/1-chat.png.jpg'));
});

test('isValidSignPath: rejects other prefixes, subpaths, "..", empty', () => {
  assert.ok(!isValidSignPath('manifest.json'));
  assert.ok(!isValidSignPath('files/a/b.jpg'));
  assert.ok(!isValidSignPath('files/..'));
  assert.ok(!isValidSignPath('files/.'));
  assert.ok(!isValidSignPath('thumbs/'));
  assert.ok(!isValidSignPath('files/a?b.jpg'));
  assert.ok(!isValidSignPath(null));
});

test('buildShareLink: appends key as fragment', () => {
  assert.equal(
    buildShareLink('https://ex.com/index.html', 'k123'),
    'https://ex.com/index.html#k123',
  );
});

test('buildShareLink: replaces existing fragment', () => {
  assert.equal(
    buildShareLink('https://ex.com/index.html#ancienne', 'nouvelle'),
    'https://ex.com/index.html#nouvelle',
  );
});

const SAMPLE_LIST_XML = `<?xml version="1.0" encoding="UTF-8"?>
<ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/">
  <Name>bucket</Name><Prefix>projects/k/files/</Prefix>
  <KeyCount>2</KeyCount><MaxKeys>1000</MaxKeys><IsTruncated>false</IsTruncated>
  <Contents>
    <Key>projects/k/files/123-photo &amp; fête.jpg</Key>
    <LastModified>2026-08-06T10:00:00.000Z</LastModified>
    <Size>12345</Size>
  </Contents>
  <Contents>
    <Key>projects/k/files/456-doc.pdf</Key>
    <LastModified>2026-08-05T09:30:00.000Z</LastModified>
    <Size>999</Size>
  </Contents>
</ListBucketResult>`;

test('parseListXml: extracts keys, sizes, dates (decoded XML entities)', () => {
  const { files } = parseListXml(SAMPLE_LIST_XML);
  assert.equal(files.length, 2);
  assert.deepEqual(files[0], {
    key: 'projects/k/files/123-photo & fête.jpg',
    size: 12345,
    lastModified: '2026-08-06T10:00:00.000Z',
  });
  assert.equal(files[1].key, 'projects/k/files/456-doc.pdf');
});

test('safeContentType: renderable types are never echoed back', () => {
  for (const dangerous of [
    'text/html', 'TEXT/HTML', 'text/html; charset=utf-8', 'image/svg+xml',
    'application/xhtml+xml', 'text/javascript', 'application/pdf', 'x', '',
  ]) {
    assert.equal(safeContentType(dangerous), 'application/octet-stream', dangerous);
  }
});

test('safeContentType: gallery media kept, normalized lowercase', () => {
  assert.equal(safeContentType('image/jpeg'), 'image/jpeg');
  assert.equal(safeContentType('Image/PNG'), 'image/png');
  assert.equal(safeContentType('video/mp4; codecs="avc1"'), 'video/mp4');
  assert.equal(safeContentType('video/quicktime'), 'video/quicktime');
});

test('safeContentType: non-string falls back instead of throwing', () => {
  for (const bad of [undefined, null, 42, {}, []]) {
    assert.equal(safeContentType(bad), 'application/octet-stream');
  }
});

test('uploadHeaders: gallery media inline so a click plays it', () => {
  for (const type of ['image/jpeg', 'image/png', 'video/mp4', 'video/quicktime']) {
    assert.deepEqual(uploadHeaders(type), { contentType: type, contentDisposition: 'inline' });
  }
});

test('uploadHeaders: anything renderable as a document is attachment', () => {
  for (const type of ['text/html', 'image/svg+xml', 'application/pdf', '', undefined]) {
    assert.deepEqual(uploadHeaders(type), {
      contentType: 'application/octet-stream',
      contentDisposition: 'attachment',
    }, String(type));
  }
});

test('parseListXml: nextToken null when not truncated', () => {
  assert.equal(parseListXml(SAMPLE_LIST_XML).nextToken, null);
});

test('parseListXml: nextToken present when truncated', () => {
  const xml = SAMPLE_LIST_XML.replace(
    '<IsTruncated>false</IsTruncated>',
    '<IsTruncated>true</IsTruncated><NextContinuationToken>tok==</NextContinuationToken>',
  );
  assert.equal(parseListXml(xml).nextToken, 'tok==');
});

test('parseListXml: response without Contents → empty list', () => {
  assert.deepEqual(
    parseListXml('<ListBucketResult><IsTruncated>false</IsTruncated></ListBucketResult>'),
    { files: [], nextToken: null },
  );
});

test('makeObjectName: timestamp prefix, preserved accents, dangerous characters replaced', () => {
  assert.equal(
    makeObjectName('été à la plage.jpg', 1700000000000),
    '1700000000000-été à la plage.jpg',
  );
  assert.equal(makeObjectName('a/b\\c?d#e.txt', 1), '1-a_b_c_d_e.txt');
});

test('displayName: removes path and timestamp', () => {
  assert.equal(displayName('projects/k/files/1700000000000-chat.jpg'), 'chat.jpg');
});

test('thumbKeyFor: files → thumbs, .jpg suffix', () => {
  assert.equal(thumbKeyFor('projects/k/files/1-chat.png'), 'projects/k/thumbs/1-chat.png.jpg');
});

test('isImage: recognized extensions, case-insensitive', () => {
  assert.ok(isImage('a.JPG'));
  assert.ok(isImage('b.webp'));
  assert.ok(isImage('c.heic'));
  assert.ok(!isImage('d.pdf'));
  assert.ok(!isImage('sans-extension'));
});

test('isVideo: browser-readable formats, case-insensitive', () => {
  assert.ok(isVideo('a.MP4'));
  assert.ok(isVideo('b.mov'));
  assert.ok(isVideo('c.webm'));
  assert.ok(isVideo('d.m4v'));
  assert.ok(!isVideo('e.jpg'));
  assert.ok(!isVideo('f.pdf'));
});

test('formatSize: human-readable units', () => {
  assert.equal(formatSize(500), '500 o');
  assert.equal(formatSize(2048), '2.0 Ko');
  assert.equal(formatSize(5 * 1024 ** 2), '5.0 Mo');
  assert.equal(formatSize(1536 * 1024 ** 2), '1.5 Go');
});

test('encodeKeyPath: encodes each segment, preserves /', () => {
  assert.equal(
    encodeKeyPath('projects/k/files/1-photo & fête.jpg'),
    'projects/k/files/1-photo%20%26%20f%C3%AAte.jpg',
  );
});

test('isValidLogin: accepts 2 to 16 lowercase alphanumeric chars', () => {
  assert.ok(isValidLogin('ab'));
  assert.ok(isValidLogin('alice2'));
  assert.ok(isValidLogin('a234567890123456'));
});

test('isValidLogin: rejects out-of-bounds, uppercase, special chars, non-string', () => {
  assert.ok(!isValidLogin('a'));
  assert.ok(!isValidLogin('a2345678901234567'));
  assert.ok(!isValidLogin('Alice'));
  assert.ok(!isValidLogin('ali-ce'));
  assert.ok(!isValidLogin(''));
  assert.ok(!isValidLogin(null));
});

test('parseProjectRef : "<login>/<clé>" → {login, key}', () => {
  const key = 'a'.repeat(16);
  assert.deepEqual(parseProjectRef(`alice/${key}`), { login: 'alice', key });
});

test('parseProjectRef: rejects old format, invalid segments, wrong depth', () => {
  const key = 'a'.repeat(16);
  assert.equal(parseProjectRef(key), null);
  assert.equal(parseProjectRef(`alice/${'a'.repeat(15)}`), null);
  assert.equal(parseProjectRef(`Alice/${key}`), null);
  assert.equal(parseProjectRef(`alice/${key}/extra`), null);
  assert.equal(parseProjectRef(''), null);
  assert.equal(parseProjectRef(null), null);
});

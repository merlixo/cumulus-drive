import { test } from 'node:test';
import assert from 'node:assert/strict';
import { crc32 as zlibCrc32 } from 'node:zlib';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, buildZip, dedupeNames } from '../site/lib.js';

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) {
    out.set(p, offset);
    offset += p.length;
  }
  return out;
}

function u32At(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0, true);
}

function u16At(bytes, offset) {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 2).getUint16(0, true);
}

test('crc32: reference vector "123456789"', () => {
  assert.equal(crc32(enc.encode('123456789')), 0xCBF43926);
});

test('crc32: identical to node:zlib on varied data', () => {
  const samples = [
    new Uint8Array(0),
    enc.encode('Cumulus ⛅ été à la plage'),
    Uint8Array.from({ length: 1000 }, (_, i) => (i * 7 + 13) % 256),
  ];
  for (const s of samples) assert.equal(crc32(s), zlibCrc32(s) >>> 0, `failed on ${s.length} bytes`);
});

test('dedupeNames: no duplicates, nothing changes', () => {
  assert.deepEqual(dedupeNames(['a.jpg', 'b.pdf']), ['a.jpg', 'b.pdf']);
});

test('dedupeNames: duplicates suffixed before extension', () => {
  assert.deepEqual(
    dedupeNames(['photo.jpg', 'photo.jpg', 'photo.jpg']),
    ['photo.jpg', 'photo (2).jpg', 'photo (3).jpg'],
  );
});

test('dedupeNames: without extension, suffix at end', () => {
  assert.deepEqual(dedupeNames(['notes', 'notes']), ['notes', 'notes (2)']);
});

const ENTRIES = [
  { name: 'été.txt', data: enc.encode('bonjour'), lastModified: new Date(2026, 7, 7, 12, 30, 42) },
  { name: 'doc.pdf', data: Uint8Array.from([1, 2, 3, 4, 5]), lastModified: new Date(2026, 0, 1) },
];

test('buildZip: coherent local, central and EOCD structures', () => {
  const bytes = concat(buildZip(ENTRIES));
  const name0 = enc.encode('été.txt');

  // First entry local header
  assert.equal(u32At(bytes, 0), 0x04034b50, 'local signature');
  assert.equal(u16At(bytes, 6), 0x0800, 'UTF-8 flag');
  assert.equal(u16At(bytes, 8), 0, 'STORE method');
  assert.equal(u32At(bytes, 14), crc32(ENTRIES[0].data), 'entry 1 CRC');
  assert.equal(u32At(bytes, 18), 7, 'compressed size = size');
  assert.equal(u16At(bytes, 26), name0.length, 'name length (UTF-8)');
  assert.deepEqual(bytes.slice(30, 30 + name0.length), name0, 'UTF-8 encoded name');
  assert.deepEqual(
    bytes.slice(30 + name0.length, 30 + name0.length + 7),
    ENTRIES[0].data,
    'uncompressed STORE data',
  );

  // EOCD at the very end
  const eocd = bytes.length - 22;
  assert.equal(u32At(bytes, eocd), 0x06054b50, 'EOCD signature');
  assert.equal(u16At(bytes, eocd + 10), 2, 'total number of entries');
  const centralStart = u32At(bytes, eocd + 16);
  assert.equal(u32At(bytes, centralStart), 0x02014b50, 'central directory signature');
  assert.equal(u32At(bytes, centralStart + 42), 0, 'entry 1 local offset');
});

test('buildZip: refuses entry ≥ 4 GiB without materializing it', () => {
  const huge = { name: 'trop.bin', data: { length: 0xFFFFFFFF }, lastModified: new Date() };
  assert.throws(() => buildZip([huge]), /trop volumineux/);
});

test('buildZip: archive validated by unzip -t', () => {
  const dir = mkdtempSync(join(tmpdir(), 'cumulus-zip-'));
  const path = join(dir, 'test.zip');
  writeFileSync(path, concat(buildZip(ENTRIES)));
  const out = execFileSync('unzip', ['-t', path], { encoding: 'utf8' });
  assert.match(out, /No errors detected/);
  assert.match(out, /doc\.pdf/);
});

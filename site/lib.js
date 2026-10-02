// Pure application logic, without DOM or network — tested by tests/lib.test.js.

export const KEY_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';
export const KEY_LENGTH = 16;

// 256 % 32 === 0: modulo introduces no bias.
export function generateKey() {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(KEY_LENGTH));
  let key = '';
  for (const b of bytes) key += KEY_ALPHABET[b % KEY_ALPHABET.length];
  return key;
}

// Single rule, derived from KEY_LENGTH: lowercase alphanumeric.
const KEY_RE = new RegExp(`^[a-z0-9]{${KEY_LENGTH}}$`);
export function isValidKey(key) {
  return typeof key === 'string' && KEY_RE.test(key);
}

// Path signable by Lambda: files/<name> or thumbs/<name>, single
// segment, same characters as makeObjectName, never "." or "..".
export function isValidSignPath(path) {
  if (typeof path !== 'string') return false;
  const match = path.match(/^(?:files|thumbs)\/(.+)$/);
  if (!match) return false;
  const name = match[1];
  if (name === '.' || name === '..' || name.length > 512) return false;
  return /^[\p{L}\p{N}. _()-]+$/u.test(name);
}

export function isValidLogin(login) {
  return typeof login === 'string' && /^[a-z0-9]{2,16}$/.test(login);
}

// Content-Type an upload may be stored with. Uploads are served from the same
// origin as the site, so a type the browser renders as a document (text/html,
// image/svg+xml…) would be stored XSS: only the media the gallery displays is
// kept as-is, anything else becomes an opaque download. Shared with the Lambda,
// which signs the *normalized* value — a client sending a different
// Content-Type header just gets a 403 from S3.
export const UPLOAD_TYPES = new Set([
  'image/jpeg', 'image/png', 'image/gif', 'image/webp',
  'image/heic', 'image/heif', 'image/avif',
  'video/mp4', 'video/quicktime', 'video/x-m4v', 'video/webm',
]);
export const FALLBACK_UPLOAD_TYPE = 'application/octet-stream';

export function safeContentType(type) {
  if (typeof type !== 'string') return FALLBACK_UPLOAD_TYPE;
  const normalized = type.split(';')[0].trim().toLowerCase();
  return UPLOAD_TYPES.has(normalized) ? normalized : FALLBACK_UPLOAD_TYPE;
}

// The two headers S3 stores with an upload and replays on every GET. Both are
// signed into the pre-signed PUT, so the uploader cannot pick them.
// `inline` is safe for exactly the types above — a raster image or a video
// cannot execute script, and image/svg+xml is deliberately absent from the
// list — so photos and videos open normally when their URL is visited.
// Anything else is octet-stream AND attachment: never a document on our origin.
export function uploadHeaders(type) {
  const contentType = safeContentType(type);
  return {
    contentType,
    contentDisposition: contentType === FALLBACK_UPLOAD_TYPE ? 'attachment' : 'inline',
  };
}

// Fragment of a share link: "<login>/<key>". Returns { login, key }
// or null (legacy "key only" format included).
export function parseProjectRef(fragment) {
  if (typeof fragment !== 'string') return null;
  const parts = fragment.split('/');
  if (parts.length !== 2) return null;
  const [login, key] = parts;
  return isValidLogin(login) && isValidKey(key) ? { login, key } : null;
}

export function buildShareLink(pageHref, key) {
  return `${pageHref.split('#')[0]}#${key}`;
}

// Minimalist parser for ListObjectsV2 XML response (no DOMParser in Node).
// Sufficient as S3 produces flat and predictable XML for these tags.
export function parseListXml(xml) {
  const files = [];
  const contentsRe = /<Contents>([\s\S]*?)<\/Contents>/g;
  let match;
  while ((match = contentsRe.exec(xml)) !== null) {
    const block = match[1];
    files.push({
      key: unescapeXml(tagValue(block, 'Key')),
      size: Number(tagValue(block, 'Size')),
      lastModified: tagValue(block, 'LastModified'),
    });
  }
  const truncated = tagValue(xml, 'IsTruncated') === 'true';
  const nextToken = truncated ? unescapeXml(tagValue(xml, 'NextContinuationToken')) : null;
  return { files, nextToken };
}

function tagValue(xml, tag) {
  const match = xml.match(new RegExp(`<${tag}>([\\s\\S]*?)</${tag}>`));
  return match ? match[1] : '';
}

function unescapeXml(text) {
  return text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&');
}

export function makeObjectName(originalName, nowMs) {
  const cleaned = originalName.normalize('NFC').replace(/[^\p{L}\p{N}. _()-]/gu, '_');
  return `${nowMs}-${cleaned}`;
}

export function displayName(key) {
  return key.split('/').pop().replace(/^\d+-/, '');
}

export function thumbKeyFor(fileKey) {
  return `${fileKey.replace('/files/', '/thumbs/')}.jpg`;
}

export function isImage(name) {
  return /\.(jpe?g|png|gif|webp|heic|avif)$/i.test(name);
}

export function isVideo(name) {
  return /\.(mp4|mov|m4v|webm)$/i.test(name);
}

export function formatSize(bytes) {
  if (bytes < 1024) return `${bytes} o`;
  const units = ['Ko', 'Mo', 'Go', 'To'];
  let value = bytes;
  let i = -1;
  do { value /= 1024; i += 1; } while (value >= 1024 && i < units.length - 1);
  return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[i]}`;
}

// Remaining-time estimate for the upload panel: "~45 s", "~3 min", "~1 h 05".
export function formatDuration(seconds) {
  if (!Number.isFinite(seconds) || seconds < 0) return '';
  if (seconds < 60) return `~${Math.max(5, Math.ceil(seconds / 5) * 5)} s`;
  const minutes = Math.ceil(seconds / 60);
  if (minutes < 60) return `~${minutes} min`;
  return `~${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')}`;
}

// Upload errors worth retrying on their own: network loss (0), timeouts,
// throttling and server-side failures. Anything else (403, 413…) is final.
export function isRetriableStatus(status) {
  return status === 0 || status === 408 || status === 429 || status >= 500;
}

// Backoff before automatic retry n (1-based).
export const RETRY_DELAYS_MS = [2000, 5000, 15000, 30000, 60000]; // ~2 min of outage covered
export function retryDelayMs(attempt) {
  return RETRY_DELAYS_MS[Math.min(attempt, RETRY_DELAYS_MS.length) - 1];
}

export function encodeKeyPath(key) {
  return key.split('/').map(encodeURIComponent).join('/');
}

// ---------- zip engine (STORE mode, no compression) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i += 1) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(date) {
  const d = date instanceof Date ? date : new Date(date);
  const year = Math.max(1980, d.getFullYear());
  return {
    dosDate: ((year - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate(),
    dosTime: (d.getHours() << 11) | (d.getMinutes() << 5) | Math.floor(d.getSeconds() / 2),
  };
}

const ZIP_MAX = 0xFFFFFFFF; // 32-bit zip format limits (no ZIP64)

// entries: [{name, data: Uint8Array, lastModified: Date}]
// Returns chunk array to pass directly to new Blob(parts) — data is not copied.
export function buildZip(entries) {
  const encoder = new TextEncoder();
  const parts = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const size = entry.data.length;
    if (size >= ZIP_MAX) throw new Error(`fichier trop volumineux pour un zip : ${entry.name}`);
    const nameBytes = encoder.encode(entry.name);
    const { dosTime, dosDate } = dosDateTime(entry.lastModified);
    const crc = crc32(entry.data);

    const local = new DataView(new ArrayBuffer(30));
    local.setUint32(0, 0x04034b50, true);
    local.setUint16(4, 20, true); // version needed
    local.setUint16(6, 0x0800, true); // flag: UTF-8 names
    local.setUint16(8, 0, true); // STORE method
    local.setUint16(10, dosTime, true);
    local.setUint16(12, dosDate, true);
    local.setUint32(14, crc, true);
    local.setUint32(18, size, true);
    local.setUint32(22, size, true);
    local.setUint16(26, nameBytes.length, true);
    local.setUint16(28, 0, true);
    parts.push(new Uint8Array(local.buffer), nameBytes, entry.data);

    central.push({ nameBytes, dosTime, dosDate, crc, size, offset });
    offset += 30 + nameBytes.length + size;
    if (offset >= ZIP_MAX) throw new Error('archive trop volumineuse pour un zip standard (4 Go max)');
  }

  const centralStart = offset;
  for (const c of central) {
    const header = new DataView(new ArrayBuffer(46));
    header.setUint32(0, 0x02014b50, true);
    header.setUint16(4, 20, true); // creator version
    header.setUint16(6, 20, true); // version needed
    header.setUint16(8, 0x0800, true);
    header.setUint16(10, 0, true);
    header.setUint16(12, c.dosTime, true);
    header.setUint16(14, c.dosDate, true);
    header.setUint32(16, c.crc, true);
    header.setUint32(20, c.size, true);
    header.setUint32(24, c.size, true);
    header.setUint16(28, c.nameBytes.length, true);
    header.setUint32(42, c.offset, true);
    parts.push(new Uint8Array(header.buffer), c.nameBytes);
    offset += 46 + c.nameBytes.length;
  }

  const eocd = new DataView(new ArrayBuffer(22));
  eocd.setUint32(0, 0x06054b50, true);
  eocd.setUint16(8, central.length, true);
  eocd.setUint16(10, central.length, true);
  eocd.setUint32(12, offset - centralStart, true);
  eocd.setUint32(16, centralStart, true);
  parts.push(new Uint8Array(eocd.buffer));
  return parts;
}

export function dedupeNames(names) {
  const seen = new Map();
  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) return name;
    const dot = name.lastIndexOf('.');
    return dot > 0
      ? `${name.slice(0, dot)} (${count + 1})${name.slice(dot)}`
      : `${name} (${count + 1})`;
  });
}

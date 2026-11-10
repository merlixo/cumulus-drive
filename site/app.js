import {
  buildShareLink, parseListXml, parseProjectRef, makeObjectName,
  displayName, thumbKeyFor, isImage, isVideo, formatSize, encodeKeyPath,
  buildZip, dedupeNames, safeContentType, uploadHeaders,
  formatDuration, isRetriableStatus, retryDelayMs, RETRY_DELAYS_MS,
} from './lib.js';
import { startCloud } from './cloud.js';

const $ = (sel) => document.querySelector(sel);
localStorage.removeItem('cumulus.projects'); // remnant of deleted "Visited Projects"
const LOGIN_STORAGE_KEY = 'cumulus.login';
let session = null; // { login, password } — tab memory only, never persisted

// Auth Lambda URL, injected during deployment via config.js.
const LAMBDA_URL = globalThis.CUMULUS_CONFIG?.lambdaUrl ?? null;

async function callAuthLambda(payload) {
  if (!LAMBDA_URL) throw new Error('fonctionnalité indisponible en local (config.js absent)');
  const res = await fetch(LAMBDA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, ok: res.ok, data };
}

// ---------- hero ----------

const cloud = startCloud($('#hero-cloud'), $('#hero-art'));

const HOME_HERO = {
  eyebrow: 'Partage de photos',
  title: 'Vos photos, dans un vrai nuage.',
  sub: 'Un lien à partager, et tout le monde ajoute les siennes.',
  size: 'tall',
};

// size: 'tall' on the login screen, 'compact' everywhere else.
function setHero({ eyebrow = '', title, sub = '', size = 'compact' }) {
  $('#hero').dataset.size = size;
  $('#hero-eyebrow').textContent = eyebrow;
  $('#hero-title').textContent = title;
  $('#hero-sub').textContent = sub;
}

function accountHero(projectCount) {
  return {
    eyebrow: `Connecté : ${session.login}`,
    title: 'Mes projets',
    sub: projectCount === undefined ? '' : projectCount === 0 ? 'Aucun projet pour l’instant'
      : `${projectCount} projet${projectCount > 1 ? 's' : ''}`,
  };
}

// ---------- routing ----------

function currentRef() {
  return parseProjectRef(location.hash.slice(1).trim());
}

function route() {
  const hasFragment = location.hash.length > 1;
  const ref = currentRef();
  $('#home-view').hidden = hasFragment;
  $('#project-view').hidden = !hasFragment;
  closeLightbox();
  if (!hasFragment) {
    $('#download-all').hidden = true; // lives in the hero, shared with the home view
    document.title = 'Cumulus';
    setHero(session ? accountHero(serverProjectCount) : HOME_HERO);
  }
  if (hasFragment) {
    if (ref) showProject(ref);
    else showNotFound();
  }
}

window.addEventListener('hashchange', route);

// ---------- home ----------

$('#account-login').value = localStorage.getItem(LOGIN_STORAGE_KEY) ?? '';

$('#login-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const login = $('#account-login').value.trim();
  const password = $('#account-password').value;
  const status = $('#login-status');
  status.textContent = 'Connexion…';
  try {
    const { status: code, ok, data } = await callAuthLambda({ action: 'list', login, password });
    if (code === 401) {
      status.textContent = 'Identifiants incorrects.';
      return;
    }
    if (!ok) throw new Error(data.error ?? `HTTP ${code}`);
    session = { login, password };
    localStorage.setItem(LOGIN_STORAGE_KEY, login);
    $('#account-password').value = '';
    status.textContent = '';
    $('#login-hero').hidden = true;
    $('#account-section').hidden = false;
    renderServerProjects(data.projects);
  } catch (err) {
    status.textContent = `Erreur : ${err.message}`;
  }
});

function renderServerProjects(projects) {
  const list = $('#server-projects');
  list.replaceChildren();
  for (const p of projects) {
    // Same-page hash link: the session (tab memory only) survives, and Back
    // returns to this list.
    const name = document.createElement('a');
    name.className = 'project-name';
    name.href = `#${session.login}/${p.key}`;
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = p.createdAt ? new Date(p.createdAt).toLocaleDateString('fr-FR') : '';
    const copy = iconButton('link', 'Copier le lien', `Copier le lien de « ${p.name} »`);
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(buildShareLink(location.href, `${session.login}/${p.key}`));
      copy.dataset.tip = 'Lien copié';
      setTimeout(() => { copy.dataset.tip = 'Copier le lien'; }, 1500);
    });
    // The padlock shows the state: open = uploads allowed, closed = read-only.
    const lock = iconButton('lock', '', `Verrouiller « ${p.name} »`);
    syncLock(lock, p.readOnly);
    lock.addEventListener('click', () => toggleReadOnly(p, lock));
    const del = iconButton('trash', 'Supprimer', `Supprimer « ${p.name} »`);
    del.classList.add('danger');
    del.addEventListener('click', () => deleteServerProject(p, del));
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    actions.append(copy, lock, del);
    const li = document.createElement('li');
    li.append(name, meta, actions);
    list.append(li);
  }
  $('#server-projects-empty').hidden = projects.length > 0;
  serverProjectCount = projects.length;
  if (!location.hash.slice(1)) setHero(accountHero(projects.length));
}

let serverProjectCount; // undefined until the first listing

async function refreshServerProjects() {
  const { ok, data } = await callAuthLambda({ action: 'list', ...session });
  if (ok) renderServerProjects(data.projects);
}

async function deleteServerProject(project, button) {
  if (!confirm(`Supprimer « ${project.name} » et tous ses fichiers ? Cette action est définitive.`)) return;
  button.disabled = true;
  try {
    const { ok, data } = await callAuthLambda({ action: 'delete', ...session, key: project.key });
    if (!ok) throw new Error(data.error ?? 'échec');
    await refreshServerProjects();
  } catch (err) {
    alert(`Suppression impossible : ${err.message}`);
    button.disabled = false;
  }
}

// Hand-drawn 24×24 stroke icons (no icon font or image: the CSP only allows 'self').
const ICONS = {
  lock: '<rect x="5" y="11" width="14" height="10" rx="2"/>'
    + '<path class="shackle" d="M8 11V7a4 4 0 0 1 8 0v4"/><circle class="keyhole" cx="12" cy="16" r="1.3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.66 0l3-3a4 4 0 0 0-5.66-5.66l-1 1"/>'
    + '<path d="M14 10a4 4 0 0 0-5.66 0l-3 3a4 4 0 0 0 5.66 5.66l1-1"/>',
  trash: '<path d="M4 7h16"/><path d="M9 7V4.5h6V7"/><path d="M6.5 7l.9 12.5h9.2L17.5 7"/>'
    + '<path d="M10 11v5.5"/><path d="M14 11v5.5"/>',
};

// tip: hover/focus bubble (data-tip); label: what screen readers announce.
function iconButton(name, tip, label) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'icon-button';
  button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true">${ICONS[name]}</svg>`;
  button.dataset.tip = tip;
  button.setAttribute('aria-label', label);
  return button;
}

function syncLock(button, readOnly) {
  button.classList.toggle('locked', readOnly);
  button.setAttribute('aria-pressed', String(readOnly));
  button.dataset.tip = readOnly ? 'Projet verrouillé · cliquer pour rouvrir' : 'Ajouts ouverts · cliquer pour verrouiller';
}

// Optimistic: the padlock animates on click and is put back if the Lambda refuses.
async function toggleReadOnly(project, button) {
  if (button.getAttribute('aria-busy') === 'true') return;
  const readOnly = !project.readOnly;
  button.setAttribute('aria-busy', 'true');
  syncLock(button, readOnly);
  try {
    const { ok, data } = await callAuthLambda({ action: 'setReadOnly', ...session, key: project.key, readOnly });
    if (!ok) throw new Error(data.error ?? 'échec');
    project.readOnly = readOnly;
  } catch (err) {
    syncLock(button, project.readOnly);
    alert(`Modification impossible : ${err.message}`);
  } finally {
    button.removeAttribute('aria-busy');
  }
}

$('#create-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const name = $('#project-name').value.trim();
  const status = $('#create-status');
  status.textContent = 'Création…';
  $('#create-result').hidden = true;
  try {
    const { status: code, ok, data } = await callAuthLambda({ action: 'create', ...session, name });
    if (code === 401) {
      status.textContent = 'Identifiants refusés — reconnectez-vous.';
      return;
    }
    if (!ok) throw new Error(data.error ?? `HTTP ${code}`);
    $('#share-link').value = buildShareLink(location.href, `${session.login}/${data.key}`);
    $('#create-result').hidden = false;
    status.textContent = '';
    $('#project-name').value = '';
    await refreshServerProjects();
  } catch (err) {
    status.textContent = `Erreur : ${err.message}`;
  }
});

$('#copy-link').addEventListener('click', async () => {
  await navigator.clipboard.writeText($('#share-link').value);
  $('#copy-link').textContent = 'Copié !';
  setTimeout(() => { $('#copy-link').textContent = 'Copier'; }, 1500);
});

// ---------- project view ----------

async function showProject(ref) {
  $('#not-found').hidden = true;
  $('#project-content').hidden = false;
  setHero({ eyebrow: 'Projet partagé', title: 'Chargement…' });
  const res = await fetch(`/${encodeKeyPath(`projects/${ref.login}/${ref.key}/manifest.json`)}`, { cache: 'no-store' });
  if (!res.ok) {
    showNotFound();
    return;
  }
  const manifest = await res.json();
  setReadOnlyView(manifest.readOnly === true);
  // The sub line is taken by the file stats (updateProjectSummary).
  setHero({ eyebrow: projectReadOnly ? 'Projet en lecture seule' : 'Projet partagé', title: manifest.name });
  document.title = `${manifest.name} — Cumulus`;
  currentProjectName = manifest.name;
  await refreshFiles(ref);
}

// Upload controls are only hidden here: the Lambda is what refuses to sign.
let projectReadOnly = false;
function setReadOnlyView(readOnly) {
  projectReadOnly = readOnly;
  $('#dropzone').hidden = readOnly;
  $('#empty-state').textContent = readOnly
    ? 'Aucun fichier dans ce projet.'
    : 'Aucun fichier pour l’instant. Soyez le premier à en ajouter !';
}

function showNotFound() {
  $('#project-content').hidden = true;
  $('#not-found').hidden = false;
  setHero({ eyebrow: 'Oups', title: 'Projet introuvable', sub: 'Vérifiez le lien qu’on vous a partagé.' });
}

let galleryKeys = []; // S3 keys of displayed media, in gallery order

async function refreshFiles(ref) {
  const files = [];
  let token = null;
  do {
    const params = new URLSearchParams({ 'list-type': '2', prefix: `projects/${ref.login}/${ref.key}/files/` });
    if (token) params.set('continuation-token', token);
    const res = await fetch(`/?${params.toString()}`, { cache: 'no-store' });
    if (!res.ok) {
      showNotFound();
      return;
    }
    const page = parseListXml(await res.text());
    files.push(...page.files);
    token = page.nextToken;
  } while (token);
  renderFiles(files);
}

function renderFiles(files) {
  const media = files.filter((f) => isImage(f.key) || isVideo(f.key));
  const others = files.filter((f) => !isImage(f.key) && !isVideo(f.key));
  filesByKey = new Map(files.map((f) => [f.key, f]));
  // Kept across refreshes: only files that disappeared leave the selection.
  for (const key of selection) if (!filesByKey.has(key)) selection.delete(key);
  updateSelectionBar();

  // Tiles still uploading to this project stay at the end of the gallery.
  const ref = currentRef();
  const pending = uploads.filter((u) => u.media && u.state !== 'done' && sameRef(u.ref, ref));
  $('#gallery').replaceChildren(...media.map((f) => makeMediaCell(f)), ...pending.map((u) => u.view.el));
  syncGalleryKeys();
  $('#file-list').replaceChildren(...others.map(makeFileRow));
  updateProjectSummary();
}

function syncGalleryKeys() {
  galleryKeys = [...$('#gallery').children].map((cell) => cell.dataset.key).filter(Boolean);
}

function updateProjectSummary() {
  $('#empty-state').hidden = filesByKey.size > 0 || uploads.length > 0;
  const totalSize = [...filesByKey.values()].reduce((n, f) => n + f.size, 0);
  const allBtn = $('#download-all');
  allBtn.hidden = filesByKey.size === 0;
  allBtn.textContent = `Tout télécharger (${formatSize(totalSize)})`;
  $('#hero-sub').textContent = projectStats([...filesByKey.keys()], totalSize);
}

// "12 photos · 2 vidéos · 1 fichier · 48 Mo" under the project title.
function projectStats(keys, totalSize) {
  if (keys.length === 0) return 'Aucun fichier pour l’instant';
  const photos = keys.filter(isImage).length;
  const videos = keys.filter(isVideo).length;
  const others = keys.length - photos - videos;
  const part = (n, word) => (n ? `${n} ${word}${n > 1 ? 's' : ''}` : null);
  return [part(photos, 'photo'), part(videos, 'vidéo'), part(others, 'fichier'), formatSize(totalSize)]
    .filter(Boolean).join(' · ');
}

// previewUrl: local thumbnail of a file just uploaded, so it does not flash
// while its S3 thumbnail is downloaded.
function makeMediaCell(f, previewUrl = null) {
  const video = isVideo(f.key);
  const cell = document.createElement('div');
  cell.className = video ? 'thumb-cell video' : 'thumb-cell';
  cell.dataset.key = f.key;
  const img = document.createElement('img');
  img.alt = displayName(f.key);
  img.loading = 'lazy';
  // No thumbnail: fallback to original for an image (e.g. HEIC);
  // dark tile with badge for a video (an <img> cannot display an mp4).
  img.addEventListener('error', () => {
    if (video) {
      img.hidden = true;
      backfillVideoThumb(f.key, img);
    } else {
      img.src = `/${encodeKeyPath(f.key)}`;
    }
  }, { once: true });
  img.src = previewUrl ?? `/${encodeKeyPath(thumbKeyFor(f.key))}`;
  cell.append(img);
  if (video) {
    const badge = document.createElement('span');
    badge.className = 'play-badge';
    badge.textContent = '▶';
    cell.append(badge);
  }
  cell.append(makeCheckbox(f.key));
  cell.addEventListener('click', (event) => {
    if (event.target.classList.contains('file-check')) return;
    openLightbox(galleryKeys.indexOf(f.key));
  });
  return cell;
}

function makeFileRow(f) {
  const a = document.createElement('a');
  a.href = `/${encodeKeyPath(f.key)}`;
  a.textContent = displayName(f.key);
  a.setAttribute('download', displayName(f.key));
  const meta = document.createElement('span');
  meta.className = 'file-meta';
  meta.textContent = `${formatSize(f.size)} · ${new Date(f.lastModified).toLocaleDateString('fr-FR')}`;
  const label = document.createElement('span');
  label.className = 'file-label';
  label.append(makeCheckbox(f.key), a);
  const li = document.createElement('li');
  li.append(label, meta);
  return li;
}

function makeCheckbox(key) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'file-check';
  cb.checked = selection.has(key);
  cb.addEventListener('change', () => toggleSelect(key, cb.checked));
  return cb;
}

// ---------- upload queue ----------

const MAX_UPLOAD_BYTES = 5 * 1024 ** 3; // single S3 PUT limit
const UPLOAD_CONCURRENCY = 3;
const SIGN_BATCH = 25; // file + thumbnail each: 50 objects, the Lambda's MAX_OBJECTS
const PREP_AHEAD = 8; // thumbnails made ahead of uploads, so one sign covers several files
const MAX_ATTEMPTS = 1 + RETRY_DELAYS_MS.length;
const URL_MAX_AGE_MS = 50 * 60 * 1000; // pre-signed URLs expire after 1 h (URL_TTL_SECONDS)
const STALL_MS = 60_000; // no upload progress for this long → aborted and retried

for (const inputId of ['#photo-input', '#file-input']) {
  $(inputId).addEventListener('change', (event) => {
    uploadFiles([...event.target.files]);
    event.target.value = '';
  });
}

const dropzone = $('#dropzone');
dropzone.addEventListener('dragover', (event) => {
  event.preventDefault();
  dropzone.classList.add('dragging');
});
dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragging'));
dropzone.addEventListener('drop', (event) => {
  event.preventDefault();
  dropzone.classList.remove('dragging');
  uploadFiles([...event.dataTransfer.files]);
});

// Headers signed into every pre-signed PUT (see presignPut in lambda/index.mjs):
// they must be sent verbatim, otherwise S3 rejects the upload with a 403.
// Same uploadHeaders() as the Lambda, so the values always agree.
const putHeaders = (type) => {
  const { contentType, contentDisposition } = uploadHeaders(type);
  return {
    'Content-Type': contentType,
    'Content-Disposition': contentDisposition,
    'If-None-Match': '*',
  };
};

class UploadError extends Error {
  constructor(message, { retriable = false, resign = false, rename = false } = {}) {
    super(message);
    Object.assign(this, { retriable, resign, rename });
  }
}

// state: queued → uploading → done, or → waiting (automatic retry) / failed (manual retry).
const uploads = [];
let activeUploads = 0;
let lastStamp = 0;
let prepChain = Promise.resolve();

const sameRef = (a, b) => Boolean(a && b) && a.login === b.login && a.key === b.key;
const isPending = (u) => u.state === 'queued' || u.state === 'uploading' || u.state === 'waiting';

// Strictly increasing per tab: parallel uploads of same-named files (iOS
// often names every pick "image.jpg") never collide on the same object key.
function uniqueStamp() {
  lastStamp = Math.max(Date.now(), lastStamp + 1);
  return lastStamp;
}

function uploadFiles(files) {
  const ref = currentRef();
  if (!ref || files.length === 0 || projectReadOnly) return;
  // New batch after the previous one settled: its successes leave the counters.
  if (!uploads.some(isPending)) {
    for (let i = uploads.length - 1; i >= 0; i -= 1) if (uploads[i].state === 'done') uploads.splice(i, 1);
    resetUploadRate();
  }
  for (const file of files) enqueueUpload(ref, file);
  updateProjectSummary();
  pumpUploads();
}

function enqueueUpload(ref, file) {
  const item = {
    ref,
    file,
    media: isImage(file.name) || isVideo(file.name),
    fileType: safeContentType(file.type), // empty type → octet-stream, never rejected by the Lambda
    state: 'queued',
    attempts: 0,
    loaded: 0,
    error: '',
    thumb: null,
    previewUrl: null,
    prep: null,
    prepared: false,
    urls: null,
    signedAt: 0,
    signing: null,
  };
  nameUpload(item);
  item.view = item.media ? makePendingCell(item) : makePendingRow(item);
  if (item.media) $('#gallery').append(item.view.el);
  else $('#upload-list').append(item.view.el);
  uploads.push(item);
  if (file.size > MAX_UPLOAD_BYTES) failUpload(item, 'fichier > 5 Go');
  else if (file.size === 0) failUpload(item, 'fichier vide'); // would make the Lambda reject the whole batch
  item.view.render();
}

function nameUpload(item) {
  const objectName = makeObjectName(item.file.name, uniqueStamp());
  item.filePath = `files/${objectName}`;
  item.thumbPath = `thumbs/${objectName}.jpg`;
  item.urls = null;
}

function failUpload(item, message) {
  item.state = 'failed';
  item.error = message;
}

function pumpUploads() {
  for (const item of uploads) {
    if (activeUploads >= UPLOAD_CONCURRENCY || pauseTimer) break;
    if (item.state === 'queued') runUpload(item);
  }
  uploads.filter((u) => u.state === 'queued').slice(0, PREP_AHEAD).forEach(prepareUpload);
  scheduleUploadPanel();
  updateWakeLock();
}

async function runUpload(item) {
  activeUploads += 1;
  item.state = 'uploading';
  item.attempts += 1;
  item.loaded = 0;
  item.view.render();
  try {
    await prepareUpload(item);
    await ensureSigned(item);
    await putFile(item);
    if (item.thumb) {
      // Thumbnail failure is harmless: the gallery falls back to the original.
      await fetch(item.urls[item.thumbPath], {
        method: 'PUT',
        headers: putHeaders('image/jpeg'),
        body: item.thumb,
      }).catch(() => {});
    }
    completeUpload(item);
  } catch (err) {
    handleUploadError(item, err instanceof UploadError ? err : new UploadError(err.message));
  } finally {
    activeUploads -= 1;
    pumpUploads();
  }
}

function handleUploadError(item, err) {
  item.loaded = 0;
  item.error = err.message;
  if (err.resign) item.urls = null;
  if (err.rename) nameUpload(item);
  if (err.retriable && (document.hidden || !navigator.onLine)) {
    // Phone locked, app switched or network lost: not the file's fault, the
    // attempt is given back and the upload resumes on return (resumeUploads).
    item.attempts -= 1;
    item.state = 'waiting';
    pauseUploads();
  } else if (err.retriable && item.attempts < MAX_ATTEMPTS) {
    item.state = 'waiting';
    pauseUploads();
  } else {
    item.state = 'failed';
  }
  item.view.render();
}

function requeueUpload(item) {
  if (item.state !== 'waiting' && item.state !== 'failed') return;
  item.state = 'queued';
  item.view.render();
  pumpUploads();
}

// Empty or oversized files fail for good: they can only be dismissed.
const canRetry = (u) => u.state === 'failed' && u.file.size > 0 && u.file.size <= MAX_UPLOAD_BYTES;

function retryUpload(item) {
  if (!canRetry(item)) return;
  item.attempts = 0;
  requeueUpload(item);
  if (pauseTimer) resumeUploads(); // a tap means "try now"
}

function dismissUpload(item) {
  if (item.state !== 'failed') return;
  uploads.splice(uploads.indexOf(item), 1);
  item.view.el.remove();
  scheduleUploadPanel();
  updateProjectSummary();
}

// A network failure pauses the whole queue, not just the failed file:
// otherwise every queued file would start, fail at once and burn its attempts
// during the same outage. Delay grows with consecutive failures.
let pauseTimer = 0;
let failureStreak = 0; // reset by any successful upload

function pauseUploads() {
  if (pauseTimer) return;
  failureStreak += 1;
  pauseTimer = setTimeout(resumeUploads, retryDelayMs(failureStreak));
  scheduleUploadPanel();
}

function resumeUploads() {
  clearTimeout(pauseTimer);
  pauseTimer = 0;
  uploads.filter((u) => u.state === 'waiting').forEach(requeueUpload);
  pumpUploads();
}

document.addEventListener('visibilitychange', () => {
  if (!document.hidden) resumeUploads();
});
window.addEventListener('online', resumeUploads);
window.addEventListener('beforeunload', (event) => {
  if (uploads.some(isPending)) event.preventDefault();
});
$('#retry-all').addEventListener('click', () => uploads.forEach(retryUpload));

// Thumbnails are made one at a time (memory: phone photos are 12–50 MP), in
// queue order and ahead of the uploads. Never rejects: no thumbnail is fine.
function prepareUpload(item) {
  item.prep ??= prepChain = prepChain.then(async () => {
    const { file } = item;
    item.thumb = isImage(file.name) ? await makeThumbnail(file).catch(() => null)
      : isVideo(file.name) ? await makeVideoThumbnail(file).catch(() => null)
        : null;
    if (item.thumb) {
      item.previewUrl = URL.createObjectURL(item.thumb);
      item.view.preview(item.previewUrl);
    }
    item.prepared = true;
  });
  return item.prep;
}

const urlsFresh = (u) => u.urls && Date.now() - u.signedAt < URL_MAX_AGE_MS;

// One Lambda call signs this file and the next prepared ones of the queue.
async function ensureSigned(item) {
  if (urlsFresh(item)) return;
  if (!item.signing) {
    const batch = [item, ...uploads.filter((u) => u !== item && u.state === 'queued' && u.prepared
      && !u.signing && !urlsFresh(u) && sameRef(u.ref, item.ref))].slice(0, SIGN_BATCH);
    const signing = signBatch(item.ref, batch);
    for (const u of batch) u.signing = signing;
    signing.catch(() => {}); // the other batch members re-sign on their own turn
  }
  await item.signing;
}

async function signBatch(ref, batch) {
  try {
    const objects = [];
    for (const u of batch) {
      objects.push({ path: u.filePath, type: u.fileType, size: u.file.size });
      if (u.thumb) objects.push({ path: u.thumbPath, type: 'image/jpeg', size: u.thumb.size });
    }
    let res;
    try {
      res = await callAuthLambda({ action: 'sign', login: ref.login, key: ref.key, objects });
    } catch (err) {
      // fetch() only throws a TypeError on network failure.
      throw new UploadError(err instanceof TypeError ? 'connexion perdue' : err.message,
        { retriable: err instanceof TypeError });
    }
    if (res.status === 403) throw new UploadError(res.data.error ?? 'projet introuvable');
    if (!res.ok) {
      throw new UploadError(res.data.error ?? `HTTP ${res.status}`, { retriable: isRetriableStatus(res.status) });
    }
    const signedAt = Date.now();
    for (const u of batch) {
      u.urls = res.data.urls;
      u.signedAt = signedAt;
    }
  } finally {
    for (const u of batch) u.signing = null;
  }
}

// XMLHttpRequest rather than fetch(): only it reports upload progress.
function putFile(item) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    let stallTimer;
    const watchStall = () => {
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => xhr.abort(), STALL_MS);
    };
    xhr.open('PUT', item.urls[item.filePath]);
    for (const [name, value] of Object.entries(putHeaders(item.fileType))) xhr.setRequestHeader(name, value);
    xhr.upload.addEventListener('progress', (event) => {
      watchStall();
      item.loaded = event.loaded;
      item.view.render();
      scheduleUploadPanel();
    });
    xhr.addEventListener('load', () => {
      clearTimeout(stallTimer);
      if (xhr.status >= 200 && xhr.status < 300) resolve();
      // 412 = key already exists. Names are unique per tab, so on a retry it
      // is this very file, stored by an attempt whose response was lost.
      else if (xhr.status === 412 && item.attempts > 1) resolve();
      else if (xhr.status === 412) reject(new UploadError('nom déjà pris', { retriable: true, rename: true }));
      // 403 = expired or rejected signature: signed again on the next attempt.
      else if (xhr.status === 403) reject(new UploadError('autorisation expirée', { retriable: true, resign: true }));
      else reject(new UploadError(`HTTP ${xhr.status}`, { retriable: isRetriableStatus(xhr.status) }));
    });
    xhr.addEventListener('error', () => {
      clearTimeout(stallTimer);
      reject(new UploadError(navigator.onLine ? 'connexion perdue' : 'hors ligne', { retriable: true }));
    });
    xhr.addEventListener('abort', () => reject(new UploadError('envoi bloqué', { retriable: true })));
    watchStall();
    xhr.send(item.file);
  });
}

function completeUpload(item) {
  failureStreak = 0;
  item.state = 'done';
  item.loaded = item.file.size;
  const { ref } = item;
  if (!sameRef(ref, currentRef())) return; // another project is displayed
  const f = {
    key: `projects/${ref.login}/${ref.key}/${item.filePath}`,
    size: item.file.size,
    lastModified: new Date().toISOString(),
  };
  filesByKey.set(f.key, f);
  if (item.media) {
    item.view.el.replaceWith(makeMediaCell(f, item.previewUrl));
    syncGalleryKeys();
  } else {
    item.view.el.remove();
    $('#file-list').append(makeFileRow(f));
  }
  updateProjectSummary();
}

// ---------- upload views ----------

const percent = (item) => Math.floor((100 * item.loaded) / item.file.size);

// Gallery tile shown as soon as a photo is picked; becomes a regular tile
// (makeMediaCell) once uploaded. A failed tile retries on tap.
function makePendingCell(item) {
  const cell = document.createElement('div');
  cell.className = 'thumb-cell pending';
  const img = document.createElement('img');
  img.alt = item.file.name;
  img.hidden = true;
  const name = document.createElement('span');
  name.className = 'pending-name';
  name.textContent = item.file.name;
  const label = document.createElement('span');
  label.className = 'pending-label';
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('span');
  bar.append(fill);
  cell.append(img, name, label, bar);
  cell.addEventListener('click', () => (canRetry(item) ? retryUpload(item) : dismissUpload(item)));
  return {
    el: cell,
    preview(url) {
      img.src = url;
      img.hidden = false;
      name.hidden = true;
    },
    render() {
      cell.classList.toggle('failed', item.state === 'failed');
      fill.style.width = `${item.state === 'uploading' ? percent(item) : 0}%`;
      bar.hidden = item.state !== 'uploading';
      label.textContent = {
        queued: 'en attente',
        uploading: `${percent(item)} %`,
        waiting: '↻ nouvel essai…',
        failed: `⚠ ${item.error}\nToucher pour ${canRetry(item) ? 'réessayer' : 'retirer'}`,
      }[item.state] ?? '';
    },
  };
}

// Row for a non-media file, in #upload-list until uploaded.
function makePendingRow(item) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.className = 'pending-row-name';
  label.textContent = item.file.name;
  const state = document.createElement('span');
  state.className = 'upload-state';
  const bar = document.createElement('div');
  bar.className = 'progress';
  const fill = document.createElement('span');
  bar.append(fill);
  li.append(label, state, bar);
  return {
    el: li,
    preview() {},
    render() {
      fill.style.width = `${item.state === 'uploading' ? percent(item) : 0}%`;
      bar.hidden = item.state !== 'uploading';
      state.replaceChildren();
      state.textContent = {
        queued: 'en attente',
        uploading: `${percent(item)} %`,
        waiting: 'nouvel essai…',
        failed: `échec (${item.error}) `,
      }[item.state] ?? '';
      if (item.state === 'failed') {
        const retry = canRetry(item);
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = retry ? 'réessayer' : 'retirer';
        btn.addEventListener('click', () => (retry ? retryUpload(item) : dismissUpload(item)), { once: true });
        state.append(btn);
      }
    },
  };
}

// ---------- upload panel ----------

let panelFrame = 0;
let rateStart = null; // { time, bytes } when the current run of uploads started
let panelHideTimer = 0;

function resetUploadRate() {
  rateStart = null;
}

function scheduleUploadPanel() {
  if (!panelFrame) panelFrame = requestAnimationFrame(updateUploadPanel);
}

function updateUploadPanel() {
  panelFrame = 0;
  clearTimeout(panelHideTimer);
  const panel = $('#upload-panel');
  cloud.setActive(uploads.some(isPending)); // hero cloud livens up while uploading
  if (uploads.length === 0) {
    panel.hidden = true;
    return;
  }
  panel.hidden = false;
  const count = (state) => uploads.filter((u) => u.state === state).length;
  const done = count('done');
  const failed = count('failed');
  const pending = uploads.filter(isPending).length;
  const totalBytes = uploads.reduce((n, u) => n + u.file.size, 0);
  const sentBytes = uploads.reduce((n, u) => n + (u.state === 'done' ? u.file.size : u.loaded), 0);
  $('#upload-progress').style.width = `${totalBytes ? (100 * sentBytes) / totalBytes : 0}%`;
  $('#retry-all').hidden = pending > 0 || !uploads.some(canRetry);
  $('#upload-hint').hidden = pending === 0;
  const plural = (n, words) => `${n} ${words.split(' ').map((w) => (n > 1 ? `${w}s` : w)).join(' ')}`;
  let text;
  if (pending > 0) {
    const now = Date.now();
    rateStart ??= { time: now, bytes: sentBytes };
    const elapsed = (now - rateStart.time) / 1000;
    const rate = (sentBytes - rateStart.bytes) / elapsed;
    const eta = elapsed > 3 && rate > 0 ? formatDuration((totalBytes - sentBytes) / rate) : '';
    text = `Envoi ${done}/${uploads.length} · ${formatSize(sentBytes)} / ${formatSize(totalBytes)}`;
    if (!navigator.onLine) text += ' · en attente de connexion';
    else if (pauseTimer) text += ' · connexion perdue, nouvel essai…';
    else if (eta) text += ` · ${eta}`;
    if (failed > 0) text += ` · ${plural(failed, 'échec')}`;
  } else if (failed > 0) {
    resetUploadRate();
    text = done > 0 ? `${plural(done, 'fichier envoyé')} · ${plural(failed, 'échec')}` : plural(failed, 'échec');
  } else {
    resetUploadRate();
    text = `✓ ${plural(done, 'fichier envoyé')}`;
    panelHideTimer = setTimeout(() => {
      if (uploads.some((u) => u.state !== 'done')) return;
      uploads.length = 0;
      updateUploadPanel();
      updateProjectSummary();
    }, 4000);
  }
  $('#upload-summary').textContent = text;
}

// Keeps the screen on while uploading: a locked phone suspends the page,
// which kills every upload in flight. Released by the browser when hidden.
let wakeLock = null; // WakeLockSentinel, or the request in flight

function updateWakeLock() {
  const busy = uploads.some(isPending);
  if (busy && !wakeLock && !document.hidden && navigator.wakeLock) {
    wakeLock = navigator.wakeLock.request('screen')
      .then((sentinel) => {
        sentinel.addEventListener('release', () => { wakeLock = null; });
        if (!uploads.some(isPending)) sentinel.release();
        return sentinel;
      })
      .catch(() => { wakeLock = null; });
  } else if (!busy && wakeLock) {
    Promise.resolve(wakeLock).then((sentinel) => sentinel?.release());
    wakeLock = null;
  }
}

async function makeThumbnail(file, maxDim = 400) {
  // Decoded straight at thumbnail height: much faster and lighter than a full
  // 12–50 MP decode on a phone. Browsers ignoring the option decode in full,
  // and the canvas below scales either way.
  const bitmap = await createImageBitmap(file, { resizeHeight: maxDim, resizeQuality: 'medium' })
    .catch(() => createImageBitmap(file));
  const scale = Math.min(1, maxDim / Math.max(bitmap.width, bitmap.height));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(bitmap.width * scale));
  canvas.height = Math.max(1, Math.round(bitmap.height * scale));
  canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
  bitmap.close();
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('toBlob'))), 'image/jpeg', 0.8);
  });
}

// Captures a representative video frame (File or URL) to serve as a thumbnail.
// Tries at 25%, 50%, then 75% of duration, discarding near-black frames (intro fade-ins).
async function makeVideoThumbnail(source, maxDim = 400) {
  const isFile = typeof source !== 'string';
  const url = isFile ? URL.createObjectURL(source) : source;
  try {
    return await captureVideoFrame(url, maxDim);
  } finally {
    if (isFile) URL.revokeObjectURL(url);
  }
}

function captureVideoFrame(url, maxDim) {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    const fractions = [0.25, 0.5, 0.75];
    let attempt = 0;
    const timer = setTimeout(() => reject(new Error('délai dépassé')), 20000);
    const done = (settle, value) => {
      clearTimeout(timer);
      video.removeAttribute('src');
      settle(value);
    };
    const seekTo = (fraction) => {
      const duration = Number.isFinite(video.duration) ? video.duration : 2;
      video.currentTime = Math.max(0.1, Math.min(duration * fraction, 30));
    };
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.addEventListener('error', () => done(reject, new Error('vidéo non décodable')), { once: true });
    video.addEventListener('loadeddata', () => seekTo(fractions[attempt]), { once: true });
    video.addEventListener('seeked', () => {
      const canvas = drawVideoFrame(video, maxDim);
      if (attempt < fractions.length - 1 && isNearBlack(canvas)) {
        attempt += 1;
        seekTo(fractions[attempt]);
        return;
      }
      canvas.toBlob((blob) => (blob ? done(resolve, blob) : done(reject, new Error('toBlob'))), 'image/jpeg', 0.8);
    });
    video.src = url;
  });
}

function drawVideoFrame(video, maxDim) {
  const scale = Math.min(1, maxDim / Math.max(video.videoWidth, video.videoHeight));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
  canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
  canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
  return canvas;
}

function isNearBlack(canvas) {
  const probe = document.createElement('canvas');
  probe.width = 16;
  probe.height = 16;
  const ctx = probe.getContext('2d');
  ctx.drawImage(canvas, 0, 0, 16, 16);
  const { data } = ctx.getImageData(0, 0, 16, 16);
  let sum = 0;
  for (let i = 0; i < data.length; i += 4) sum += data[i] + data[i + 1] + data[i + 2];
  return sum / (data.length / 4) / 3 < 12;
}

// Video without thumbnail (legacy upload or failed generation): created from
// online video, displayed and stored for future visitors.
const thumbBackfillTried = new Set();
let backfillQueue = Promise.resolve();

function backfillVideoThumb(key, img) {
  if (thumbBackfillTried.has(key)) return;
  thumbBackfillTried.add(key);
  backfillQueue = backfillQueue
    .then(async () => {
      const blob = await makeVideoThumbnail(`/${encodeKeyPath(key)}`);
      const thumbPath = `thumbs/${key.split('/').pop()}.jpg`;
      try {
        const ref = currentRef();
        if (ref && !projectReadOnly) {
          const { ok, data } = await callAuthLambda({
            action: 'sign',
            login: ref.login,
            key: ref.key,
            objects: [{ path: thumbPath, type: 'image/jpeg', size: blob.size }],
          });
          if (ok) {
            // 412 if another visitor already backfilled it (If-None-Match): the
            // thumbnail is displayed locally either way.
            await fetch(data.urls[thumbPath], {
              method: 'PUT',
              headers: putHeaders('image/jpeg'),
              body: blob,
            }).catch(() => {});
          }
        }
      } catch { /* storage impossible (e.g. local preview): display only */ }
      img.src = URL.createObjectURL(blob);
      img.hidden = false;
    })
    .catch(() => { /* codec non-decodable here: dark tile remains */ });
}

// ---------- selection and bulk download ----------

let filesByKey = new Map();
const selection = new Set();
let currentProjectName = 'cumulus';
let bulkBusy = false;

function toggleSelect(key, checked) {
  if (checked) selection.add(key);
  else selection.delete(key);
  updateSelectionBar();
}

function updateSelectionBar() {
  if (bulkBusy) return; // bar shows progress, do not overwrite
  const bar = $('#selection-bar');
  if (selection.size === 0) {
    bar.hidden = true;
    return;
  }
  bar.hidden = false;
  const total = [...selection].reduce((n, k) => n + (filesByKey.get(k)?.size ?? 0), 0);
  $('#selection-info').textContent =
    `${selection.size} fichier${selection.size > 1 ? 's' : ''} — ${formatSize(total)}`;
}

function setBulkControls(disabled) {
  for (const id of ['#download-all', '#download-selected', '#select-all', '#clear-selection']) {
    $(id).disabled = disabled;
  }
}

async function downloadKeys(keys) {
  const files = keys.map((k) => filesByKey.get(k)).filter(Boolean);
  if (files.length === 0 || bulkBusy) return;
  if (files.length === 1) {
    triggerDownload(`/${encodeKeyPath(files[0].key)}`, displayName(files[0].key));
    return;
  }
  const total = files.reduce((n, f) => n + f.size, 0);
  if (total > 1024 ** 3
    && !confirm(`Préparer un zip de ${formatSize(total)} ? Cela peut prendre du temps et de la mémoire.`)) {
    return;
  }

  bulkBusy = true;
  setBulkControls(true);
  const info = $('#selection-info');
  $('#selection-bar').hidden = false;
  try {
    const names = dedupeNames(files.map((f) => displayName(f.key)));
    const entries = [];
    for (let i = 0; i < files.length; i += 1) {
      info.textContent = `Préparation ${i + 1}/${files.length}…`;
      const res = await fetch(`/${encodeKeyPath(files[i].key)}`);
      if (!res.ok) throw new Error(`échec sur ${displayName(files[i].key)} (HTTP ${res.status})`);
      entries.push({
        name: names[i],
        data: new Uint8Array(await res.arrayBuffer()),
        lastModified: new Date(files[i].lastModified),
      });
    }
    const blob = new Blob(buildZip(entries), { type: 'application/zip' });
    const zipName = `${currentProjectName.replace(/[^\p{L}\p{N}. _()-]/gu, '_') || 'cumulus'}.zip`;
    triggerDownload(URL.createObjectURL(blob), zipName);
    info.textContent = 'Zip prêt !';
    setTimeout(() => { bulkBusy = false; updateSelectionBar(); }, 2000);
  } catch (err) {
    info.textContent = `Erreur : ${err.message}`;
    setTimeout(() => { bulkBusy = false; updateSelectionBar(); }, 5000);
  } finally {
    setBulkControls(false);
  }
}

function triggerDownload(href, filename) {
  const a = document.createElement('a');
  a.href = href;
  a.download = filename;
  document.body.append(a);
  a.click();
  a.remove();
  if (href.startsWith('blob:')) setTimeout(() => URL.revokeObjectURL(href), 60_000);
}

$('#download-all').addEventListener('click', () => downloadKeys([...filesByKey.keys()]));
$('#download-selected').addEventListener('click', () => downloadKeys([...selection]));
$('#select-all').addEventListener('click', () => {
  for (const key of filesByKey.keys()) selection.add(key);
  document.querySelectorAll('.file-check').forEach((cb) => { cb.checked = true; });
  updateSelectionBar();
});
$('#clear-selection').addEventListener('click', () => {
  selection.clear();
  document.querySelectorAll('.file-check').forEach((cb) => { cb.checked = false; });
  updateSelectionBar();
});

// ---------- viewer / lightbox ----------

let lightboxIndex = 0;

function openLightbox(index) {
  lightboxIndex = index;
  $('#lightbox').hidden = false;
  showLightboxImage();
}

function showLightboxImage() {
  const key = galleryKeys[lightboxIndex];
  const img = $('#lb-img');
  const video = $('#lb-video');
  video.pause();
  if (isVideo(key)) {
    img.hidden = true;
    img.removeAttribute('src');
    video.hidden = false;
    video.src = `/${encodeKeyPath(key)}`;
    // Opening the lightbox is a user gesture, so playback is allowed; a refusal
    // (unsupported codec, browser policy) just leaves the controls visible.
    video.play().catch(() => {});
  } else {
    video.hidden = true;
    video.removeAttribute('src');
    img.hidden = false;
    img.src = `/${encodeKeyPath(key)}`;
  }
  $('#lb-prev').disabled = lightboxIndex === 0;
  $('#lb-next').disabled = lightboxIndex === galleryKeys.length - 1;
}

function closeLightbox() {
  const video = $('#lb-video');
  video.pause();
  video.removeAttribute('src');
  $('#lightbox').hidden = true;
}

function moveLightbox(delta) {
  const next = lightboxIndex + delta;
  if (next >= 0 && next < galleryKeys.length) {
    lightboxIndex = next;
    showLightboxImage();
  }
}

$('#lb-prev').addEventListener('click', () => moveLightbox(-1));
$('#lb-next').addEventListener('click', () => moveLightbox(1));
$('#lb-close').addEventListener('click', closeLightbox);
$('#lightbox').addEventListener('click', (event) => {
  if (event.target === $('#lightbox')) closeLightbox();
});
document.addEventListener('keydown', (event) => {
  if ($('#lightbox').hidden) return;
  if (event.key === 'Escape') closeLightbox();
  if (event.key === 'ArrowLeft') moveLightbox(-1);
  if (event.key === 'ArrowRight') moveLightbox(1);
});

route();

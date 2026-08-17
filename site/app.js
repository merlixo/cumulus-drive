import {
  buildShareLink, parseListXml, parseProjectRef, makeObjectName,
  displayName, thumbKeyFor, isImage, isVideo, formatSize, encodeKeyPath,
  buildZip, dedupeNames,
} from './lib.js';

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
    $('#account-title').textContent = `Connecté : ${login}`;
    renderServerProjects(data.projects);
  } catch (err) {
    status.textContent = `Erreur : ${err.message}`;
  }
});

function renderServerProjects(projects) {
  const list = $('#server-projects');
  list.replaceChildren();
  for (const p of projects) {
    const name = document.createElement('span');
    name.className = 'project-name';
    name.textContent = p.name;
    const meta = document.createElement('span');
    meta.className = 'file-meta';
    meta.textContent = p.createdAt ? new Date(p.createdAt).toLocaleDateString('fr-FR') : '';
    const copy = document.createElement('button');
    copy.type = 'button';
    copy.textContent = 'Copier le lien';
    copy.addEventListener('click', async () => {
      await navigator.clipboard.writeText(buildShareLink(location.href, `${session.login}/${p.key}`));
      copy.textContent = 'Copié !';
      setTimeout(() => { copy.textContent = 'Copier le lien'; }, 1500);
    });
    const del = document.createElement('button');
    del.type = 'button';
    del.className = 'secondary';
    del.textContent = 'Supprimer';
    del.addEventListener('click', () => deleteServerProject(p, del));
    const actions = document.createElement('div');
    actions.className = 'project-actions';
    actions.append(copy, del);
    const li = document.createElement('li');
    li.append(name, meta, actions);
    list.append(li);
  }
  $('#server-projects-empty').hidden = projects.length > 0;
}

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
  $('#project-title').textContent = 'Chargement…';
  const res = await fetch(`/${encodeKeyPath(`projects/${ref.login}/${ref.key}/manifest.json`)}`, { cache: 'no-store' });
  if (!res.ok) {
    showNotFound();
    return;
  }
  const manifest = await res.json();
  $('#project-title').textContent = manifest.name;
  document.title = `${manifest.name} — Cumulus`;
  currentProjectName = manifest.name;
  await refreshFiles(ref);
}

function showNotFound() {
  $('#project-content').hidden = true;
  $('#not-found').hidden = false;
  $('#project-title').textContent = 'Projet introuvable';
}

let galleryKeys = []; // S3 keys of displayed images, in gallery order

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
  galleryKeys = media.map((f) => f.key);
  filesByKey = new Map(files.map((f) => [f.key, f]));
  selection.clear();
  updateSelectionBar();

  const gallery = $('#gallery');
  gallery.replaceChildren();
  media.forEach((f, index) => {
    const video = isVideo(f.key);
    const cell = document.createElement('div');
    cell.className = video ? 'thumb-cell video' : 'thumb-cell';
    const img = document.createElement('img');
    img.src = `/${encodeKeyPath(thumbKeyFor(f.key))}`;
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
      openLightbox(index);
    });
    gallery.append(cell);
  });

  const list = $('#file-list');
  list.replaceChildren();
  for (const f of others) {
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
    list.append(li);
  }

  $('#empty-state').hidden = files.length > 0;
  const totalSize = files.reduce((n, f) => n + f.size, 0);
  const allBtn = $('#download-all');
  allBtn.hidden = files.length === 0;
  allBtn.textContent = `Tout télécharger (${formatSize(totalSize)})`;
}

function makeCheckbox(key) {
  const cb = document.createElement('input');
  cb.type = 'checkbox';
  cb.className = 'file-check';
  cb.checked = selection.has(key);
  cb.addEventListener('change', () => toggleSelect(key, cb.checked));
  return cb;
}

const MAX_UPLOAD_BYTES = 5 * 1024 ** 3; // single S3 PUT limit

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

async function uploadFiles(files) {
  const ref = currentRef();
  if (!ref) return;
  for (const file of files) {
    await uploadOne(ref, file, addUploadRow(file.name));
  }
  await refreshFiles(ref);
}

async function uploadOne(ref, file, row) {
  if (file.size > MAX_UPLOAD_BYTES) {
    row.fail('fichier > 5 Go');
    return;
  }
  const objectName = makeObjectName(file.name, Date.now());
  const filePath = `files/${objectName}`;
  const thumbPath = `thumbs/${objectName}.jpg`;
  const fileType = file.type || 'application/octet-stream';
  row.status('envoi…');
  try {
    // Generation failure (HEIC, undecodable codec…) → no thumbnail, gallery has a fallback.
    const thumb = isImage(file.name) ? await makeThumbnail(file).catch(() => null)
      : isVideo(file.name) ? await makeVideoThumbnail(file).catch(() => null)
        : null;
    const objects = [{ path: filePath, type: fileType, size: file.size }];
    if (thumb) objects.push({ path: thumbPath, type: 'image/jpeg', size: thumb.size });
    const { status: code, ok, data } = await callAuthLambda({ action: 'sign', login: ref.login, key: ref.key, objects });
    if (code === 403) throw new Error('projet introuvable');
    if (!ok) throw new Error(data.error ?? `HTTP ${code}`);
    const res = await fetch(data.urls[filePath], {
      method: 'PUT',
      headers: { 'Content-Type': fileType },
      body: file,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    if (thumb) {
      await fetch(data.urls[thumbPath], {
        method: 'PUT',
        headers: { 'Content-Type': 'image/jpeg' },
        body: thumb,
      }).catch(() => {});
    }
    row.ok();
  } catch (err) {
    row.fail(err.message, () => uploadOne(ref, file, row).then(() => refreshFiles(ref)));
  }
}

function addUploadRow(name) {
  const li = document.createElement('li');
  const label = document.createElement('span');
  label.textContent = name;
  const state = document.createElement('span');
  state.className = 'upload-state';
  li.append(label, state);
  $('#upload-list').append(li);
  return {
    status(text) {
      state.replaceChildren();
      state.textContent = text;
    },
    ok() {
      state.replaceChildren();
      state.textContent = '✓';
      setTimeout(() => li.remove(), 3000);
    },
    fail(message, retry) {
      state.replaceChildren();
      state.textContent = `échec (${message}) `;
      if (retry) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.textContent = 'réessayer';
        btn.addEventListener('click', retry, { once: true });
        state.append(btn);
      }
    },
  };
}

async function makeThumbnail(file, maxDim = 400) {
  const bitmap = await createImageBitmap(file);
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
        if (ref) {
          const { ok, data } = await callAuthLambda({
            action: 'sign',
            login: ref.login,
            key: ref.key,
            objects: [{ path: thumbPath, type: 'image/jpeg', size: blob.size }],
          });
          if (ok) {
            await fetch(data.urls[thumbPath], {
              method: 'PUT',
              headers: { 'Content-Type': 'image/jpeg' },
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

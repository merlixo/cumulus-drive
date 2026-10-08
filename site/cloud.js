// Hero animation: a cumulus drawn as a 3D point cloud with a light network
// mesh, "upload" particles rising into it and a data sweep across it.
// Plain 2D canvas with a hand-rolled projection — no dependency, since the
// CSP only allows scripts from 'self'.

// Overlapping spheres (x, y, z, radius), y up: wide flat base, rounded towers.
const PUFFS = [
  [0, 0.15, 0, 1.0],
  [-1.0, -0.15, 0.15, 0.78],
  [1.05, -0.2, -0.1, 0.72],
  [-0.4, 0.75, -0.05, 0.62],
  [0.45, 0.62, 0.2, 0.55],
  [-1.75, -0.45, 0, 0.45],
  [1.8, -0.5, 0.1, 0.42],
  [0.1, -0.3, 0.65, 0.62],
  [-0.2, -0.25, -0.65, 0.6],
];
const BASE_Y = -0.72; // flat cumulus base
const HALF_WIDTH = 2.3; // model extent, for scaling into the art box
const HALF_HEIGHT = 1.45;
const PALETTE = [[34, 211, 238], [59, 130, 246], [168, 85, 247]]; // cyan → blue → violet
const CAMERA = 4.5;
const RISERS_IDLE = 14; // rising "uploads"; all RISERS_MAX while files upload
const RISERS_MAX = 40;
const RISER_START = -HALF_HEIGHT; // risers stay inside the art box, under the base
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

// Deterministic noise: the cloud looks the same on every visit.
function random(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

function paletteAt(t) {
  const x = Math.min(1, Math.max(0, t)) * (PALETTE.length - 1);
  const i = Math.min(PALETTE.length - 2, Math.floor(x));
  const f = x - i;
  return PALETTE[i].map((c, k) => Math.round(c + (PALETTE[i + 1][k] - c) * f));
}

function insideOther(p, self) {
  return PUFFS.some(([x, y, z, r], i) => i !== self
    && (p[0] - x) ** 2 + (p[1] - y) ** 2 + (p[2] - z) ** 2 < (r * 0.97) ** 2);
}

// Points on the visible surface of the sphere union, plus the flat base.
function buildCloud(count) {
  const rand = random(7);
  const area = PUFFS.reduce((n, [, , , r]) => n + r * r, 0);
  const points = [];
  PUFFS.forEach(([cx, cy, cz, r], self) => {
    const n = Math.round((count * r * r) / area);
    for (let k = 0; k < n; k += 1) {
      const y = 1 - (2 * (k + 0.5)) / n;
      const ring = Math.sqrt(1 - y * y);
      const theta = k * GOLDEN_ANGLE;
      const jitter = 1 + (rand() - 0.5) * 0.06;
      const p = [cx + r * jitter * Math.cos(theta) * ring, cy + r * jitter * y, cz + r * jitter * Math.sin(theta) * ring];
      if (p[1] >= BASE_Y && !insideOther(p, self)) points.push({ p, base: false });
    }
  });
  const step = 0.19;
  for (let x = -2.2; x <= 2.2; x += step) {
    for (let z = -1.2; z <= 1.2; z += step) {
      const inside = PUFFS.some(([cx, cy, cz, r]) => r * r - (BASE_Y - cy) ** 2 > (x - cx) ** 2 + (z - cz) ** 2);
      if (inside) points.push({ p: [x + (rand() - 0.5) * 0.05, BASE_Y, z + (rand() - 0.5) * 0.05], base: true });
    }
  }
  for (const pt of points) {
    pt.rgb = paletteAt((pt.p[0] + HALF_WIDTH) / (2 * HALF_WIDTH) + pt.p[1] * 0.12);
    pt.phase = rand() * Math.PI * 2;
  }
  return { points, links: buildLinks(points) };
}

// Each point linked to its two nearest neighbours: a light network mesh.
function buildLinks(points) {
  const links = new Set();
  points.forEach((a, i) => {
    let best = [[Infinity, -1], [Infinity, -1]];
    points.forEach((b, j) => {
      if (i === j) return;
      const d = (a.p[0] - b.p[0]) ** 2 + (a.p[1] - b.p[1]) ** 2 + (a.p[2] - b.p[2]) ** 2;
      if (d < best[1][0]) best = d < best[0][0] ? [[d, j], best[0]] : [best[0], [d, j]];
    });
    for (const [d, j] of best) if (j >= 0 && d < 0.1) links.add(i < j ? `${i}:${j}` : `${j}:${i}`);
  });
  return [...links].map((key) => key.split(':').map(Number));
}

function makeRiser(rand, startLow) {
  return {
    x: (rand() - 0.5) * 3.2,
    z: (rand() - 0.5) * 1.2,
    y: startLow ? RISER_START : RISER_START + rand() * (BASE_Y - RISER_START),
    speed: 0.25 + rand() * 0.3,
  };
}

// canvas covers the whole hero; art: the element whose box the cloud fills.
// Returns { setActive(bool) }: livelier while files are uploading.
export function startCloud(canvas, art) {
  const ctx = canvas.getContext('2d');
  const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
  const rand = random(42);
  let cloud = null;
  let cloudSize = 0;
  let risers = [];
  let width = 0;
  let height = 0;
  let dpr = 1;
  let frame = 0;
  let onScreen = true;
  let active = false;
  let activity = 0; // eased 0 → 1 towards `active`
  let sweepPhase = 0;
  const pointer = { x: 0, y: 0, tx: 0, ty: 0 };

  function resize() {
    dpr = Math.min(devicePixelRatio || 1, 2);
    width = canvas.clientWidth;
    height = canvas.clientHeight;
    canvas.width = Math.round(width * dpr);
    canvas.height = Math.round(height * dpr);
    const size = width < 640 ? 680 : 960; // fewer points on phones
    if (size !== cloudSize) {
      cloud = buildCloud(size);
      cloudSize = size;
      risers = Array.from({ length: RISERS_MAX }, () => makeRiser(rand, false));
    }
    if (!frame) draw(performance.now());
  }

  function draw(now) {
    const t = now / 1000;
    const dt = frame ? Math.min(0.05, t - (draw.last ?? t)) : 0;
    draw.last = t;
    pointer.x += (pointer.tx - pointer.x) * 0.04;
    pointer.y += (pointer.ty - pointer.y) * 0.04;
    activity += ((active ? 1 : 0) - activity) * Math.min(1, dt * 2);

    // Cloud centred in the art box, in canvas pixels.
    const c = canvas.getBoundingClientRect();
    const a = art.getBoundingClientRect();
    const cx = (a.left - c.left + a.width / 2) * dpr;
    const cy = (a.top - c.top + a.height / 2) * dpr;
    const scale = Math.min(a.width / (2 * HALF_WIDTH), a.height / (2 * HALF_HEIGHT)) * dpr;
    const bob = Math.sin(t * 0.6) * 0.05;

    // Gentle sway rather than a full turn: side-on, a cumulus stops reading as one.
    const ay = Math.sin(t * 0.22) * 0.5 + pointer.x * 0.35;
    const ax = -0.2 + pointer.y * 0.12;
    const [sinY, cosY, sinX, cosX] = [Math.sin(ay), Math.cos(ay), Math.sin(ax), Math.cos(ax)];
    const project = ([x, y, z]) => {
      const x1 = x * cosY + z * sinY;
      const z1 = -x * sinY + z * cosY;
      const y1 = (y + bob) * cosX - z1 * sinX;
      const z2 = (y + bob) * sinX + z1 * cosX;
      const s = CAMERA / (CAMERA + z2);
      return [cx + x1 * s * scale, cy - y1 * s * scale, Math.min(1, Math.max(0, 0.5 - z2 / 3))];
    };

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = 'lighter';

    const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, scale * 2.6);
    glow.addColorStop(0, 'rgba(59, 130, 246, 0.22)');
    glow.addColorStop(0.5, 'rgba(124, 58, 237, 0.08)');
    glow.addColorStop(1, 'rgba(0, 0, 0, 0)');
    ctx.fillStyle = glow;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // Data sweep: a bright band crossing the cloud every few seconds.
    sweepPhase = (sweepPhase + dt * (0.18 + 0.3 * activity)) % 1;
    const sweepX = sweepPhase * 7 - 3.5;
    const projected = cloud.points.map((pt) => {
      const [x, y, depth] = project(pt.p);
      const sweep = Math.exp(-((pt.p[0] - sweepX) ** 2) / 0.06);
      return { x, y, depth, sweep };
    });

    // Mesh, batched into a few strokes by brightness.
    const buckets = [[], [], [], []];
    for (const [i, j] of cloud.links) {
      const p = projected[i];
      const q = projected[j];
      const depth = (p.depth + q.depth) / 2;
      const sweep = Math.max(p.sweep, q.sweep);
      buckets[sweep > 0.35 ? 3 : depth > 0.66 ? 2 : depth > 0.33 ? 1 : 0].push(p, q);
    }
    ctx.lineWidth = dpr * 0.8;
    ['rgba(96,140,255,0.05)', 'rgba(110,160,255,0.11)', 'rgba(140,190,255,0.2)', 'rgba(120,240,255,0.55)']
      .forEach((style, b) => {
        ctx.strokeStyle = style;
        ctx.beginPath();
        const segs = buckets[b];
        for (let k = 0; k < segs.length; k += 2) {
          ctx.moveTo(segs[k].x, segs[k].y);
          ctx.lineTo(segs[k + 1].x, segs[k + 1].y);
        }
        ctx.stroke();
      });

    // Points: nearer = bigger and brighter, gentle twinkle, white-hot in the sweep.
    const unit = Math.max(0.7, scale / (130 * dpr)) * dpr;
    cloud.points.forEach((pt, i) => {
      const { x, y, depth, sweep } = projected[i];
      const twinkle = 0.78 + 0.22 * Math.sin(t * 1.6 + pt.phase);
      const alpha = (pt.base ? 0.35 : 1) * (0.3 + 0.7 * depth) * twinkle;
      const [r, g, b] = pt.rgb.map((v) => Math.round(v + (235 - v) * sweep * 0.8));
      ctx.fillStyle = `rgba(${r},${g},${b},${Math.min(1, alpha + sweep * 0.5).toFixed(3)})`;
      const size = unit * (0.9 + 1.7 * depth) * (1 + sweep * 0.9);
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    });

    // Uploads: particles rising from below into the cloud base.
    ctx.lineWidth = unit * 1.1;
    const count = Math.round(RISERS_IDLE + (RISERS_MAX - RISERS_IDLE) * activity);
    for (let k = 0; k < count; k += 1) {
      const riser = risers[k];
      riser.y += riser.speed * (1 + activity) * dt;
      if (riser.y > BASE_Y + 0.05) risers[k] = makeRiser(rand, true);
      const life = Math.min(1, (riser.y - RISER_START) / 0.25) * Math.min(1, (BASE_Y + 0.05 - riser.y) / 0.25);
      const [hx, hy] = project([riser.x, riser.y, riser.z]);
      const [tx, ty] = project([riser.x, riser.y - 0.22, riser.z]);
      const trail = ctx.createLinearGradient(tx, ty, hx, hy);
      trail.addColorStop(0, 'rgba(34,211,238,0)');
      trail.addColorStop(1, `rgba(120,240,255,${(0.7 * life).toFixed(3)})`);
      ctx.strokeStyle = trail;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(hx, hy);
      ctx.stroke();
      ctx.fillStyle = `rgba(200,250,255,${(0.9 * life).toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(hx, hy, unit * 1.3, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalCompositeOperation = 'source-over';
  }

  function loop(now) {
    draw(now);
    frame = requestAnimationFrame(loop);
  }

  // Runs only when it can be seen, and never for reduced-motion users (who
  // get a single still frame).
  function update() {
    const run = onScreen && !document.hidden && !reducedMotion.matches;
    if (run && !frame) frame = requestAnimationFrame(loop);
    if (!run && frame) {
      cancelAnimationFrame(frame);
      frame = 0;
      draw.last = undefined;
      draw(performance.now());
    }
  }

  new ResizeObserver(resize).observe(canvas);
  new IntersectionObserver(([entry]) => {
    onScreen = entry.isIntersecting;
    update();
  }).observe(canvas);
  document.addEventListener('visibilitychange', update);
  reducedMotion.addEventListener('change', update);
  addEventListener('pointermove', (event) => {
    pointer.tx = (event.clientX / innerWidth - 0.5) * 2;
    pointer.ty = (event.clientY / innerHeight - 0.5) * 2;
  }, { passive: true });
  resize();
  update();
  return {
    setActive(value) { active = value; },
  };
}

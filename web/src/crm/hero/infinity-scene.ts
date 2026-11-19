// Cena 3D do hero da Visão comercial: símbolo do infinito em "carbono monobloco".
// Carregado sob demanda (import dinâmico) para não pesar o resto do app.
import * as THREE from "three";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

export type SceneFrame = {
  /** progresso já amortecido (o que a câmera está mostrando agora) */
  progress: number;
  /** posição em tela (px, relativa ao canvas) dos pontos de destaque usados pelos selos */
  anchors: { x: number; y: number; visible: boolean }[];
};

export type InfinityScene = {
  /** progresso da rolagem, de 0 a 1 */
  setProgress: (p: number) => void;
  /** -1..1, posição do mouse para um paralaxe leve */
  setPointer: (x: number, y: number) => void;
  setPaused: (paused: boolean) => void;
  resize: () => void;
  dispose: () => void;
};

type Key = { p: number; pos: [number, number, number]; target: [number, number, number]; spin: number };

// Tomadas de câmera, na mesma lógica do vídeo de referência:
// close escuro → outro ângulo → macro no cruzamento → peça inteira no claro → afastamento final.
const KEYS: Key[] = [
  { p: 0.0, pos: [4.4, 1.45, 3.3], target: [1.25, 0.0, 0], spin: -0.18 },
  { p: 0.22, pos: [-0.35, -1.05, 3.25], target: [-2.05, 0.15, 0], spin: 0.1 },
  { p: 0.45, pos: [1.05, 1.0, 1.75], target: [0.05, 0.0, 0.05], spin: 0.32 },
  { p: 0.7, pos: [0.0, 0.95, 8.4], target: [0.0, -0.18, 0], spin: 0.0 },
  { p: 1.0, pos: [0.0, 1.5, 11.5], target: [0.0, -1.05, 0], spin: 0.0 },
];

const A = 2.4; // meia largura da lemniscata
const C = 0.44; // afastamento em profundidade no cruzamento (as duas voltas não se tocam)

function lemniscate(t: number, out = new THREE.Vector3()) {
  const s = Math.sin(t);
  const c = Math.cos(t);
  const d = 1 + s * s;
  return out.set((A * c) / d, (A * s * c) / d, C * s);
}

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const easeInOut = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const smooth = (a: number, b: number, v: number) => {
  const t = clamp01((v - a) / (b - a));
  return t * t * (3 - 2 * t);
};

/** Varre um perfil de superelipse ao longo da curva, com normais analíticas (sem costura visível). */
function buildBody() {
  const U = 760;
  const V = 72;
  const n = 4.2; // expoente da superelipse: quadrado com cantos bem macios
  const positions = new Float32Array((U + 1) * (V + 1) * 3);
  const normals = new Float32Array((U + 1) * (V + 1) * 3);
  const uvs = new Float32Array((U + 1) * (V + 1) * 2);
  const indices: number[] = [];
  const P = new THREE.Vector3();
  const P2 = new THREE.Vector3();
  const T = new THREE.Vector3();
  const side = new THREE.Vector3();
  const up = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  const N = new THREE.Vector3();
  const eps = 1e-4;

  for (let i = 0; i <= U; i++) {
    const t = (i / U) * Math.PI * 2;
    lemniscate(t, P);
    lemniscate(t + eps, P2);
    T.subVectors(P2, P).normalize();
    side.crossVectors(T, Z).normalize();
    up.crossVectors(side, T).normalize();
    // mais encorpado nas pontas, mais fino no cruzamento
    const cos2 = Math.cos(t) ** 2;
    const f = 0.7 + 0.3 * cos2;
    const w = 0.25 * f; // espessura no plano
    const h = 0.34 * f; // profundidade

    for (let j = 0; j <= V; j++) {
      const th = (j / V) * Math.PI * 2;
      const ct = Math.cos(th);
      const st = Math.sin(th);
      const ex = Math.sign(ct) * Math.pow(Math.abs(ct), 2 / n);
      const ey = Math.sign(st) * Math.pow(Math.abs(st), 2 / n);
      const cx = ex * w;
      const cy = ey * h;
      const k = (i * (V + 1) + j) * 3;
      positions[k] = P.x + side.x * cx + up.x * cy;
      positions[k + 1] = P.y + side.y * cx + up.y * cy;
      positions[k + 2] = P.z + side.z * cx + up.z * cy;
      // gradiente de |x/w|^n + |y/h|^n
      const gx = (Math.sign(cx) * Math.pow(Math.abs(cx / w), n - 1)) / w;
      const gy = (Math.sign(cy) * Math.pow(Math.abs(cy / h), n - 1)) / h;
      N.set(0, 0, 0).addScaledVector(side, gx).addScaledVector(up, gy);
      if (N.lengthSq() < 1e-10) N.copy(side).multiplyScalar(Math.sign(ct) || 1);
      N.normalize();
      normals[k] = N.x;
      normals[k + 1] = N.y;
      normals[k + 2] = N.z;
      const u = (i * (V + 1) + j) * 2;
      uvs[u] = (i / U) * 150;
      uvs[u + 1] = (j / V) * 14;
    }
  }
  for (let i = 0; i < U; i++) {
    for (let j = 0; j < V; j++) {
      const a = i * (V + 1) + j;
      const b = (i + 1) * (V + 1) + j;
      indices.push(a, b, a + 1, b, b + 1, a + 1);
    }
  }
  const g = new THREE.BufferGeometry();
  g.setAttribute("position", new THREE.BufferAttribute(positions, 3));
  g.setAttribute("normal", new THREE.BufferAttribute(normals, 3));
  g.setAttribute("uv", new THREE.BufferAttribute(uvs, 2));
  g.setIndex(indices);
  return g;
}

/** Filete metálico fino que corre pelas laterais da peça. */
function buildInlay(sign: 1 | -1) {
  const pts: THREE.Vector3[] = [];
  const P = new THREE.Vector3();
  const P2 = new THREE.Vector3();
  const T = new THREE.Vector3();
  const side = new THREE.Vector3();
  const Z = new THREE.Vector3(0, 0, 1);
  for (let i = 0; i < 360; i++) {
    const t = (i / 360) * Math.PI * 2;
    lemniscate(t, P);
    lemniscate(t + 1e-4, P2);
    T.subVectors(P2, P).normalize();
    side.crossVectors(T, Z).normalize();
    const f = 0.7 + 0.3 * Math.cos(t) ** 2;
    pts.push(P.clone().addScaledVector(side, sign * (0.25 * f + 0.004)));
  }
  const curve = new THREE.CatmullRomCurve3(pts, true, "centripetal");
  return new THREE.TubeGeometry(curve, 720, 0.011, 8, true);
}

/** Trama de carbono 2x2 desenhada em canvas, usada como cor e relevo bem sutis. */
function carbonTexture() {
  const s = 128;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const cell = s / 4;
  for (let y = 0; y < 4; y++) {
    for (let x = 0; x < 4; x++) {
      const horizontal = (x + y) % 2 === 0;
      const grad = horizontal
        ? ctx.createLinearGradient(x * cell, y * cell, x * cell, (y + 1) * cell)
        : ctx.createLinearGradient(x * cell, y * cell, (x + 1) * cell, y * cell);
      grad.addColorStop(0, "#08090a");
      grad.addColorStop(0.5, "#1a1c20");
      grad.addColorStop(1, "#08090a");
      ctx.fillStyle = grad;
      ctx.fillRect(x * cell, y * cell, cell, cell);
    }
  }
  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.anisotropy = 4;
  return tex;
}

/** Sombra de contato (gradiente radial) para a tomada no fundo claro. */
function shadowTexture() {
  const s = 256;
  const cv = document.createElement("canvas");
  cv.width = cv.height = s;
  const ctx = cv.getContext("2d")!;
  const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
  g.addColorStop(0, "rgba(0,0,0,0.55)");
  g.addColorStop(0.45, "rgba(0,0,0,0.22)");
  g.addColorStop(1, "rgba(0,0,0,0)");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, s, s);
  return new THREE.CanvasTexture(cv);
}

export function createInfinityScene(canvas: HTMLCanvasElement, opts: { reducedMotion: boolean; onFrame?: (f: SceneFrame) => void }): InfinityScene {
  const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: true, powerPreference: "high-performance" });
  const mobile = window.matchMedia("(max-width: 720px)").matches;
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, mobile ? 1.5 : 1.75));
  renderer.setClearColor(0x000000, 0);
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure = 1;
  renderer.outputColorSpace = THREE.SRGBColorSpace;

  const scene = new THREE.Scene();
  const pmrem = new THREE.PMREMGenerator(renderer);
  const envRT = pmrem.fromScene(new RoomEnvironment(), 0.04);
  scene.environment = envRT.texture;

  const camera = new THREE.PerspectiveCamera(34, 1, 0.05, 80);

  // ---- peça ----
  const group = new THREE.Group();
  scene.add(group);
  const carbon = carbonTexture();
  carbon.repeat.set(1, 1);
  const bodyMat = new THREE.MeshPhysicalMaterial({
    color: 0xffffff,
    map: carbon,
    bumpMap: carbon,
    bumpScale: 0.25,
    metalness: 0.25,
    roughness: 0.42,
    clearcoat: 1,
    clearcoatRoughness: 0.1,
    envMapIntensity: 0.75,
  });
  const body = new THREE.Mesh(buildBody(), bodyMat);
  group.add(body);
  const inlayMat = new THREE.MeshStandardMaterial({ color: 0xd8dde6, metalness: 1, roughness: 0.18, envMapIntensity: 1.6 });
  const inlayA = new THREE.Mesh(buildInlay(1), inlayMat);
  const inlayB = new THREE.Mesh(buildInlay(-1), inlayMat);
  group.add(inlayA, inlayB);

  // ---- luzes: chave branca, recorte azulado, preenchimento quente ----
  const key = new THREE.DirectionalLight(0xffffff, 2.2);
  key.position.set(4, 6, 5);
  const rim = new THREE.DirectionalLight(0x7f9cff, 3.2);
  rim.position.set(-5, 2, -6);
  const rim2 = new THREE.DirectionalLight(0xbfd2ff, 1.4);
  rim2.position.set(6, -1, -4);
  const fill = new THREE.HemisphereLight(0xf4f6fb, 0x0b0c10, 0.35);
  scene.add(key, rim, rim2, fill);

  // ---- sombra de contato ----
  const shadowMat = new THREE.MeshBasicMaterial({ map: shadowTexture(), transparent: true, depthWrite: false, opacity: 0 });
  const shadow = new THREE.Mesh(new THREE.PlaneGeometry(7.4, 2.2), shadowMat);
  shadow.rotation.x = -Math.PI / 2;
  shadow.position.set(0, -1.18, 0);
  scene.add(shadow);

  // ---- poeira de luz para dar profundidade nas tomadas escuras ----
  const dustCount = mobile ? 140 : 280;
  const dustPos = new Float32Array(dustCount * 3);
  for (let i = 0; i < dustCount; i++) {
    dustPos[i * 3] = (Math.random() - 0.5) * 14;
    dustPos[i * 3 + 1] = (Math.random() - 0.5) * 7;
    dustPos[i * 3 + 2] = (Math.random() - 0.5) * 8;
  }
  const dustGeo = new THREE.BufferGeometry();
  dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
  const dustMat = new THREE.PointsMaterial({ color: 0xaab8ff, size: 0.022, transparent: true, opacity: 0.55, depthWrite: false, blending: THREE.AdditiveBlending });
  const dust = new THREE.Points(dustGeo, dustMat);
  scene.add(dust);

  // pontos de destaque (para os selos em HTML)
  const anchorPoints = [lemniscate(Math.PI * 0.16).add(new THREE.Vector3(0, 0, 0.3)), lemniscate(Math.PI * 0.88).add(new THREE.Vector3(0, 0, 0.3))];

  // ---- estado ----
  let target = 0;
  let current = 0;
  let pointerX = 0;
  let pointerY = 0;
  let px = 0;
  let py = 0;
  let paused = false;
  let raf = 0;
  let last = performance.now();
  const startedAt = last;
  const pos = new THREE.Vector3();
  const tgt = new THREE.Vector3();
  const tmp = new THREE.Vector3();

  function sample(p: number) {
    let i = 0;
    while (i < KEYS.length - 2 && p > KEYS[i + 1].p) i++;
    const a = KEYS[i];
    const b = KEYS[i + 1];
    const t = easeInOut(clamp01((p - a.p) / (b.p - a.p)));
    pos.set(a.pos[0] + (b.pos[0] - a.pos[0]) * t, a.pos[1] + (b.pos[1] - a.pos[1]) * t, a.pos[2] + (b.pos[2] - a.pos[2]) * t);
    tgt.set(a.target[0] + (b.target[0] - a.target[0]) * t, a.target[1] + (b.target[1] - a.target[1]) * t, a.target[2] + (b.target[2] - a.target[2]) * t);
    return a.spin + (b.spin - a.spin) * t;
  }

  function resize() {
    const w = canvas.clientWidth || 1;
    const h = canvas.clientHeight || 1;
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    // em telas estreitas, abre o campo de visão para a peça caber
    camera.fov = w / h < 0.8 ? 48 : w / h < 1.2 ? 40 : 34;
    camera.updateProjectionMatrix();
    renderOnce();
  }

  function frame(now: number) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const time = (now - startedAt) / 1000;
    // amortecimento: a câmera "persegue" a rolagem, dando a sensação de rolagem macia
    const k = opts.reducedMotion ? 1 : 1 - Math.exp(-dt * 5.5);
    current += (target - current) * k;
    px += (pointerX - px) * (1 - Math.exp(-dt * 3));
    py += (pointerY - py) * (1 - Math.exp(-dt * 3));

    const spin = sample(current);
    const idle = opts.reducedMotion ? 0 : 1;
    pos.x += px * 0.22;
    pos.y += -py * 0.14;
    camera.position.copy(pos);
    camera.lookAt(tgt);

    group.rotation.y = spin + Math.sin(time * 0.35) * 0.04 * idle;
    group.rotation.x = Math.sin(time * 0.27) * 0.025 * idle;
    group.position.y = Math.sin(time * 0.6) * 0.03 * idle;

    // luz e clima por tomada: escuro → claro entre 53% e 67%
    const light = smooth(0.53, 0.67, current);
    renderer.toneMappingExposure = 0.88 + light * 0.22;
    rim.intensity = 3.2 * (1 - light * 0.75);
    rim2.intensity = 1.4 * (1 - light * 0.6);
    fill.intensity = 0.35 + light * 0.9;
    dustMat.opacity = 0.55 * (1 - light);
    dust.rotation.y = time * 0.015 * idle;
    shadowMat.opacity = smooth(0.58, 0.72, current) * (1 - smooth(0.88, 1, current));

    renderer.render(scene, camera);

    if (opts.onFrame) {
      const w = canvas.clientWidth;
      const h = canvas.clientHeight;
      opts.onFrame({
        progress: current,
        anchors: anchorPoints.map((pt) => {
          tmp.copy(pt).applyMatrix4(group.matrixWorld).project(camera);
          return { x: (tmp.x * 0.5 + 0.5) * w, y: (-tmp.y * 0.5 + 0.5) * h, visible: tmp.z < 1 && Math.abs(tmp.x) < 1.1 && Math.abs(tmp.y) < 1.1 };
        }),
      });
    }

    const settled = Math.abs(target - current) < 0.0004;
    if (!paused && (!opts.reducedMotion || !settled)) raf = requestAnimationFrame(frame);
    else raf = 0;
  }

  function renderOnce() {
    if (!raf) {
      last = performance.now();
      raf = requestAnimationFrame(frame);
    }
  }

  resize();

  return {
    setProgress(p) {
      target = clamp01(p);
      if (opts.reducedMotion) current = target;
      renderOnce();
    },
    setPointer(x, y) {
      if (opts.reducedMotion) return;
      pointerX = x;
      pointerY = y;
    },
    setPaused(v) {
      paused = v;
      if (!v) renderOnce();
      else if (raf) {
        cancelAnimationFrame(raf);
        raf = 0;
      }
    },
    resize,
    dispose() {
      paused = true;
      if (raf) cancelAnimationFrame(raf);
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mat = m.material as THREE.Material | THREE.Material[] | undefined;
        if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
        else mat?.dispose();
      });
      carbon.dispose();
      shadowMat.map?.dispose();
      envRT.dispose();
      pmrem.dispose();
      renderer.dispose();
    },
  };
}

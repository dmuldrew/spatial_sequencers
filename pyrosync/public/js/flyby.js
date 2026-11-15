import * as THREE from '../vendor/three.module.min.js';

const EARTH_R = 24;
const MIN_RADIUS = EARTH_R + 1.15;
const MAX_RADIUS = EARTH_R + 34;
const DEG2RAD = Math.PI / 180;
const RAD2DEG = 180 / Math.PI;
const UP_Y = new THREE.Vector3(0, 1, 0);
const FWD_Z = new THREE.Vector3(0, 0, -1);
const RIGHT_X = new THREE.Vector3(1, 0, 0);

// Scene units per km: EARTH_R scene units span the Earth's 6,371 km radius (the HUD uses 265 km/unit).
const KM_PER_UNIT = 265;
const FIRE_HISTORY_DIR = './data/global-fire/';
// Low-to-high fire density ramp for the multi-year H3 fire history carpet.
const FIRE_HISTORY_STOPS = ['#4c0519', '#b91c1c', '#f97316', '#facc15', '#fef9c3'];

const CAM_MODES = ['chase', 'cockpit', 'orbit'];
const CAM_LABELS = {
  chase: '🎥 Cam: Chase',
  cockpit: '🎥 Cam: Cockpit',
  orbit: '🎥 Cam: Orbit'
};

let h3LoadPromise = null;
function loadH3Once() {
  if (window.h3) return Promise.resolve(window.h3);
  if (h3LoadPromise) return h3LoadPromise;
  h3LoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './midwest/vendor/h3.js';
    script.async = true;
    script.onload = () => (window.h3 ? resolve(window.h3) : reject(new Error('h3 failed to expose global')));
    script.onerror = () => reject(new Error('Failed to load ./midwest/vendor/h3.js'));
    document.head.appendChild(script);
  });
  return h3LoadPromise;
}

// Apache Arrow JS (UMD, global `Arrow`), loaded only when the fire history uses Arrow files.
let arrowLoadPromise = null;
function loadArrowOnce() {
  if (window.Arrow?.tableFromIPC) return Promise.resolve(window.Arrow);
  if (arrowLoadPromise) return arrowLoadPromise;
  arrowLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = './vendor/arrow.min.js';
    script.async = true;
    script.onload = () => (window.Arrow?.tableFromIPC ? resolve(window.Arrow) : reject(new Error('Arrow failed to expose global')));
    script.onerror = () => reject(new Error('Failed to load ./vendor/arrow.min.js'));
    document.head.appendChild(script);
  });
  return arrowLoadPromise;
}

function clamp(v, lo, hi) {
  return Math.max(lo, Math.min(hi, v));
}

function latLonAltToVec3(lat, lon, radius = EARTH_R, out = new THREE.Vector3()) {
  const latRad = lat * DEG2RAD;
  const lonRad = lon * DEG2RAD;
  const cosLat = Math.cos(latRad);
  out.set(
    radius * Math.cos(lonRad) * cosLat,
    radius * Math.sin(latRad),
    -radius * Math.sin(lonRad) * cosLat
  );
  return out;
}

function vec3ToLatLonAlt(vec) {
  const r = vec.length() || 1;
  const lat = Math.asin(clamp(vec.y / r, -1, 1)) * RAD2DEG;
  const lon = Math.atan2(-vec.z, vec.x) * RAD2DEG;
  return { lat, lon, altUnits: r - EARTH_R, radius: r };
}

function percentileRange(values) {
  const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
  if (!sorted.length) return { min: 0, max: 1 };
  const q = (f) => {
    const pos = (sorted.length - 1) * f;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  };
  const clip = sorted.length >= 20 ? 0.05 : 0;
  const min = q(clip);
  const max = q(1 - clip);
  return min < max ? { min, max } : { min: sorted[0], max: sorted[sorted.length - 1] + 1e-4 };
}

function anomalyColor(z, out = new THREE.Color()) {
  if (z >= 2.2) return out.set('#f43f5e');
  if (z >= 1.5) return out.set('#f97316');
  if (z >= 0.8) return out.set('#facc15');
  if (z >= 0.0) return out.set('#34d399');
  return out.set('#38bdf8');
}

export function createFlybyController(bridge) {
  const dom = {
    viewport: document.getElementById('flyby-viewport'),
    canvas: document.getElementById('flyby-canvas'),
    statusBanner: document.getElementById('flyby-status-banner'),
    hudMode: document.getElementById('flyby-hud-mode'),
    hudAlt: document.getElementById('flyby-hud-alt'),
    hudSpd: document.getElementById('flyby-hud-spd'),
    hudLatLon: document.getElementById('flyby-hud-latlon'),
    hudTarget: document.getElementById('flyby-hud-target'),
    hudYm: document.getElementById('flyby-hud-ym'),
    hudSigma: document.getElementById('flyby-hud-sigma'),
    hudHex: document.getElementById('flyby-hud-hex'),
    hudAudio: document.getElementById('flyby-hud-audio'),
    btnAutopilot: document.getElementById('flyby-btn-autopilot'),
    btnCam: document.getElementById('flyby-btn-cam'),
    btnHorizon: document.getElementById('flyby-btn-horizon'),
    btnReset: document.getElementById('flyby-btn-reset'),
    waypoints: document.getElementById('flyby-waypoints'),
    btnPlay: document.getElementById('flyby-btn-play'),
    timeSlider: document.getElementById('flyby-time-slider'),
    timeReadout: document.getElementById('flyby-time-readout'),
    layerHex: document.getElementById('flyby-layer-hex'),
    layerSpirals: document.getElementById('flyby-layer-spirals'),
    layerFires: document.getElementById('flyby-layer-fires'),
    layerHistory: document.getElementById('flyby-layer-history'),
    metricSelect: document.getElementById('flyby-metric-select')
  };

  const sim = {
    initialized: false,
    initializing: false,
    active: false,
    rafId: null,
    lastTime: 0,
    elapsed: 0,
    camMode: 'chase',
    autopilot: true,
    horizonLock: true,
    targetId: 'cruise',
    timelinePlaying: false,
    timelineAccum: 0,
    monthIndex: 0,
    metric: 'sigma',
    keys: new Set(),
    padCtrls: new Set(),
    pointerDrag: false,
    dragYaw: 0,
    dragPitch: 0,
    orbitYaw: 0.45,
    orbitPitch: 0.42,
    orbitDist: 10.5,
    // Spacecraft rigid-body state
    craftPos: latLonAltToVec3(26, -124, EARTH_R + 7.2),
    craftQuat: new THREE.Quaternion(),
    craftSpeed: 3.4,
    angVel: new THREE.Vector3(), // pitch (x), yaw (y), roll (z)
    camPos: new THREE.Vector3(),
    camLook: new THREE.Vector3(),
    // Audio timing
    lastDroneMs: 0,
    lastPingMs: 0,
    lastHudMs: 0
  };

  // Spatial audio nodes owned by the flyby view
  const audioBus = {
    ready: false,
    panner: null,
    filter: null,
    drone: null,
    violin: null,
    scanner: null,
    ember: null,
    lastSpokenBiomeId: null
  };

  // Scene references
  let renderer = null;
  let scene = null;
  let camera = null;
  let resizeObserver = null;
  let hexGroup = null;
  let spiralGroup = null;
  let fireGroup = null;
  let historyGroup = null;
  // Multi-resolution FIRMS fire history, one level per H3 resolution:
  // [{ res, mesh, cells: Map(id -> [detections, density, frpMax]), altMinKm, altMaxKm }]
  let historyLevels = [];
  let historyMeta = null;
  let activeHistoryLevel = null;
  let craftGroup = null;
  let plumeLeft = null;
  let plumeRight = null;
  let exhaustLight = null;
  let starField = null;

  // Spatial lookup structures for hexes & spirals
  let biomeTowers = []; // [{ biome, basePos, up, east, north, line, lineGeo, colors, ringMesh, eonetMesh, maxSteps }]
  let fireHexBins = []; // [{ id, lat, lon, pos, totalFrp, count }]
  let iowaCellMap = new Map(); // res-7 id -> { id, A1, A2 }
  let iowaRanges = { A1: { min: 20, max: 40 }, A2: { min: 0.2, max: 0.9 } };
  let totalMonths = 309;

  // Scratch vectors to avoid per-frame GC churn
  const tmpV1 = new THREE.Vector3();
  const tmpV2 = new THREE.Vector3();
  const tmpV3 = new THREE.Vector3();
  const tmpUp = new THREE.Vector3();
  const tmpFwd = new THREE.Vector3();
  const tmpRight = new THREE.Vector3();
  const tmpM4 = new THREE.Matrix4();
  const tmpQ = new THREE.Quaternion();
  const tmpQ2 = new THREE.Quaternion();

  function setBanner(text, hide = false) {
    if (!dom.statusBanner) return;
    dom.statusBanner.textContent = text;
    dom.statusBanner.classList.toggle('is-hidden', hide);
  }

  function createEarthTexture(worldGeo, biomes) {
    const canvas = document.createElement('canvas');
    canvas.width = 2048;
    canvas.height = 1024;
    const ctx = canvas.getContext('2d');

    // Deep space-ocean gradient
    const bg = ctx.createLinearGradient(0, 0, 0, canvas.height);
    bg.addColorStop(0, '#040b18');
    bg.addColorStop(0.5, '#071426');
    bg.addColorStop(1, '#040b18');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    const proj = d3.geoEquirectangular()
      .translate([canvas.width / 2, canvas.height / 2])
      .scale(canvas.width / (2 * Math.PI));
    const path = d3.geoPath(proj, ctx);

    // Subtle lat/lon orbital grid
    ctx.beginPath();
    path(d3.geoGraticule().step([15, 15])());
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.14)';
    ctx.lineWidth = 1;
    ctx.stroke();

    // Land masses
    if (worldGeo) {
      ctx.beginPath();
      path(worldGeo);
      ctx.fillStyle = '#0f2238';
      ctx.fill();
      ctx.strokeStyle = 'rgba(56, 189, 248, 0.58)';
      ctx.lineWidth = 1.4;
      ctx.stroke();
    }

    // Soft thermal beacon washes beneath the 6 fire biomes + Iowa study area
    const paintWash = (lon, lat, colorHex, radiusPx) => {
      const p = proj([lon, lat]);
      if (!p) return;
      const grad = ctx.createRadialGradient(p[0], p[1], 2, p[0], p[1], radiusPx);
      grad.addColorStop(0, colorHex);
      grad.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = grad;
      ctx.beginPath();
      ctx.arc(p[0], p[1], radiusPx, 0, Math.PI * 2);
      ctx.fill();
    };

    (biomes || []).forEach((b) => paintWash(b.lon, b.lat, 'rgba(249, 115, 22, 0.25)', 58));
    paintWash(-93.5, 42.0, 'rgba(52, 211, 153, 0.32)', 30);

    const tex = new THREE.CanvasTexture(canvas);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.anisotropy = 4;
    return tex;
  }

  function createAtmosphereMesh() {
    const geo = new THREE.SphereGeometry(EARTH_R * 1.055, 64, 48);
    const mat = new THREE.ShaderMaterial({
      uniforms: {
        glowColor: { value: new THREE.Color('#38bdf8') },
        emberColor: { value: new THREE.Color('#f97316') }
      },
      vertexShader: `
        varying vec3 vNormal;
        varying vec3 vViewPos;
        void main() {
          vNormal = normalize(normalMatrix * normal);
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          vViewPos = -mv.xyz;
          gl_Position = projectionMatrix * mv;
        }
      `,
      fragmentShader: `
        uniform vec3 glowColor;
        uniform vec3 emberColor;
        varying vec3 vNormal;
        varying vec3 vViewPos;
        void main() {
          float rim = pow(clamp(1.0 - abs(dot(vNormal, normalize(vViewPos))), 0.0, 1.0), 3.1);
          vec3 col = mix(glowColor, emberColor, rim * 0.25);
          gl_FragColor = vec4(col, rim * 0.58);
        }
      `,
      side: THREE.BackSide,
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false
    });
    return new THREE.Mesh(geo, mat);
  }

  function buildStarfield() {
    const count = 2000;
    const positions = new Float32Array(count * 3);
    const colors = new Float32Array(count * 3);
    const c = new THREE.Color();
    for (let i = 0; i < count; i += 1) {
      const r = 135 + Math.random() * 110;
      const u = Math.random() * 2 - 1;
      const phi = Math.random() * Math.PI * 2;
      const s = Math.sqrt(1 - u * u);
      positions[i * 3] = r * s * Math.cos(phi);
      positions[i * 3 + 1] = r * u;
      positions[i * 3 + 2] = r * s * Math.sin(phi);
      const tint = Math.random();
      if (tint > 0.85) c.set('#fdba74');
      else if (tint > 0.55) c.set('#bae6fd');
      else c.set('#e2e8f0');
      const lum = 0.55 + Math.random() * 0.45;
      colors[i * 3] = c.r * lum;
      colors[i * 3 + 1] = c.g * lum;
      colors[i * 3 + 2] = c.b * lum;
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.PointsMaterial({
      size: 0.55,
      vertexColors: true,
      transparent: true,
      opacity: 0.85,
      sizeAttenuation: true
    });
    starField = new THREE.Points(geo, mat);
    scene.add(starField);
  }

  function buildSpacecraft() {
    craftGroup = new THREE.Group();

    const hullMat = new THREE.MeshStandardMaterial({
      color: '#1e293b',
      metalness: 0.72,
      roughness: 0.28
    });
    const trimMat = new THREE.MeshStandardMaterial({
      color: '#38bdf8',
      emissive: '#0284c7',
      emissiveIntensity: 0.9,
      metalness: 0.3,
      roughness: 0.2
    });
    const goldMat = new THREE.MeshStandardMaterial({
      color: '#f59e0b',
      metalness: 0.85,
      roughness: 0.22
    });

    // Sleek delta nose along -Z
    const bodyGeo = new THREE.ConeGeometry(0.18, 0.95, 6);
    bodyGeo.rotateX(-Math.PI / 2);
    bodyGeo.scale(1.15, 0.58, 1.0);
    const body = new THREE.Mesh(bodyGeo, hullMat);
    craftGroup.add(body);

    // Cockpit canopy
    const canopyGeo = new THREE.SphereGeometry(0.11, 14, 10);
    canopyGeo.scale(0.85, 0.55, 1.65);
    const canopy = new THREE.Mesh(canopyGeo, trimMat);
    canopy.position.set(0, 0.08, -0.06);
    craftGroup.add(canopy);

    // Twin swept wings
    const wingGeo = new THREE.BoxGeometry(1.08, 0.025, 0.34);
    const wing = new THREE.Mesh(wingGeo, hullMat);
    wing.position.set(0, 0, 0.16);
    craftGroup.add(wing);

    const tipGeo = new THREE.BoxGeometry(1.12, 0.032, 0.05);
    const tipStrip = new THREE.Mesh(tipGeo, trimMat);
    tipStrip.position.set(0, 0, 0.31);
    craftGroup.add(tipStrip);

    // Ventral MODIS H3 Dish Scanner
    const dishGeo = new THREE.CylinderGeometry(0.11, 0.05, 0.06, 8);
    const dish = new THREE.Mesh(dishGeo, goldMat);
    dish.position.set(0, -0.09, -0.05);
    craftGroup.add(dish);

    // Dorsal vertical tail fin
    const finGeo = new THREE.BoxGeometry(0.03, 0.22, 0.24);
    const fin = new THREE.Mesh(finGeo, hullMat);
    fin.position.set(0, 0.14, 0.26);
    craftGroup.add(fin);

    // Dual ion thruster plumes facing aft (+Z)
    const plumeGeo = new THREE.ConeGeometry(0.065, 0.42, 10);
    plumeGeo.rotateX(Math.PI / 2);
    const plumeMat = new THREE.MeshBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending
    });
    plumeLeft = new THREE.Mesh(plumeGeo, plumeMat);
    plumeLeft.position.set(-0.14, 0, 0.56);
    plumeRight = new THREE.Mesh(plumeGeo, plumeMat.clone());
    plumeRight.position.set(0.14, 0, 0.56);
    craftGroup.add(plumeLeft, plumeRight);

    exhaustLight = new THREE.PointLight('#38bdf8', 1.4, 5.5);
    exhaustLight.position.set(0, 0, 0.6);
    craftGroup.add(exhaustLight);

    // Initialize nose pointing East/Northeast horizontally tangent to Earth
    resetCraftToOrbit(26, -124, 7.2);
    scene.add(craftGroup);
  }

  function resetCraftToOrbit(lat, lon, alt = 7.2) {
    latLonAltToVec3(lat, lon, EARTH_R + alt, sim.craftPos);
    tmpUp.copy(sim.craftPos).normalize();
    tmpFwd.crossVectors(UP_Y, tmpUp);
    if (tmpFwd.lengthSq() < 1e-5) tmpFwd.set(1, 0, 0);
    tmpFwd.normalize();
    tmpRight.crossVectors(tmpFwd, tmpUp).normalize();
    // Local matrix where -Z is forward, +Y is up, +X is right
    tmpM4.makeBasis(tmpRight, tmpUp, tmpFwd.clone().negate());
    sim.craftQuat.setFromRotationMatrix(tmpM4);
    sim.craftSpeed = 3.4;
    sim.angVel.set(0, 0, 0);

    if (craftGroup) {
      craftGroup.position.copy(sim.craftPos);
      craftGroup.quaternion.copy(sim.craftQuat);
    }
    // Snap camera immediately behind craft
    const back = FWD_Z.clone().negate().applyQuaternion(sim.craftQuat);
    const up = UP_Y.clone().applyQuaternion(sim.craftQuat);
    sim.camPos.copy(sim.craftPos).addScaledVector(back, 3.6).addScaledVector(up, 1.15);
    sim.camLook.copy(sim.craftPos).addScaledVector(FWD_Z.clone().applyQuaternion(sim.craftQuat), 8);
  }

  function buildGeodesicHexLayer(h3, biomes, iowaData) {
    hexGroup = new THREE.Group();

    // 1) Res-2 Geodesic survey grid around each biome + Iowa
    const surveyIds = new Set();
    for (const b of biomes) {
      const center = h3.latLngToCell(b.lat, b.lon, 2);
      for (const id of h3.gridDisk(center, 3)) surveyIds.add(id);
    }
    for (const id of h3.gridDisk(h3.latLngToCell(42.0, -93.5, 2), 2)) {
      surveyIds.add(id);
    }

    const segVerts = [];
    const pA = new THREE.Vector3();
    const pB = new THREE.Vector3();
    for (const id of surveyIds) {
      const boundary = h3.cellToBoundary(id);
      for (let i = 0; i < boundary.length; i += 1) {
        const [lat1, lon1] = boundary[i];
        const [lat2, lon2] = boundary[(i + 1) % boundary.length];
        latLonAltToVec3(lat1, lon1, EARTH_R + 0.032, pA);
        latLonAltToVec3(lat2, lon2, EARTH_R + 0.032, pB);
        segVerts.push(pA.x, pA.y, pA.z, pB.x, pB.y, pB.z);
      }
    }
    const gridGeo = new THREE.BufferGeometry();
    gridGeo.setAttribute('position', new THREE.Float32BufferAttribute(segVerts, 3));
    const gridMat = new THREE.LineBasicMaterial({
      color: '#38bdf8',
      transparent: true,
      opacity: 0.28
    });
    hexGroup.add(new THREE.LineSegments(gridGeo, gridMat));

    // 2) Central Iowa MODIS Res-7 high-detail hex patch (green->brown LST & NDVI)
    if (iowaData && Array.isArray(iowaData.cells) && iowaData.cells.length) {
      iowaCellMap = new Map(iowaData.cells.map((c) => [c.id, c]));
      iowaRanges = {
        A1: percentileRange(iowaData.cells.map((c) => c.A1)),
        A2: percentileRange(iowaData.cells.map((c) => c.A2))
      };

      // Measure approximate H3 res-7 hex radius in Three.js units
      const sampleId = iowaData.cells[0].id;
      const [sLat, sLon] = h3.cellToLatLng(sampleId);
      const bnd = h3.cellToBoundary(sampleId);
      const cVec = latLonAltToVec3(sLat, sLon, EARTH_R);
      const vVec = latLonAltToVec3(bnd[0][0], bnd[0][1], EARTH_R);
      const hexRadius = Math.max(0.0042, cVec.distanceTo(vVec) * 0.94);

      const prismGeo = new THREE.CylinderGeometry(1, 1, 1, 6);
      const prismMat = new THREE.MeshBasicMaterial({ color: '#ffffff' });
      const iowaMesh = new THREE.InstancedMesh(prismGeo, prismMat, iowaData.cells.length);
      iowaMesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);

      const col = new THREE.Color();
      const dummyPos = new THREE.Vector3();
      const dummyScale = new THREE.Vector3();
      const dummyQuat = new THREE.Quaternion();
      const rangeA1 = iowaRanges.A1;
      const rangeA2 = iowaRanges.A2;

      iowaData.cells.forEach((cell, idx) => {
        const [lat, lon] = h3.cellToLatLng(cell.id);
        latLonAltToVec3(lat, lon, EARTH_R + 0.02, dummyPos);
        tmpUp.copy(dummyPos).normalize();
        dummyQuat.setFromUnitVectors(UP_Y, tmpUp);

        let hNorm = 0.08;
        if (Number.isFinite(cell.A1) && Number.isFinite(cell.A2)) {
          const tNorm = clamp((cell.A1 - rangeA1.min) / (rangeA1.max - rangeA1.min || 1), 0, 1);
          const vNorm = clamp((cell.A2 - rangeA2.min) / (rangeA2.max - rangeA2.min || 1), 0, 1);
          const hue = (120 + tNorm * (30 - 120)) / 360;
          const sat = 0.05 + vNorm * 0.90;
          col.setHSL(hue, sat, 0.42);
          hNorm = 0.03 + tNorm * 0.16;
        } else {
          col.set('#64748b');
        }
        dummyPos.addScaledVector(tmpUp, hNorm * 0.5);
        dummyScale.set(hexRadius, hNorm, hexRadius);
        tmpM4.compose(dummyPos, dummyQuat, dummyScale);
        iowaMesh.setMatrixAt(idx, tmpM4);
        iowaMesh.setColorAt(idx, col);
      });
      iowaMesh.instanceMatrix.needsUpdate = true;
      if (iowaMesh.instanceColor) iowaMesh.instanceColor.needsUpdate = true;
      hexGroup.add(iowaMesh);

      // Beacon ring marking Iowa MODIS Hex Patch from high orbit
      const ringGeo = new THREE.RingGeometry(0.46, 0.54, 6);
      const ringMat = new THREE.MeshBasicMaterial({
        color: '#34d399',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.78
      });
      const ring = new THREE.Mesh(ringGeo, ringMat);
      latLonAltToVec3(42.0, -93.5, EARTH_R + 0.18, ring.position);
      ring.lookAt(ring.position.clone().multiplyScalar(2));
      hexGroup.add(ring);
    }

    scene.add(hexGroup);
  }

  function buildModisFireHexColumns(h3, hotspots) {
    fireGroup = new THREE.Group();
    const byCell = new Map();
    for (const sp of hotspots || []) {
      const id = h3.latLngToCell(sp.lat, sp.lon, 3);
      let entry = byCell.get(id);
      if (!entry) {
        const [lat, lon] = h3.cellToLatLng(id);
        entry = { id, lat, lon, totalFrp: 0, count: 0, maxBrightness: 0 };
        byCell.set(id, entry);
      }
      entry.totalFrp += sp.frp || 10;
      entry.count += 1;
      entry.maxBrightness = Math.max(entry.maxBrightness, sp.brightness || 310);
    }
    fireHexBins = Array.from(byCell.values());
    if (!fireHexBins.length) {
      scene.add(fireGroup);
      return;
    }

    // Measure Res-3 hex radius at mid-latitudes
    const sample = fireHexBins[0];
    const bnd = h3.cellToBoundary(sample.id);
    const cVec = latLonAltToVec3(sample.lat, sample.lon, EARTH_R);
    const vVec = latLonAltToVec3(bnd[0][0], bnd[0][1], EARTH_R);
    const hexRad = clamp(cVec.distanceTo(vVec) * 0.88, 0.12, 0.28);

    const colGeo = new THREE.CylinderGeometry(0.92, 1.0, 1, 6);
    const colMat = new THREE.MeshStandardMaterial({
      color: '#ffffff',
      emissive: '#f97316',
      emissiveIntensity: 0.55,
      roughness: 0.35,
      metalness: 0.1
    });
    const inst = new THREE.InstancedMesh(colGeo, colMat, fireHexBins.length);
    const col = new THREE.Color();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quat = new THREE.Quaternion();

    fireHexBins.forEach((bin, idx) => {
      bin.pos = latLonAltToVec3(bin.lat, bin.lon, EARTH_R, new THREE.Vector3());
      const height = clamp(0.18 + Math.log1p(bin.totalFrp) * 0.38, 0.22, 2.35);
      tmpUp.copy(bin.pos).normalize();
      quat.setFromUnitVectors(UP_Y, tmpUp);
      pos.copy(bin.pos).addScaledVector(tmpUp, height * 0.5 + 0.02);
      scale.set(hexRad, height, hexRad);
      tmpM4.compose(pos, quat, scale);
      inst.setMatrixAt(idx, tmpM4);

      const heatNorm = clamp(Math.log1p(bin.totalFrp) / 7.2, 0, 1);
      if (heatNorm > 0.72) col.set('#f43f5e');
      else if (heatNorm > 0.42) col.set('#f97316');
      else col.set('#facc15');
      inst.setColorAt(idx, col);
    });
    inst.instanceMatrix.needsUpdate = true;
    if (inst.instanceColor) inst.instanceColor.needsUpdate = true;
    fireGroup.add(inst);
    scene.add(fireGroup);
  }

  function fireHistoryColor(t, out) {
    const scaled = clamp(t, 0, 1) * (FIRE_HISTORY_STOPS.length - 1);
    const i = Math.min(FIRE_HISTORY_STOPS.length - 2, Math.floor(scaled));
    out.set(FIRE_HISTORY_STOPS[i]).lerp(new THREE.Color(FIRE_HISTORY_STOPS[i + 1]), scaled - i);
    return out;
  }

  // Columnar fire history for one level: { ids, lat, lng, detections, density, frpMax }.
  // Arrow files carry typed columns and cell centres; JSON rows get centres from h3-js.
  async function fetchFireHistoryColumns(h3, level) {
    const url = `${FIRE_HISTORY_DIR}${level.file}`;
    if (level.format === 'arrow' || level.file.endsWith('.arrow')) {
      const [Arrow, buffer] = await Promise.all([
        loadArrowOnce(),
        fetch(url).then((r) => (r.ok ? r.arrayBuffer() : null))
      ]);
      if (!buffer) return null;
      const table = Arrow.tableFromIPC(new Uint8Array(buffer));
      const col = (name) => table.getChild(name)?.toArray();
      const h3Index = col('h3_index');
      if (!h3Index) return null;
      const ids = Array.from(h3Index, (v) => v.toString(16));
      return {
        ids,
        lat: col('lat'),
        lng: col('lng'),
        detections: col('detections'),
        density: col('density'),
        frpMax: col('frp_max')
      };
    }
    const payload = await fetch(url).then((r) => (r.ok ? r.json() : null));
    const rows = Array.isArray(payload?.cells) ? payload.cells : [];
    const n = rows.length;
    const out = {
      ids: rows.map((r) => r[0]),
      lat: new Float32Array(n),
      lng: new Float32Array(n),
      detections: Float64Array.from(rows, (r) => r[1]),
      density: Float64Array.from(rows, (r) => r[2]),
      frpMax: Float64Array.from(rows, (r) => (r[3] == null ? NaN : r[3]))
    };
    out.ids.forEach((id, i) => {
      [out.lat[i], out.lng[i]] = h3.cellToLatLng(id);
    });
    return out;
  }

  function buildFireHistoryLevel(h3, level, data, colorRange) {
    const n = data?.ids?.length || 0;
    if (!n) return null;
    // A hexagon's circumradius equals its edge length.
    const radius = (h3.getHexagonEdgeLengthAvg(level.resolution, 'km') / KM_PER_UNIT) * 0.94;
    const lo = Number.isFinite(colorRange?.min) ? colorRange.min : -4;
    const hi = Number.isFinite(colorRange?.max) ? colorRange.max : -1;

    const geo = new THREE.CylinderGeometry(1, 1, 1, 6);
    const mat = new THREE.MeshLambertMaterial({ color: '#ffffff' });
    const mesh = new THREE.InstancedMesh(geo, mat, n);
    mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
    mesh.visible = false;

    const cells = new Map();
    const col = new THREE.Color();
    const pos = new THREE.Vector3();
    const scale = new THREE.Vector3();
    const quat = new THREE.Quaternion();
    for (let idx = 0; idx < n; idx += 1) {
      const density = data.density[idx];
      cells.set(data.ids[idx], [data.detections[idx], density, data.frpMax[idx]]);
      const t = density > 0 ? (Math.log10(density) - lo) / (hi - lo || 1) : 0;
      // Same absolute heights at every level, so swapping levels does not jump.
      const height = 0.012 + clamp(t, 0, 1) * 0.11;
      latLonAltToVec3(data.lat[idx], data.lng[idx], EARTH_R, pos);
      tmpUp.copy(pos).normalize();
      quat.setFromUnitVectors(UP_Y, tmpUp);
      pos.addScaledVector(tmpUp, height * 0.5 + 0.006);
      scale.set(radius, height, radius);
      tmpM4.compose(pos, quat, scale);
      mesh.setMatrixAt(idx, tmpM4);
      mesh.setColorAt(idx, fireHistoryColor(t, col));
    }
    mesh.instanceMatrix.needsUpdate = true;
    if (mesh.instanceColor) mesh.instanceColor.needsUpdate = true;
    return {
      res: level.resolution,
      mesh,
      cells,
      altMinKm: Number.isFinite(level.altitudeKm?.min) ? level.altitudeKm.min : 0,
      altMaxKm: Number.isFinite(level.altitudeKm?.max) ? level.altitudeKm.max : Infinity
    };
  }

  // Loads after the scene is up; the layer is optional, so a missing manifest is not an error.
  async function loadFireHistory(h3) {
    const manifest = await fetch(`${FIRE_HISTORY_DIR}manifest.json`)
      .then((r) => (r.ok ? r.json() : null))
      .catch(() => null);
    if (!manifest || !Array.isArray(manifest.levels) || !manifest.levels.length) return;
    historyMeta = manifest;
    historyGroup = new THREE.Group();
    historyGroup.visible = dom.layerHistory?.getAttribute('aria-pressed') !== 'false';
    scene.add(historyGroup);
    // Coarsest first, so the high-orbit view appears soonest.
    const levels = [...manifest.levels].sort((a, b) => a.resolution - b.resolution);
    for (const level of levels) {
      const data = await fetchFireHistoryColumns(h3, level).catch((err) => {
        console.warn(`Fire history level r${level.resolution} unavailable:`, err);
        return null;
      });
      const built = buildFireHistoryLevel(h3, level, data, manifest.colorRange);
      if (!built) continue;
      historyGroup.add(built.mesh);
      historyLevels.push(built);
    }
  }

  // Show the finest level whose altitude band contains the craft.
  function updateFireHistoryLod(altKm) {
    if (!historyLevels.length) return;
    let pick = null;
    for (const level of historyLevels) {
      if (altKm >= level.altMinKm && altKm < level.altMaxKm && (!pick || level.res > pick.res)) {
        pick = level;
      }
    }
    if (!pick) {
      // Outside every band: nearest by altitude.
      pick = historyLevels.reduce((best, level) => {
        const gap = altKm < level.altMinKm ? level.altMinKm - altKm : altKm - level.altMaxKm;
        const bestGap = altKm < best.altMinKm ? best.altMinKm - altKm : altKm - best.altMaxKm;
        return gap < bestGap ? level : best;
      });
    }
    if (pick === activeHistoryLevel) return;
    for (const level of historyLevels) level.mesh.visible = level === pick;
    activeHistoryLevel = pick;
  }

  function fireHistoryYears() {
    const label = historyMeta?.periodLabel || '';
    const years = label.match(/\d{4}/g);
    return years && years.length >= 2 ? `${years[0]}–${years[years.length - 1]}` : 'History';
  }

  function computeRadialNorm(biome, rec, metric) {
    if (metric === 'ffwi') {
      const peak = Math.max(45, d3.max(biome.records, (r) => r.ffwi) || 50);
      return clamp((rec.ffwi || 0) / peak, 0.04, 1);
    }
    if (metric === 'vpd') {
      const peak = Math.max(3.5, d3.max(biome.records, (r) => r.vpdKpa) || 3.5);
      return clamp((rec.vpdKpa || 0) / peak, 0.04, 1);
    }
    if (metric === 'eonet') {
      const maxFires = Math.max(1, d3.max(biome.records, (r) => r.eonetFires || 0) || 1);
      return rec.eonetFires > 0 ? clamp(Math.sqrt(rec.eonetFires) / Math.sqrt(maxFires), 0.08, 1) : 0.04;
    }
    // sigma
    return clamp(((rec.zScore || 0) + 1.5) / 5.0, 0.04, 1);
  }

  function buildPyroSpirals(biomes) {
    if (spiralGroup) {
      scene.remove(spiralGroup);
    }
    spiralGroup = new THREE.Group();
    biomeTowers = [];
    const maxLen = Math.max(...biomes.map((b) => b.records.length), 1);
    totalMonths = maxLen;
    if (dom.timeSlider) dom.timeSlider.max = String(maxLen - 1);

    const eonetGeo = new THREE.OctahedronGeometry(0.11, 0);
    const eonetMat = new THREE.MeshBasicMaterial({ color: '#facc15' });
    const beaconGeo = new THREE.TorusGeometry(0.28, 0.045, 8, 24);

    for (const biome of biomes) {
      const basePos = latLonAltToVec3(biome.lat, biome.lon, EARTH_R);
      const up = basePos.clone().normalize();
      const east = new THREE.Vector3().crossVectors(UP_Y, up);
      if (east.lengthSq() < 1e-5) east.set(1, 0, 0);
      east.normalize();
      const north = new THREE.Vector3().crossVectors(up, east).normalize();

      // Local orbital axis spine + 0σ emerald reference hoops at base & apex
      const spineGeo = new THREE.BufferGeometry().setFromPoints([
        basePos.clone().addScaledVector(up, 0.15),
        basePos.clone().addScaledVector(up, 8.9)
      ]);
      const spine = new THREE.Line(
        spineGeo,
        new THREE.LineBasicMaterial({ color: biome.color || '#38bdf8', transparent: true, opacity: 0.45 })
      );
      spiralGroup.add(spine);

      for (const hOff of [0.6, 8.6]) {
        const hoopPts = [];
        const hoopR = 0.85;
        for (let k = 0; k <= 36; k += 1) {
          const a = (k / 36) * Math.PI * 2;
          hoopPts.push(
            basePos.clone()
              .addScaledVector(up, hOff)
              .addScaledVector(east, Math.cos(a) * hoopR)
              .addScaledVector(north, Math.sin(a) * hoopR)
          );
        }
        const hoop = new THREE.LineLoop(
          new THREE.BufferGeometry().setFromPoints(hoopPts),
          new THREE.LineBasicMaterial({ color: '#34d399', transparent: true, opacity: hOff < 1 ? 0.5 : 0.35 })
        );
        spiralGroup.add(hoop);
      }

      // Helical Pyro Spiral vertices across all 309 months
      const n = biome.records.length;
      const positions = new Float32Array(n * 3);
      const colors = new Float32Array(n * 3);
      const nodePositions = [];
      const flareIndices = [];
      const col = new THREE.Color();

      for (let i = 0; i < n; i += 1) {
        const rec = biome.records[i];
        const theta = ((rec.month - 1) / 12) * Math.PI * 2;
        const h = 0.48 + (i / Math.max(1, n - 1)) * 8.15;
        const rNorm = computeRadialNorm(biome, rec, sim.metric);
        const rho = 0.42 + rNorm * 2.15;

        const pt = basePos.clone()
          .addScaledVector(up, h)
          .addScaledVector(east, Math.cos(theta) * rho)
          .addScaledVector(north, Math.sin(theta) * rho);

        nodePositions.push(pt);
        positions[i * 3] = pt.x;
        positions[i * 3 + 1] = pt.y;
        positions[i * 3 + 2] = pt.z;

        anomalyColor(rec.zScore || 0, col);
        colors[i * 3] = col.r;
        colors[i * 3 + 1] = col.g;
        colors[i * 3 + 2] = col.b;

        if ((rec.eonetFires || 0) > 0) flareIndices.push(i);
      }

      const lineGeo = new THREE.BufferGeometry();
      lineGeo.setAttribute('position', new THREE.BufferAttribute(positions, 3));
      lineGeo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
      lineGeo.setDrawRange(0, Math.max(2, sim.monthIndex + 1));

      const line = new THREE.Line(
        lineGeo,
        new THREE.LineBasicMaterial({ vertexColors: true, transparent: true, opacity: 0.96 })
      );
      spiralGroup.add(line);

      // EONET outbreak flares along spiral arms
      let eonetMesh = null;
      if (flareIndices.length) {
        eonetMesh = new THREE.InstancedMesh(eonetGeo, eonetMat, flareIndices.length);
        eonetMesh.userData.flareIndices = flareIndices;
        const dummy = new THREE.Matrix4();
        const s = new THREE.Vector3();
        const q = new THREE.Quaternion();
        flareIndices.forEach((recIdx, j) => {
          const fires = biome.records[recIdx].eonetFires || 1;
          const sc = clamp(0.7 + Math.log1p(fires) * 0.45, 0.7, 2.0);
          s.set(sc, sc, sc);
          dummy.compose(nodePositions[recIdx], q, s);
          eonetMesh.setMatrixAt(j, dummy);
        });
        eonetMesh.instanceMatrix.needsUpdate = true;
        spiralGroup.add(eonetMesh);
      }

      // Active Month Playhead Beacon Ring
      const beaconMat = new THREE.MeshBasicMaterial({
        color: '#facc15',
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.92
      });
      const ringMesh = new THREE.Mesh(beaconGeo, beaconMat);
      ringMesh.lookAt(ringMesh.position.clone().add(up));
      spiralGroup.add(ringMesh);

      biomeTowers.push({
        biome,
        basePos,
        up,
        east,
        north,
        line,
        lineGeo,
        nodePositions,
        eonetMesh,
        ringMesh
      });
    }

    updateSpiralMonthVisuals();
    scene.add(spiralGroup);
  }

  function updateSpiralMetricPositions() {
    const col = new THREE.Color();
    for (const tower of biomeTowers) {
      const { biome, basePos, up, east, north, lineGeo, nodePositions, eonetMesh } = tower;
      const posAttr = lineGeo.getAttribute('position');
      const colAttr = lineGeo.getAttribute('color');
      const n = biome.records.length;
      for (let i = 0; i < n; i += 1) {
        const rec = biome.records[i];
        const theta = ((rec.month - 1) / 12) * Math.PI * 2;
        const h = 0.48 + (i / Math.max(1, n - 1)) * 8.15;
        const rho = 0.42 + computeRadialNorm(biome, rec, sim.metric) * 2.15;
        const pt = basePos.clone()
          .addScaledVector(up, h)
          .addScaledVector(east, Math.cos(theta) * rho)
          .addScaledVector(north, Math.sin(theta) * rho);
        nodePositions[i].copy(pt);
        posAttr.setXYZ(i, pt.x, pt.y, pt.z);
        anomalyColor(rec.zScore || 0, col);
        colAttr.setXYZ(i, col.r, col.g, col.b);
      }
      posAttr.needsUpdate = true;
      colAttr.needsUpdate = true;

      if (eonetMesh && eonetMesh.userData.flareIndices) {
        const dummy = new THREE.Matrix4();
        const s = new THREE.Vector3();
        const q = new THREE.Quaternion();
        eonetMesh.userData.flareIndices.forEach((recIdx, j) => {
          const sc = clamp(0.7 + Math.log1p(biome.records[recIdx].eonetFires || 1) * 0.45, 0.7, 2.0);
          s.set(sc, sc, sc);
          dummy.compose(nodePositions[recIdx], q, s);
          eonetMesh.setMatrixAt(j, dummy);
        });
        eonetMesh.instanceMatrix.needsUpdate = true;
      }
    }
    updateSpiralMonthVisuals();
  }

  function updateSpiralMonthVisuals() {
    for (const tower of biomeTowers) {
      const idx = clamp(sim.monthIndex, 0, tower.biome.records.length - 1);
      tower.lineGeo.setDrawRange(0, Math.max(2, idx + 1));

      const nodePos = tower.nodePositions[idx];
      if (nodePos && tower.ringMesh) {
        tower.ringMesh.position.copy(nodePos);
        tower.ringMesh.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, 1), tower.up);
        const z = tower.biome.records[idx].zScore || 0;
        tower.ringMesh.material.color.copy(anomalyColor(z));
      }

      if (tower.eonetMesh && tower.eonetMesh.userData.flareIndices) {
        let visibleCount = 0;
        for (const fIdx of tower.eonetMesh.userData.flareIndices) {
          if (fIdx <= idx) visibleCount += 1;
        }
        tower.eonetMesh.count = visibleCount;
      }
    }

    const activeBiome = biomeTowers[0]?.biome;
    const rec = activeBiome?.records[clamp(sim.monthIndex, 0, activeBiome.records.length - 1)];
    if (rec) {
      if (dom.timeReadout) dom.timeReadout.textContent = rec.ym;
      if (dom.hudYm) dom.hudYm.textContent = rec.ym;
      if (dom.timeSlider && Number(dom.timeSlider.value) !== sim.monthIndex) {
        dom.timeSlider.value = String(sim.monthIndex);
      }
    }
  }

  function initFlybyAudio() {
    const Tone = bridge.Tone || window.Tone;
    if (!Tone || audioBus.ready) return;
    try {
      audioBus.panner = new Tone.Panner(0);
      audioBus.filter = new Tone.Filter(1200, 'lowpass');
      audioBus.panner.connect(audioBus.filter);
      audioBus.filter.toDestination();

      audioBus.drone = new Tone.PolySynth(Tone.Synth, {
        oscillator: { type: 'triangle' },
        volume: -17,
        envelope: { attack: 0.16, decay: 0.25, sustain: 0.55, release: 0.85 }
      }).connect(audioBus.panner);

      // 3D Fire Flight continuous thermal violin voice (sawtooth glide)
      audioBus.violin = new Tone.Synth({
        oscillator: { type: 'sawtooth' },
        volume: -20,
        envelope: { attack: 0.08, decay: 0.2, sustain: 0.7, release: 0.5 }
      }).connect(audioBus.panner);

      audioBus.scanner = new Tone.FMSynth({
        harmonicity: 1.5,
        modulationIndex: 4,
        volume: -15,
        envelope: { attack: 0.01, decay: 0.12, sustain: 0.05, release: 0.22 }
      }).connect(audioBus.panner);

      audioBus.ember = new Tone.NoiseSynth({
        noise: { type: 'pink' },
        volume: -24,
        envelope: { attack: 0.004, decay: 0.045, sustain: 0, release: 0.02 }
      }).connect(audioBus.filter);

      audioBus.ready = true;
    } catch (err) {
      console.warn('Flyby audio setup deferred:', err);
    }
  }

  function updateSpatialAudio(nowMs, scanResult) {
    const state = bridge.getState();
    if (!state.audioReady) {
      if (dom.hudAudio) dom.hudAudio.textContent = 'Idle (Click Enable Audio)';
      return;
    }
    if (state.isMuted) {
      if (dom.hudAudio) dom.hudAudio.textContent = 'Muted';
      return;
    }
    initFlybyAudio();
    if (!audioBus.ready) return;

    const { biome, rec, distToBiome, fireBin, distToFire, iowaCell, pan } = scanResult;
    if (audioBus.panner && audioBus.panner.pan) {
      audioBus.panner.pan.rampTo(clamp(pan, -1, 1), 0.08);
    }

    const posZ = rec ? Math.max(0, rec.zScore) : 0;
    const proxBiome = clamp(1 - (distToBiome - 2) / 20, 0.08, 1);
    const tierInfo = bridge.tensionScale(posZ * proxBiome);

    if (audioBus.filter && audioBus.filter.frequency) {
      const targetCutoff = clamp(420 + proxBiome * 2600 + sim.craftSpeed * 180 + (fireBin ? Math.min(3500, fireBin.totalFrp * 6) : 0), 320, 8200);
      audioBus.filter.frequency.rampTo(targetCutoff, 0.12);
    }

    // Harmonic Pyro-Spiral Drone + 3D Fire Flight Continuous Thermal Violin every ~680ms
    if (nowMs - sim.lastDroneMs >= 680 && audioBus.drone && rec) {
      sim.lastDroneMs = nowMs;
      try {
        audioBus.drone.set({ detune: tierInfo.detuneCents * proxBiome });
        audioBus.drone.triggerAttackRelease(tierInfo.chord, 0.62, undefined, 0.14 + proxBiome * 0.24);
        if (audioBus.violin) {
          const frpNorm = fireBin ? clamp(fireBin.totalFrp / 2400, 0, 1) : clamp(posZ / 3.0, 0, 1);
          const violinFreq = 110 * Math.pow(2, frpNorm * 2.1);
          audioBus.violin.triggerAttackRelease(violinFreq, 0.58, undefined, 0.12 + frpNorm * 0.22);
        }
      } catch (_) {}
    }

    // Spoken biome arrival narration (from 3D Fire Flight + PyroSync telemetry)
    if (biome && distToBiome < 7.5 && audioBus.lastSpokenBiomeId !== biome.id) {
      audioBus.lastSpokenBiomeId = biome.id;
      if ('speechSynthesis' in window && !state.isMuted) {
        try {
          window.speechSynthesis.cancel();
          const u = new SpeechSynthesisUtterance(
            `Flying over ${biome.name}. Climate departure ${(rec?.zScore || 0).toFixed(1)} sigma, ${tierInfo.label.split(' ')[0]}.`
          );
          u.rate = 1.05;
          window.speechSynthesis.speak(u);
        } catch (_) {}
      }
    }

    // Spatial Hex/Fire Scanner Pulse
    const fireNear = fireBin && distToFire < 6.5;
    const pingInterval = fireNear ? clamp(380 - Math.min(220, fireBin.totalFrp * 0.45), 140, 380) : (iowaCell ? 260 : 480);

    if (nowMs - sim.lastPingMs >= pingInterval && audioBus.scanner) {
      sim.lastPingMs = nowMs;
      let intensity = clamp(posZ * proxBiome, 0.1, 3.3);
      if (iowaCell && Number.isFinite(iowaCell.A1)) {
        const tNorm = clamp((iowaCell.A1 - iowaRanges.A1.min) / (iowaRanges.A1.max - iowaRanges.A1.min || 1), 0, 1);
        intensity = clamp(0.4 + tNorm * 2.6, 0.2, 3.2);
      } else if (fireNear) {
        intensity = clamp(1.2 + Math.log1p(fireBin.totalFrp) * 0.35, 0.6, 3.5);
      }
      const note = bridge.pitchScale(intensity);
      const gain = clamp(0.12 + proxBiome * 0.28 + (fireNear ? 0.2 : 0), 0.1, 0.55);
      try {
        audioBus.scanner.triggerAttackRelease(note, 0.14, undefined, gain);
        if (fireNear && audioBus.ember) {
          audioBus.ember.triggerAttackRelease(0.035, undefined, 0.22);
        }
      } catch (_) {}
    }

    if (dom.hudAudio) {
      const panPct = Math.round(pan * 100);
      const panTag = Math.abs(panPct) < 8 ? 'C' : (panPct < 0 ? `L${Math.abs(panPct)}` : `R${panPct}`);
      dom.hudAudio.textContent = `${tierInfo.label.split(' ')[0]} · Pan ${panTag}`;
    }
  }

  function stepFlightPhysics(dt) {
    const manualInput =
      sim.keys.has('KeyW') || sim.keys.has('ArrowUp') ||
      sim.keys.has('KeyS') || sim.keys.has('ArrowDown') ||
      sim.keys.has('KeyA') || sim.keys.has('ArrowLeft') ||
      sim.keys.has('KeyD') || sim.keys.has('ArrowRight') ||
      sim.keys.has('KeyQ') || sim.keys.has('KeyE') ||
      sim.keys.has('ShiftLeft') || sim.keys.has('ShiftRight') ||
      sim.keys.has('Space') || sim.padCtrls.size > 0 || Math.abs(sim.dragYaw) > 0.001 || Math.abs(sim.dragPitch) > 0.001;

    if (manualInput && sim.autopilot) {
      setAutopilot(false);
    }

    const forward = FWD_Z.clone().applyQuaternion(sim.craftQuat).normalize();
    const up = UP_Y.clone().applyQuaternion(sim.craftQuat).normalize();
    const right = RIGHT_X.clone().applyQuaternion(sim.craftQuat).normalize();
    const radialOut = sim.craftPos.clone().normalize();

    if (sim.autopilot) {
      // Compute orbital target position around selected waypoint
      let tLat = 0;
      let tLon = (sim.elapsed * 7.5) % 360 - 180;
      let desiredAlt = 8.2;
      let orbitR = 3.2;

      if (sim.targetId === 'iowa') {
        tLat = 42.0;
        tLon = -93.5;
        desiredAlt = 2.6;
        orbitR = 1.65;
      } else if (sim.targetId !== 'cruise') {
        const tb = biomeTowers.find((t) => t.biome.id === sim.targetId);
        if (tb) {
          tLat = tb.biome.lat;
          tLon = tb.biome.lon;
          desiredAlt = 4.6;
          orbitR = 4.5;
        }
      }

      if (sim.targetId === 'cruise') {
        // Sweeping undulating figure-8 survey orbit crossing latitudes
        tLat = Math.sin(sim.elapsed * 0.16) * 44;
        tLon = ((sim.elapsed * 9.5) % 360) - 180;
        const desiredPos = latLonAltToVec3(tLat, tLon, EARTH_R + desiredAlt, tmpV1);
        tmpV2.subVectors(desiredPos, sim.craftPos);
      } else {
        // Circle smoothly around biome spiral / Iowa hex center
        const centerVec = latLonAltToVec3(tLat, tLon, EARTH_R + desiredAlt, tmpV3);
        const cUp = centerVec.clone().normalize();
        const cEast = new THREE.Vector3().crossVectors(UP_Y, cUp).normalize();
        const cNorth = new THREE.Vector3().crossVectors(cUp, cEast).normalize();
        const ang = sim.elapsed * 0.42;
        const patrolPt = centerVec.clone()
          .addScaledVector(cEast, Math.cos(ang) * orbitR)
          .addScaledVector(cNorth, Math.sin(ang) * orbitR);
        patrolPt.normalize().multiplyScalar(EARTH_R + desiredAlt);
        tmpV2.subVectors(patrolPt, sim.craftPos);
      }

      const targetDir = tmpV2.clone().normalize();
      // Compute steering torque toward targetDir & upright local radial horizon
      const turnAxis = new THREE.Vector3().crossVectors(forward, targetDir);
      const yawCmd = clamp(turnAxis.dot(up) * 2.2, -1.6, 1.6);
      const pitchCmd = clamp(turnAxis.dot(right) * 2.2, -1.3, 1.3);
      // Slight gentle bank into turns
      const desiredUp = radialOut.clone().addScaledVector(right, -yawCmd * 0.35).normalize();
      const bankErr = new THREE.Vector3().crossVectors(up, desiredUp).dot(forward);
      const rollCmd = clamp(bankErr * 2.6, -1.6, 1.6);

      tmpQ.setFromEuler(new THREE.Euler(pitchCmd * dt, yawCmd * dt, rollCmd * dt, 'YXZ'));
      sim.craftQuat.multiply(tmpQ).normalize();

      const cruiseSpeed = sim.targetId === 'iowa' ? 2.1 : (bridge.getState().prefersReducedMotion ? 1.8 : 3.5);
      sim.craftSpeed += (cruiseSpeed - sim.craftSpeed) * Math.min(1, dt * 2.2);
    } else {
      // Manual 6-DOF flight controls
      let pitchIn = 0;
      let yawIn = 0;
      let rollIn = 0;
      if (sim.keys.has('KeyW') || sim.keys.has('ArrowUp') || sim.padCtrls.has('pitchUp')) pitchIn += 1;
      if (sim.keys.has('KeyS') || sim.keys.has('ArrowDown') || sim.padCtrls.has('pitchDown')) pitchIn -= 1;
      if (sim.keys.has('KeyA') || sim.keys.has('ArrowLeft') || sim.padCtrls.has('yawLeft')) yawIn += 1;
      if (sim.keys.has('KeyD') || sim.keys.has('ArrowRight') || sim.padCtrls.has('yawRight')) yawIn -= 1;
      if (sim.keys.has('KeyQ') || sim.padCtrls.has('rollLeft')) rollIn += 1;
      if (sim.keys.has('KeyE') || sim.padCtrls.has('rollRight')) rollIn -= 1;

      pitchIn += sim.dragPitch;
      yawIn += sim.dragYaw;
      sim.dragPitch *= 0.65;
      sim.dragYaw *= 0.65;

      // Damped angular velocity
      const turnRate = 1.45;
      sim.angVel.x += (pitchIn * turnRate - sim.angVel.x) * Math.min(1, dt * 8);
      sim.angVel.y += (yawIn * turnRate - sim.angVel.y) * Math.min(1, dt * 8);
      sim.angVel.z += (rollIn * 2.1 - sim.angVel.z) * Math.min(1, dt * 8);

      // Horizon lock gently levels wings with planetary radial normal
      let autoRoll = 0;
      if (sim.horizonLock && Math.abs(rollIn) < 0.05) {
        const rollErr = new THREE.Vector3().crossVectors(up, radialOut).dot(forward);
        autoRoll = clamp(rollErr * 1.9, -1.2, 1.2);
      }

      tmpQ.setFromEuler(new THREE.Euler(
        sim.angVel.x * dt,
        sim.angVel.y * dt,
        (sim.angVel.z + autoRoll) * dt,
        'YXZ'
      ));
      sim.craftQuat.multiply(tmpQ).normalize();

      if (sim.keys.has('ShiftLeft') || sim.keys.has('ShiftRight') || sim.padCtrls.has('boost')) {
        sim.craftSpeed = Math.min(8.5, sim.craftSpeed + dt * 5.2);
      } else if (sim.keys.has('Space') || sim.padCtrls.has('brake')) {
        sim.craftSpeed = Math.max(0.55, sim.craftSpeed - dt * 5.5);
      } else {
        sim.craftSpeed += (2.9 - sim.craftSpeed) * Math.min(1, dt * 0.9);
      }
    }

    // Advance spacecraft position along forward vector
    const updatedFwd = FWD_Z.clone().applyQuaternion(sim.craftQuat).normalize();
    sim.craftPos.addScaledVector(updatedFwd, sim.craftSpeed * dt);

    // Spherical safety altitude envelope (skim cleanly over Earth, never clip core)
    const r = sim.craftPos.length();
    if (r < MIN_RADIUS) {
      const normal = sim.craftPos.clone().normalize();
      sim.craftPos.copy(normal).multiplyScalar(MIN_RADIUS);
      // Gently deflect forward tangent along crust if diving downward
      const inward = updatedFwd.dot(normal);
      if (inward < 0) {
        const tangentFwd = updatedFwd.clone().addScaledVector(normal, -inward).normalize();
        const rot = new THREE.Quaternion().setFromUnitVectors(updatedFwd, tangentFwd);
        sim.craftQuat.premultiply(rot).normalize();
      }
    } else if (r > MAX_RADIUS) {
      const normal = sim.craftPos.clone().normalize();
      sim.craftPos.copy(normal).multiplyScalar(MAX_RADIUS);
      const inwardDir = normal.clone().negate();
      const nudge = new THREE.Quaternion().setFromUnitVectors(updatedFwd, updatedFwd.clone().lerp(inwardDir, 0.25).normalize());
      sim.craftQuat.premultiply(nudge).normalize();
    }

    if (craftGroup) {
      craftGroup.position.copy(sim.craftPos);
      craftGroup.quaternion.copy(sim.craftQuat);
      // Scale exhaust plumes with speed
      const flame = clamp(0.6 + (sim.craftSpeed / 8.5) * 1.6, 0.6, 2.2);
      if (plumeLeft && plumeRight) {
        plumeLeft.scale.set(1, 1, flame);
        plumeRight.scale.set(1, 1, flame);
      }
      if (exhaustLight) exhaustLight.intensity = 1.0 + (sim.craftSpeed / 8.5) * 2.4;
    }

    updateCameraForCraft(dt);
  }

  function updateCameraForCraft(dt) {
    if (!camera) return;
    const fwd = FWD_Z.clone().applyQuaternion(sim.craftQuat).normalize();
    const up = UP_Y.clone().applyQuaternion(sim.craftQuat).normalize();
    const radialOut = sim.craftPos.clone().normalize();

    if (sim.camMode === 'cockpit') {
      craftGroup.visible = false;
      const eye = sim.craftPos.clone().addScaledVector(fwd, 0.25).addScaledVector(up, 0.15);
      // Pitch eye down slightly toward Earth hex surface below nose
      const lookPt = eye.clone().addScaledVector(fwd, 8).addScaledVector(radialOut, -1.65);
      camera.position.copy(eye);
      camera.up.copy(up);
      camera.lookAt(lookPt);
      return;
    }

    craftGroup.visible = true;
    if (sim.camMode === 'orbit') {
      const target = new THREE.Vector3(0, 0, 0).lerp(sim.craftPos, 0.35);
      const d = sim.orbitDist + EARTH_R * 0.8;
      const cx = target.x + d * Math.cos(sim.orbitPitch) * Math.cos(sim.orbitYaw);
      const cy = target.y + d * Math.sin(sim.orbitPitch);
      const cz = target.z + d * Math.cos(sim.orbitPitch) * Math.sin(sim.orbitYaw);
      camera.position.lerp(tmpV1.set(cx, cy, cz), Math.min(1, dt * 6));
      camera.up.set(0, 1, 0);
      camera.lookAt(target);
      return;
    }

    // Default: Chase Cam
    const chaseOffset = fwd.clone().multiplyScalar(-3.35).addScaledVector(up, 1.05);
    const desiredCamPos = sim.craftPos.clone().add(chaseOffset);
    // Keep camera above planet surface too
    if (desiredCamPos.length() < EARTH_R + 0.85) {
      desiredCamPos.normalize().multiplyScalar(EARTH_R + 0.85);
    }
    const desiredLook = sim.craftPos.clone().addScaledVector(fwd, 6.5).addScaledVector(radialOut, -0.8);

    const smooth = Math.min(1, dt * 8.5);
    sim.camPos.lerp(desiredCamPos, smooth);
    sim.camLook.lerp(desiredLook, smooth);
    camera.position.copy(sim.camPos);
    camera.up.lerp(up, smooth);
    camera.lookAt(sim.camLook);
  }

  function scanFootprint() {
    const geo = vec3ToLatLonAlt(sim.craftPos);
    const craftRight = RIGHT_X.clone().applyQuaternion(sim.craftQuat).normalize();

    // Nearest biome tower
    let nearestTower = null;
    let minBiomeDist = Infinity;
    for (const tower of biomeTowers) {
      const d = sim.craftPos.distanceTo(tower.basePos);
      if (d < minBiomeDist) {
        minBiomeDist = d;
        nearestTower = tower;
      }
    }

    // Nearest active MODIS fire bin
    let nearestFire = null;
    let minFireDist = Infinity;
    for (const bin of fireHexBins) {
      if (!bin.pos) continue;
      const d = sim.craftPos.distanceTo(bin.pos);
      if (d < minFireDist) {
        minFireDist = d;
        nearestFire = bin;
      }
    }

    // Check if over Central Iowa MODIS H3 res-7 patch
    let iowaCell = null;
    let currentH3Res3 = '';
    if (window.h3) {
      const res7Id = window.h3.latLngToCell(geo.lat, geo.lon, 7);
      iowaCell = iowaCellMap.get(res7Id) || null;
      currentH3Res3 = window.h3.latLngToCell(geo.lat, geo.lon, 3);
    }

    let historyCell = null;
    if (window.h3 && activeHistoryLevel && historyGroup?.visible) {
      const id = window.h3.latLngToCell(geo.lat, geo.lon, activeHistoryLevel.res);
      const row = activeHistoryLevel.cells.get(id);
      if (row) historyCell = { res: activeHistoryLevel.res, detections: row[0], density: row[1] };
    }

    const activeRec = nearestTower
      ? nearestTower.biome.records[clamp(sim.monthIndex, 0, nearestTower.biome.records.length - 1)]
      : null;

    // Directional bearing to closest hot target (fire cluster if close, else biome)
    const dirTarget = (nearestFire && minFireDist < minBiomeDist) ? nearestFire.pos : nearestTower?.basePos;
    let pan = 0;
    if (dirTarget) {
      const toT = tmpV1.subVectors(dirTarget, sim.craftPos).normalize();
      pan = clamp(toT.dot(craftRight), -1, 1);
    }

    return {
      geo,
      biome: nearestTower?.biome || null,
      rec: activeRec,
      distToBiome: minBiomeDist,
      fireBin: nearestFire,
      distToFire: minFireDist,
      iowaCell,
      historyCell,
      currentH3Res3,
      pan
    };
  }

  function updateHudReadout(nowMs, scan) {
    if (nowMs - sim.lastHudMs < 90) return;
    sim.lastHudMs = nowMs;

    const kmAlt = Math.round(scan.geo.altUnits * 265);
    const kmSpd = (sim.craftSpeed * 2.4).toFixed(1);
    const latStr = `${Math.abs(scan.geo.lat).toFixed(1)}°${scan.geo.lat >= 0 ? 'N' : 'S'}`;
    const lonStr = `${Math.abs(scan.geo.lon).toFixed(1)}°${scan.geo.lon >= 0 ? 'E' : 'W'}`;

    if (dom.hudMode) {
      dom.hudMode.textContent = sim.autopilot ? `AUTO · ${sim.targetId.toUpperCase()}` : 'MANUAL PILOT';
    }
    if (dom.hudAlt) dom.hudAlt.textContent = `${kmAlt.toLocaleString()} km`;
    if (dom.hudSpd) dom.hudSpd.textContent = `${kmSpd} km/s`;
    if (dom.hudLatLon) dom.hudLatLon.textContent = `${latStr}, ${lonStr}`;
    if (dom.hudTarget) dom.hudTarget.textContent = scan.iowaCell ? 'Iowa MODIS H3' : (scan.biome ? scan.biome.name : 'Open Ocean');

    if (dom.hudSigma && scan.rec) {
      const sign = scan.rec.zScore >= 0 ? '+' : '';
      dom.hudSigma.textContent = `${sign}${scan.rec.zScore.toFixed(2)}σ · FFWI ${scan.rec.ffwi.toFixed(1)}`;
    }

    if (dom.hudHex) {
      if (scan.iowaCell && Number.isFinite(scan.iowaCell.A1)) {
        const ndviStr = Number.isFinite(scan.iowaCell.A2) ? scan.iowaCell.A2.toFixed(2) : '—';
        dom.hudHex.textContent = `H3 ${scan.iowaCell.id.slice(0, 7)}… ${scan.iowaCell.A1.toFixed(1)}°C · NDVI ${ndviStr}`;
      } else if (scan.fireBin && scan.distToFire < 8.5 && fireGroup?.visible !== false) {
        dom.hudHex.textContent = `${scan.fireBin.count} hotspots · ${Math.round(scan.fireBin.totalFrp)} MW FRP`;
      } else if (scan.historyCell) {
        const { res, detections, density } = scan.historyCell;
        const per1000 = (density * 1000).toPrecision(2);
        dom.hudHex.textContent = `${fireHistoryYears()} r${res}: ${detections.toLocaleString()} fires · ${per1000}/1000 km²/yr`;
      } else if (scan.currentH3Res3) {
        dom.hudHex.textContent = `H3 r3 ${scan.currentH3Res3}`;
      }
    }
  }

  function animate(nowMs) {
    if (!sim.active) {
      sim.rafId = null;
      return;
    }
    sim.rafId = requestAnimationFrame(animate);
    const dt = sim.lastTime ? Math.min(0.05, (nowMs - sim.lastTime) / 1000) : 0.016;
    sim.lastTime = nowMs;
    sim.elapsed += dt;

    // Advance 3D Pyro Spiral timeline if playing
    if (sim.timelinePlaying) {
      sim.timelineAccum += dt;
      if (sim.timelineAccum >= 0.14) {
        sim.timelineAccum = 0;
        sim.monthIndex = (sim.monthIndex + 1) % totalMonths;
        updateSpiralMonthVisuals();
      }
    }

    stepFlightPhysics(dt);
    updateFireHistoryLod((sim.craftPos.length() - EARTH_R) * KM_PER_UNIT);
    const scan = scanFootprint();
    updateHudReadout(nowMs, scan);
    updateSpatialAudio(nowMs, scan);

    if (starField && !bridge.getState().prefersReducedMotion) {
      starField.rotation.y += dt * 0.004;
    }
    renderer.render(scene, camera);
  }

  function setAutopilot(enabled) {
    sim.autopilot = enabled;
    if (dom.btnAutopilot) {
      dom.btnAutopilot.setAttribute('aria-pressed', String(enabled));
      dom.btnAutopilot.textContent = enabled ? '🛰️ Autopilot Cruise' : '🕹️ Manual Pilot';
    }
  }

  function selectWaypoint(targetId) {
    sim.targetId = targetId;
    setAutopilot(true);
    if (dom.waypoints) {
      dom.waypoints.querySelectorAll('button').forEach((btn) => {
        btn.classList.toggle('is-target', btn.dataset.target === targetId);
      });
    }
  }

  function renderWaypointButtons(biomes) {
    if (!dom.waypoints) return;
    dom.waypoints.innerHTML = '';
    const targets = [
      { id: 'cruise', label: '🌍 Global Orbit' },
      { id: 'iowa', label: '⬡ Iowa MODIS H3' },
      ...biomes.map((b) => ({ id: b.id, label: `🌀 ${b.name.split(' & ')[0]}` }))
    ];
    for (const t of targets) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'btn btn-mini';
      btn.dataset.target = t.id;
      btn.textContent = t.label;
      if (t.id === sim.targetId) btn.classList.add('is-target');
      btn.addEventListener('click', () => selectWaypoint(t.id));
      dom.waypoints.appendChild(btn);
    }
  }

  function syncRendererSize() {
    if (!renderer || !camera || !dom.viewport) return;
    const rect = dom.viewport.getBoundingClientRect();
    const w = Math.max(320, Math.round(rect.width));
    const h = Math.max(320, Math.round(rect.height));
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
  }

  function wireControls() {
    dom.btnAutopilot?.addEventListener('click', () => setAutopilot(!sim.autopilot));
    dom.btnCam?.addEventListener('click', () => {
      const nextIdx = (CAM_MODES.indexOf(sim.camMode) + 1) % CAM_MODES.length;
      sim.camMode = CAM_MODES[nextIdx];
      dom.btnCam.textContent = CAM_LABELS[sim.camMode];
    });
    dom.btnHorizon?.addEventListener('click', () => {
      sim.horizonLock = !sim.horizonLock;
      dom.btnHorizon.setAttribute('aria-pressed', String(sim.horizonLock));
    });
    dom.btnReset?.addEventListener('click', () => {
      selectWaypoint('cruise');
      resetCraftToOrbit(26, -124, 7.2);
    });

    dom.btnPlay?.addEventListener('click', async () => {
      sim.timelinePlaying = !sim.timelinePlaying;
      dom.btnPlay.setAttribute('aria-pressed', String(sim.timelinePlaying));
      dom.btnPlay.textContent = sim.timelinePlaying ? '⏸ Pause Spirals' : '▶ Play 2001–2026';
      if (sim.timelinePlaying) await bridge.ensureAudioStarted();
    });

    dom.timeSlider?.addEventListener('input', (e) => {
      sim.monthIndex = clamp(Number(e.target.value), 0, totalMonths - 1);
      updateSpiralMonthVisuals();
    });

    dom.layerHex?.addEventListener('click', (e) => {
      const next = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(next));
      if (hexGroup) hexGroup.visible = next;
    });
    dom.layerSpirals?.addEventListener('click', (e) => {
      const next = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(next));
      if (spiralGroup) spiralGroup.visible = next;
    });
    dom.layerFires?.addEventListener('click', (e) => {
      const next = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(next));
      if (fireGroup) fireGroup.visible = next;
    });

    dom.layerHistory?.addEventListener('click', (e) => {
      const next = e.currentTarget.getAttribute('aria-pressed') !== 'true';
      e.currentTarget.setAttribute('aria-pressed', String(next));
      if (historyGroup) historyGroup.visible = next;
    });

    dom.metricSelect?.addEventListener('change', (e) => {
      sim.metric = e.target.value;
      updateSpiralMetricPositions();
    });

    // Keyboard flight listeners scoped cleanly to Tab 3
    window.addEventListener('keydown', (e) => {
      if (!sim.active) return;
      const tag = e.target?.tagName;
      if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
      if (e.target?.getAttribute?.('role') === 'tab') return;
      if (tag === 'BUTTON' && (e.code === 'Space' || e.code === 'Enter')) return;

      const flightCodes = ['KeyW', 'KeyA', 'KeyS', 'KeyD', 'KeyQ', 'KeyE', 'ShiftLeft', 'ShiftRight', 'Space', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'];
      if (flightCodes.includes(e.code)) {
        if (e.target === dom.viewport || !e.code.startsWith('Arrow')) {
          e.preventDefault();
        }
        sim.keys.add(e.code);
      } else if (e.code === 'KeyV') {
        dom.btnCam?.click();
      }
    });

    window.addEventListener('keyup', (e) => {
      sim.keys.delete(e.code);
    });

    // On-screen thruster hold buttons (pointer/mouse/touch)
    document.querySelectorAll('.flyby-ctrl-btn').forEach((btn) => {
      const ctrl = btn.dataset.ctrl;
      const activate = () => {
        sim.padCtrls.add(ctrl);
        btn.classList.add('is-active');
      };
      const release = () => {
        sim.padCtrls.delete(ctrl);
        btn.classList.remove('is-active');
      };
      btn.addEventListener('pointerdown', activate);
      btn.addEventListener('pointerup', release);
      btn.addEventListener('pointerleave', release);
      btn.addEventListener('pointercancel', release);
      btn.addEventListener('blur', release);
    });

    // Drag to steer / orbit inside Three.js canvas
    let lastX = 0;
    let lastY = 0;
    dom.canvas?.addEventListener('pointerdown', (e) => {
      dom.viewport?.focus();
      sim.pointerDrag = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('pointermove', (e) => {
      if (!sim.pointerDrag || !sim.active) return;
      const dx = e.clientX - lastX;
      const dy = e.clientY - lastY;
      lastX = e.clientX;
      lastY = e.clientY;
      if (sim.camMode === 'orbit') {
        sim.orbitYaw += dx * 0.008;
        sim.orbitPitch = clamp(sim.orbitPitch + dy * 0.008, -1.2, 1.2);
      } else {
        sim.dragYaw = clamp(-dx * 0.08, -2.5, 2.5);
        sim.dragPitch = clamp(-dy * 0.08, -2.5, 2.5);
      }
    });
    window.addEventListener('pointerup', () => {
      sim.pointerDrag = false;
    });
  }

  async function ensureInitialized() {
    if (sim.initialized || sim.initializing) return;
    sim.initializing = true;
    setBanner('Loading Three.js planetary core & H3 grid…');

    try {
      const state = bridge.getState();
      const [h3, iowaRes] = await Promise.all([
        loadH3Once(),
        fetch('./midwest/data/midwest.json').then((r) => (r.ok ? r.json() : null)).catch(() => null)
      ]);

      scene = new THREE.Scene();
      scene.fog = new THREE.FogExp2('#040812', 0.0045);

      const rect = dom.viewport.getBoundingClientRect();
      const w = Math.max(320, Math.round(rect.width || 960));
      const h = Math.max(320, Math.round(rect.height || 540));
      camera = new THREE.PerspectiveCamera(56, w / h, 0.1, 450);

      renderer = new THREE.WebGLRenderer({ canvas: dom.canvas, antialias: true, powerPreference: 'high-performance' });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2));
      renderer.setSize(w, h, false);

      // Lighting
      scene.add(new THREE.HemisphereLight('#93c5fd', '#1e293b', 0.95));
      const sun = new THREE.DirectionalLight('#fff7ed', 2.0);
      sun.position.set(55, 34, 48);
      scene.add(sun);
      const rimLight = new THREE.DirectionalLight('#38bdf8', 0.65);
      rimLight.position.set(-45, -20, -40);
      scene.add(rimLight);

      // Planet Earth sphere + atmosphere + starfield
      const earthTex = createEarthTexture(state.worldGeo, state.biomes);
      const earth = new THREE.Mesh(
        new THREE.SphereGeometry(EARTH_R, 72, 48),
        new THREE.MeshStandardMaterial({ map: earthTex, roughness: 0.78, metalness: 0.08 })
      );
      scene.add(earth);
      scene.add(createAtmosphereMesh());
      buildStarfield();

      buildGeodesicHexLayer(h3, state.biomes, iowaRes);
      buildModisFireHexColumns(h3, state.dataset?.hotspots || []);
      buildPyroSpirals(state.biomes);
      buildSpacecraft();
      renderWaypointButtons(state.biomes);
      wireControls();

      resizeObserver = new ResizeObserver(syncRendererSize);
      resizeObserver.observe(dom.viewport);

      sim.initialized = true;
      setBanner('', true);
      loadFireHistory(h3).catch((err) => console.warn('Fire history layer unavailable:', err));
    } catch (err) {
      console.error('Orbital flyby initialization failed:', err);
      setBanner(`Failed to initialize 3D view: ${err.message}`);
    } finally {
      sim.initializing = false;
    }
  }

  async function setActive(isActive) {
    sim.active = isActive;
    if (!isActive) {
      sim.keys.clear();
      sim.padCtrls.clear();
      if (sim.rafId) {
        cancelAnimationFrame(sim.rafId);
        sim.rafId = null;
      }
      return;
    }

    await ensureInitialized();
    syncRendererSize();
    sim.lastTime = 0;
    if (sim.initialized && !sim.rafId && sim.active) {
      sim.rafId = requestAnimationFrame(animate);
    }
  }

  return {
    setActive,
    syncMonth(monthIdx) {
      sim.monthIndex = clamp(monthIdx, 0, totalMonths - 1);
      if (sim.initialized) updateSpiralMonthVisuals();
    }
  };
}

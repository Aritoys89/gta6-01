// Port Solano — world generation. A deterministic, seeded coastal city:
// a 7x7 block grid wrapped in roads, a casino strip in the north, docks in
// the south, and a beach + sea along the east edge. All art is drawn in
// code by game.js; this module only produces geometry and answers
// collision / road queries.
// Units are world pixels: x grows east toward the beach and the sea,
// y grows south toward the docks.

export const BLOCK = 220;          // block size (px)
export const ROAD = 64;            // road width (px)
export const PITCH = BLOCK + ROAD; // 284
export const GRID = 7;             // 7x7 blocks
export const CITY = GRID * BLOCK + (GRID + 1) * ROAD; // 2052
export const BEACH = 96;           // sand strip east of the city
export const SEA = 336;            // water east of the beach
export const WORLD_W = CITY + BEACH + SEA; // 2484
export const WORLD_H = CITY;               // 2052
export const SEA_X = CITY + BEACH;         // water starts here

// Deterministic RNG (mulberry32) so a seed always builds the same city.
export function makeRng(seed) {
  let a = (seed >>> 0) || 1;
  return function rng() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const ROOFS = ['#8e44ad', '#a93268', '#c25e3a', '#b03a4b', '#7d3c98', '#935116', '#6c3483', '#884ea0', '#af601a', '#76448a'];
const WALLS = ['#f0b27a', '#e5989b', '#d98880', '#f5cba7', '#e6b0aa', '#f2d7a0', '#d7bde2', '#fad7a0'];
const CAR_COLORS = ['#e74c3c', '#3498db', '#f1c40f', '#2ecc71', '#e67e22', '#9b59b6', '#ecf0f1', '#1abc9c', '#fd79a8', '#95a5a6', '#d35400', '#5dade2'];

export function randomCarColor(rng) { return CAR_COLORS[Math.floor(rng() * CAR_COLORS.length)]; }

// Block helpers: block (col,row) occupies [x0, x0+220] x [y0, y0+220].
export function blockOrigin(col, row) {
  return { x: col * PITCH + ROAD, y: row * PITCH + ROAD };
}
export function blockCenter(col, row) {
  const o = blockOrigin(col, row);
  return { x: o.x + BLOCK / 2, y: o.y + BLOCK / 2 };
}

// Road bands: vertical roads at x = i*PITCH .. i*PITCH+ROAD (i in 0..7).
export function roadVX(i) { return i * PITCH; }
export function roadHY(i) { return i * PITCH; }

export function buildWorld(seed) {
  const rng = makeRng(seed);
  const buildings = [];   // {x,y,w,h,hgt,roof,wall,name?}
  const props = [];       // {x,y,kind} palms / lamps / crates / signs
  const lots = [];        // special ground decals {x,y,w,h,kind,label?}

  const addBuilding = (x, y, w, h, hgt, name) => {
    const b = {
      x, y, w, h, hgt,
      roof: ROOFS[Math.floor(rng() * ROOFS.length)],
      wall: WALLS[Math.floor(rng() * WALLS.length)],
      name: name || null,
      seed: rng(),
    };
    buildings.push(b);
    return b;
  };

  // Landmark block coordinates.
  const CASINO = { col: 3, row: 0 };
  const GARAGE = { col: 1, row: 5 };
  const CLINIC = { col: 2, row: 3 };
  const SAFEHOUSE = { col: 5, row: 2 };
  const AIRSTRIP = { col: 0, row: 0 };
  const DOCK_COLS = [4, 5, 6];

  const special = new Set([
    `${CASINO.col},${CASINO.row}`, `${GARAGE.col},${GARAGE.row}`, `${CLINIC.col},${CLINIC.row}`,
    `${SAFEHOUSE.col},${SAFEHOUSE.row}`, `${AIRSTRIP.col},${AIRSTRIP.row}`,
    ...DOCK_COLS.map(c => `${c},6`),
  ]);

  for (let row = 0; row < GRID; row++) {
    for (let col = 0; col < GRID; col++) {
      const { x, y } = blockOrigin(col, row);
      const key = `${col},${row}`;
      if (special.has(key)) continue;
      const roll = rng();
      if (roll < 0.14) {
        // Parking lot: asphalt decal + lamp posts, no buildings.
        lots.push({ x: x + 6, y: y + 6, w: BLOCK - 12, h: BLOCK - 12, kind: 'parking' });
        props.push({ x: x + 20, y: y + 20, kind: 'lamp' }, { x: x + BLOCK - 20, y: y + BLOCK - 20, kind: 'lamp' });
      } else if (roll < 0.24) {
        // Plaza: palms and benches, one kiosk.
        lots.push({ x: x + 6, y: y + 6, w: BLOCK - 12, h: BLOCK - 12, kind: 'plaza' });
        for (let i = 0; i < 5; i++) props.push({ x: x + 24 + rng() * (BLOCK - 48), y: y + 24 + rng() * (BLOCK - 48), kind: 'palm' });
        addBuilding(x + 84, y + 84, 52, 52, 14, null);
      } else {
        // Ordinary city block: 1-4 buildings with sidewalks around them.
        const n = 1 + Math.floor(rng() * 4);
        const cells = [[0, 0], [1, 0], [0, 1], [1, 1]];
        // shuffle cells deterministically
        for (let i = cells.length - 1; i > 0; i--) { const j = Math.floor(rng() * (i + 1)); [cells[i], cells[j]] = [cells[j], cells[i]]; }
        for (let i = 0; i < n; i++) {
          const [cx, cy] = cells[i];
          const bw = 62 + rng() * 34, bh = 62 + rng() * 34;
          const bx = x + 14 + cx * 104 + rng() * 10;
          const by = y + 14 + cy * 104 + rng() * 10;
          addBuilding(bx, by, bw, bh, 16 + rng() * 54, null);
        }
        if (rng() < 0.5) props.push({ x: x + 12, y: y + 12, kind: 'palm' });
        if (rng() < 0.4) props.push({ x: x + BLOCK - 12, y: y + BLOCK - 12, kind: 'lamp' });
      }
    }
  }

  // --- Casino block (3,0): one grand building, entrance apron south. ------
  {
    const { x, y } = blockOrigin(CASINO.col, CASINO.row);
    lots.push({ x: x + 2, y: y + 2, w: BLOCK - 4, h: BLOCK - 4, kind: 'casino-lot' });
    addBuilding(x + 18, y + 12, BLOCK - 36, 118, 64, 'SOLANO GRAND');
    props.push({ x: x + 24, y: y + 168, kind: 'palm' }, { x: x + BLOCK - 24, y: y + 168, kind: 'palm' });
    props.push({ x: x + 24, y: y + 196, kind: 'lamp' }, { x: x + BLOCK - 24, y: y + 196, kind: 'lamp' });
  }
  // --- Garage block (1,5): workshop on the north half, open apron south. --
  {
    const { x, y } = blockOrigin(GARAGE.col, GARAGE.row);
    lots.push({ x: x + 2, y: y + 100, w: BLOCK - 4, h: BLOCK - 102, kind: 'apron' });
    addBuilding(x + 22, y + 10, BLOCK - 44, 84, 20, "SOL'S GARAGE");
    props.push({ x: x + 16, y: y + 150, kind: 'crates' }, { x: x + BLOCK - 30, y: y + 190, kind: 'crates' });
  }
  // --- Clinic block (2,3). -------------------------------------------------
  {
    const { x, y } = blockOrigin(CLINIC.col, CLINIC.row);
    addBuilding(x + 30, y + 26, BLOCK - 60, 96, 30, 'SOLANO CLINIC');
    props.push({ x: x + 20, y: y + 180, kind: 'palm' }, { x: x + BLOCK - 20, y: y + 180, kind: 'lamp' });
  }
  // --- Safehouse block (5,2): a low house with a yard. ---------------------
  {
    const { x, y } = blockOrigin(SAFEHOUSE.col, SAFEHOUSE.row);
    lots.push({ x: x + 2, y: y + 2, w: BLOCK - 4, h: BLOCK - 4, kind: 'yard' });
    addBuilding(x + 52, y + 40, 116, 84, 16, 'SAFEHOUSE');
    props.push({ x: x + 26, y: y + 180, kind: 'palm' }, { x: x + BLOCK - 26, y: y + 40, kind: 'palm' });
  }
  // --- Airstrip block (0,0): runway decal, no buildings. -------------------
  {
    const { x, y } = blockOrigin(AIRSTRIP.col, AIRSTRIP.row);
    lots.push({ x: x + 4, y: y + 66, w: BLOCK - 8, h: 88, kind: 'runway' });
    lots.push({ x: x + 4, y: y + 4, w: BLOCK - 8, h: 52, kind: 'dirt' });
    lots.push({ x: x + 4, y: y + 164, w: BLOCK - 8, h: 52, kind: 'dirt' });
    props.push({ x: x + BLOCK - 18, y: y + 30, kind: 'windsock' });
  }
  // --- Dock blocks (4..6, 6): warehouses + crate stacks. -------------------
  for (const col of DOCK_COLS) {
    const { x, y } = blockOrigin(col, 6);
    lots.push({ x: x + 2, y: y + 2, w: BLOCK - 4, h: BLOCK - 4, kind: 'dockyard' });
    addBuilding(x + 16, y + 14, BLOCK - 32, 74, 22, col === 5 ? 'PIER 9 FREIGHT' : null);
    for (let i = 0; i < 3; i++) props.push({ x: x + 24 + rng() * (BLOCK - 60), y: y + 120 + rng() * 70, kind: 'crates' });
    props.push({ x: x + BLOCK - 18, y: y + 120, kind: 'lamp' });
  }

  // Pier: a wooden walkway reaching into the sea at dock height.
  const pier = { x: CITY - 6, y: blockOrigin(0, 6).y + 148, w: 250, h: 34 };
  // Beach palms along the sand.
  for (let i = 0; i < 9; i++) {
    props.push({ x: CITY + 16 + rng() * 30, y: 120 + i * 220 + rng() * 60, kind: 'palm' });
  }
  // Street lamps at intersections.
  for (let i = 0; i <= GRID; i++) for (let j = 0; j <= GRID; j++) {
    if ((i + j) % 2 === 0) props.push({ x: i * PITCH + 6, y: j * PITCH + 6, kind: 'lamp' });
  }

  const cCasino = blockCenter(CASINO.col, CASINO.row);
  const cGarage = blockCenter(GARAGE.col, GARAGE.row);
  const cClinic = blockCenter(CLINIC.col, CLINIC.row);
  const cSafe = blockCenter(SAFEHOUSE.col, SAFEHOUSE.row);
  const cStrip = blockCenter(AIRSTRIP.col, AIRSTRIP.row);
  const garageO = blockOrigin(GARAGE.col, GARAGE.row);
  const casinoO = blockOrigin(CASINO.col, CASINO.row);
  const clinicO = blockOrigin(CLINIC.col, CLINIC.row);
  const safeO = blockOrigin(SAFEHOUSE.col, SAFEHOUSE.row);

  const landmarks = {
    casino: { x: cCasino.x, y: casinoO.y + 150, label: 'Solano Grand Casino' },
    casinoDoor: { x: cCasino.x, y: casinoO.y + 138 },
    cometSpot: { x: cCasino.x - 52, y: roadHY(1) + 16, ang: Math.PI }, // parked on the road south of the casino
    garage: { x: cGarage.x, y: garageO.y + 158, label: "Sol Vega's Garage" },
    garageDoor: { x: cGarage.x, y: garageO.y + 100 },
    clinic: { x: cClinic.x, y: clinicO.y + 140, label: 'Solano Clinic' },
    clinicDoor: { x: cClinic.x, y: clinicO.y + 128 },
    safehouse: { x: cSafe.x, y: safeO.y + 150, label: 'Safehouse' },
    safeDoor: { x: cSafe.x, y: safeO.y + 128 },
    airstrip: { x: cStrip.x, y: cStrip.y, label: 'Old Airstrip' },
    docksPickup: { x: blockCenter(5, 6).x, y: blockOrigin(5, 6).y + 150, label: 'Pier 9 Freight' },
    crates: [4, 5, 6].map(c => ({ x: blockCenter(c, 6).x + (c === 5 ? 40 : -30), y: blockOrigin(c, 6).y + 168 })),
    pierEnd: { x: pier.x + pier.w - 26, y: pier.y + pier.h / 2, label: 'Pier Contact' },
  };

  return { seed, buildings, props, lots, pier, landmarks };
}

// --- queries ---------------------------------------------------------------
export function isWater(x, y, world) {
  if (x < SEA_X) return false;
  const p = world.pier;
  if (x >= p.x && x <= p.x + p.w && y >= p.y && y <= p.y + p.h) return false;
  return true;
}

export function onRoad(x, y) {
  const mx = ((x % PITCH) + PITCH) % PITCH;
  const my = ((y % PITCH) + PITCH) % PITCH;
  return mx < ROAD || my < ROAD;
}

// Push a circle (x, y, r) out of every building AABB and the sea.
// Returns the corrected {x, y} and whether anything was hit (and how hard,
// from the penetration depth) so callers can apply damage / crash sounds.
export function collideCircle(world, x, y, r) {
  let hit = 0;
  for (const b of world.buildings) {
    if (x < b.x - r || x > b.x + b.w + r || y < b.y - r || y > b.y + b.h + r) continue;
    const cx = Math.max(b.x, Math.min(x, b.x + b.w));
    const cy = Math.max(b.y, Math.min(y, b.y + b.h));
    let dx = x - cx, dy = y - cy;
    let d2 = dx * dx + dy * dy;
    if (d2 > r * r) continue;
    if (d2 < 0.0001) {
      // Centre inside the box: push out along the smallest axis.
      const left = x - b.x, right = b.x + b.w - x, top = y - b.y, bot = b.y + b.h - y;
      const m = Math.min(left, right, top, bot);
      if (m === left) x = b.x - r; else if (m === right) x = b.x + b.w + r;
      else if (m === top) y = b.y - r; else y = b.y + b.h + r;
      hit = Math.max(hit, r);
    } else {
      const d = Math.sqrt(d2);
      const push = r - d;
      x += (dx / d) * push; y += (dy / d) * push;
      hit = Math.max(hit, push);
    }
  }
  // Sea barrier: nothing drives or walks into the water (the pier is dry).
  // Push the centre back to the nearest dry point — a short cardinal scan
  // handles the thin pier as well as the open shoreline.
  if (isWater(x, y, world)) {
    let best = null;
    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
      for (let s = 2; s <= 80; s += 2) {
        const nx = x + dx * s, ny = y + dy * s;
        if (!isWater(nx, ny, world)) {
          if (!best || s < best.s) best = { x: nx, y: ny, s };
          break;
        }
      }
    }
    if (best) { x = best.x; y = best.y; } else { x = SEA_X - r; }
    hit = Math.max(hit, 1);
  }
  // World bounds.
  if (x < r) { x = r; hit = Math.max(hit, 1); }
  if (y < r) { y = r; hit = Math.max(hit, 1); }
  if (x > WORLD_W - r) { x = WORLD_W - r; hit = Math.max(hit, 1); }
  if (y > WORLD_H - r) { y = WORLD_H - r; hit = Math.max(hit, 1); }
  return { x, y, hit };
}

// Line of sight between two points: blocked by any building.
export function losBlocked(world, x1, y1, x2, y2) {
  const steps = Math.max(4, Math.floor(Math.hypot(x2 - x1, y2 - y1) / 26));
  for (let i = 1; i < steps; i++) {
    const t = i / steps;
    const x = x1 + (x2 - x1) * t, y = y1 + (y2 - y1) * t;
    for (const b of world.buildings) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) return true;
    }
  }
  return false;
}

// Snap a point to the nearest road centre-line point (for spawns / errands).
export function nearestRoadPoint(x, y) {
  const snap = (v) => {
    const i = Math.round((v - ROAD / 2) / PITCH);
    return Math.max(ROAD / 2, Math.min(CITY - ROAD / 2, i * PITCH + ROAD / 2));
  };
  const rx = snap(x), ry = snap(y);
  return Math.abs(rx - x) < Math.abs(ry - y) ? { x: rx, y } : { x, y: ry };
}

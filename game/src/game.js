// Port Solano: Sunset Takeover — an original top-down open-world crime game.
// Rio Vane, a broke wheelman, takes five jobs from fixer Sol Vega across a
// sunset coastal city: steal cars, run packages, dodge the law, and pull off
// the Sunset Takeover. Vanilla JS + canvas + WebAudio, no assets, no network.

import {
  buildWorld, makeRng, collideCircle, losBlocked, nearestRoadPoint,
  randomCarColor, WORLD_W, WORLD_H, CITY, SEA_X, PITCH, ROAD, blockCenter,
} from './world.js';
import { AudioSys } from './audio.js';

// ---------------------------------------------------------------- setup ----
const canvas = document.getElementById('game');
const ctx = canvas.getContext('2d');
const VW = 1280, VH = 720;
const params = new URLSearchParams(location.search);
const SHOT = params.get('shot'); // 'start' | 'play' | 'end' | null
const SEED = Number(params.get('seed') || 20261123) >>> 0;

const audio = new AudioSys();
const world = buildWorld(SEED);
const L = world.landmarks;
const rng = makeRng(SEED ^ 0x9e3779b9);

const SAVE_KEY = 'portsolano-save-v1';
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);
const angDiff = (a, b) => { let d = a - b; while (d > Math.PI) d -= Math.PI * 2; while (d < -Math.PI) d += Math.PI * 2; return d; };
const TAU = Math.PI * 2;

// ---------------------------------------------------------------- input ----
const keys = {};
let pressed = {}; // keys that went down this frame
addEventListener('keydown', (e) => {
  if (['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Space'].includes(e.code)) e.preventDefault();
  if (!keys[e.code]) pressed[e.code] = true;
  keys[e.code] = true;
  audio.ensure();
});
addEventListener('keyup', (e) => { keys[e.code] = false; });
canvas.addEventListener('pointerdown', () => audio.ensure());
const down = (...codes) => codes.some(c => keys[c]);
const hit = (...codes) => codes.some(c => pressed[c]);

// ---------------------------------------------------------------- state ----
const S = {
  mode: 'title',           // title | play | done (story-complete overlay)
  paused: false,
  shot: SHOT,
  time: 0,
  cash: 40,
  totalEarned: 0,
  mission: 0,              // index into MISSIONS; >= length means errands
  stage: 0,
  storyDone: false,
  busts: 0,
  wastedCount: 0,
  jobsDone: 0,
  wanted: 0,
  heat: 0,                 // seconds since police last saw the player
  bustMeter: 0,
  crimeCooldown: 0,
  banner: null,            // {title, sub, t}
  dialogue: null,          // {who, text, t, dur}
  notice: null,            // {text, t}
  overlay: null,           // {title, sub, t} busted / wasted splash
  errand: null,
  missionTimer: null,      // seconds left, or null
  shake: 0,
  startedAt: 0,
  playSecs: 0,
};

const player = {
  x: L.garage.x + 30, y: L.garage.y + 46, ang: -Math.PI / 2,
  vx: 0, vy: 0, hp: 100, car: null, punchCd: 0, stepT: 0, dead: false,
};

let cars = [];    // {x,y,ang,speed,color,kind,health,driver,lane...,smokeT}
let peds = [];    // {x,y,ang,speed,hp,state,fighter,cash,target,hitT}
let pickups = []; // {x,y,kind,amount,t}
let parts = [];   // particles {x,y,vx,vy,life,maxLife,color,size}
let cratesGot = [false, false, false];

function saveGame() {
  try {
    localStorage.setItem(SAVE_KEY, JSON.stringify({
      cash: S.cash, totalEarned: S.totalEarned, mission: S.mission,
      storyDone: S.storyDone, busts: S.busts, wastedCount: S.wastedCount,
      jobsDone: S.jobsDone, playSecs: S.playSecs,
    }));
  } catch { /* storage unavailable */ }
}
function loadSave() {
  try {
    const raw = localStorage.getItem(SAVE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch { return null; }
}

// ------------------------------------------------------------- entities ----
let carSeq = 0;
function makeCar(x, y, ang, kind, color) {
  return {
    id: carSeq++, x, y, ang, speed: 0,
    color: color || randomCarColor(rng),
    kind, // 'traffic' | 'parked' | 'cop' | 'comet'
    health: 100, driver: kind === 'traffic' ? 'ai' : null,
    len: kind === 'cop' ? 46 : 42, wid: 21,
    laneAxis: null, laneDir: 1, lanePos: 0, turnCd: 0, brake: 0,
    smokeT: 0, dead: false, sirenPhase: rng() * TAU,
  };
}

// Lane centre for a car travelling on a vertical road (x = road band start)
// or horizontal road (y = band start), right-hand traffic.
function laneFor(axis, bandStart, dir) {
  return bandStart + (dir > 0 ? ROAD - 16 : 16);
}

function spawnTrafficCar(nearX, nearY, anywhere = false) {
  for (let tries = 0; tries < 12; tries++) {
    const vertical = rng() < 0.5;
    const band = Math.floor(rng() * 8) * PITCH;
    const dir = rng() < 0.5 ? 1 : -1;
    const along = rng() * CITY;
    const lane = laneFor(vertical ? 'v' : 'h', band, dir);
    const x = vertical ? lane : along;
    const y = vertical ? along : lane;
    if (!anywhere && Math.hypot(x - nearX, y - nearY) < 460) continue;
    if (cars.some(c => Math.hypot(c.x - x, c.y - y) < 60)) continue;
    const car = makeCar(x, y, 0, 'traffic');
    car.laneAxis = vertical ? 'v' : 'h';
    car.laneDir = dir;
    car.lanePos = lane;
    car.ang = vertical ? (dir > 0 ? Math.PI / 2 : -Math.PI / 2) : (dir > 0 ? 0 : Math.PI);
    car.speed = 60 + rng() * 40;
    cars.push(car);
    return car;
  }
  return null;
}

function spawnParkedCar() {
  // Park along a random block edge, facing the road.
  for (let tries = 0; tries < 14; tries++) {
    const col = Math.floor(rng() * 7), row = Math.floor(rng() * 7);
    const c = blockCenter(col, row);
    const side = Math.floor(rng() * 4);
    const off = 118 + rng() * 40;
    let x = c.x, y = c.y, ang = 0;
    if (side === 0) { y = c.y - off; x += (rng() - 0.5) * 140; ang = 0; }
    if (side === 1) { y = c.y + off; x += (rng() - 0.5) * 140; ang = Math.PI; }
    if (side === 2) { x = c.x - off; y += (rng() - 0.5) * 140; ang = Math.PI / 2; }
    if (side === 3) { x = c.x + off; y += (rng() - 0.5) * 140; ang = -Math.PI / 2; }
    const p = nearestRoadPoint(x, y);
    x = p.x; y = p.y;
    if (Math.hypot(x - player.x, y - player.y) < 130) continue;
    if (cars.some(cc => Math.hypot(cc.x - x, cc.y - y) < 52)) continue;
    const car = makeCar(x, y, ang, 'parked');
    cars.push(car);
    return car;
  }
  return null;
}

function spawnPed(x, y) {
  const ped = {
    x, y, ang: rng() * TAU, speed: 0, hp: 60,
    state: 'wander', fighter: rng() < 0.25,
    cash: 5 + Math.floor(rng() * 21),
    target: null, hitT: 0, panicT: 0, dead: false,
    shirt: ['#f39c12', '#16a085', '#d35400', '#8e44ad', '#ecf0f1', '#e91e63', '#27ae60'][Math.floor(rng() * 7)],
    pants: ['#2c3e50', '#34495e', '#7f8c8d', '#6c3483'][Math.floor(rng() * 4)],
    walkPhase: rng() * TAU,
  };
  peds.push(ped);
  return ped;
}

function spawnPedNear() {
  for (let tries = 0; tries < 10; tries++) {
    const col = Math.floor(rng() * 7), row = Math.floor(rng() * 7);
    const c = blockCenter(col, row);
    const x = c.x + (rng() - 0.5) * 260, y = c.y + (rng() - 0.5) * 260;
    if (x < 20 || y < 20 || x > CITY - 10 || y > WORLD_H - 20) continue;
    if (Math.hypot(x - player.x, y - player.y) < 240) continue;
    const res = collideCircle(world, x, y, 9);
    if (res.hit > 0) continue;
    return spawnPed(x, y);
  }
  return null;
}

function spawnCop() {
  // Enter from a road at the edge of the player's view.
  const a = rng() * TAU;
  const d = 620 + rng() * 160;
  const p = nearestRoadPoint(clamp(player.x + Math.cos(a) * d, 40, CITY - 40), clamp(player.y + Math.sin(a) * d, 40, WORLD_H - 40));
  const cop = makeCar(p.x, p.y, Math.atan2(player.y - p.y, player.x - p.x), 'cop', '#ecf0f1');
  cop.driver = 'cop';
  cars.push(cop);
  return cop;
}

let comet = null;
function spawnComet() {
  if (comet && !comet.dead) return comet;
  comet = makeCar(L.cometSpot.x, L.cometSpot.y, L.cometSpot.ang, 'comet', '#f7c948');
  comet.len = 44;
  cars.push(comet);
  return comet;
}

// -------------------------------------------------------------- dialogue ---
function say(who, text, dur = 4.2) { S.dialogue = { who, text, t: 0, dur }; }
function banner(title, sub = '', t = 3) { S.banner = { title, sub, t }; }
function notice(text) { S.notice = { text, t: 2.6 }; }

function burst(x, y, n, color, speed = 90, size = 3) {
  for (let i = 0; i < n; i++) {
    const a = rng() * TAU, s = speed * (0.3 + rng() * 0.7);
    parts.push({ x, y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 0, maxLife: 0.4 + rng() * 0.5, color, size: size * (0.6 + rng() * 0.8) });
  }
}

// -------------------------------------------------------------- missions ---
// Each mission is a list of stages; a stage has a target point, a radius,
// an objective line, and an onArrive hook. Missions are data + small hooks
// so the story chain stays readable.
const MISSIONS = [
  {
    name: 'FIRST WHEELS', pay: 150,
    intro: () => say('Sol Vega', "Rio. You're broke, I'm busy, let's fix both. Meet me at my garage — south-west side. Walk if you must."),
    stages: [
      { target: () => L.garage, r: 46, label: "Meet Sol at her garage",
        arrive: () => say('Sol Vega', "Good, you can follow directions. Now steal me any car — E to hop in — and bring it back here. Try not to get seen.") },
      { target: () => L.garage, r: 52, label: 'Steal any car (E) and bring it back to the garage', needCar: 'any',
        arrive: () => say('Sol Vega', 'Wheels! She runs, she stops, she is legally... flexible. $150, as agreed.') },
    ],
  },
  {
    name: 'PACKAGE RUN', pay: 300,
    intro: () => say('Sol Vega', 'A package waits at Pier 9 Freight, down at the docks. Pick it up, drop it behind the casino. Clock is ticking once you grab it.'),
    stages: [
      { target: () => L.docksPickup, r: 44, label: 'Pick up the package at Pier 9 Freight (docks)',
        arrive: () => { S.missionTimer = 150; say('Sol Vega', "Package is hot. Casino service lane, north side — go, go!"); } },
      { target: () => ({ x: L.casino.x, y: L.casino.y - 118 }), r: 48, label: 'Deliver behind the Solano Grand Casino', timed: true,
        arrive: () => { S.missionTimer = null; say('Sol Vega', 'Clean drop. The Grand pays its debts — $300 coming your way.'); } },
    ],
  },
  {
    name: 'HOT PURSUIT', pay: 450,
    intro: () => say('Sol Vega', 'A stash sits in the safehouse, east side. Grab it and bring it to my garage. Fair warning: the law watches that street.'),
    stages: [
      { target: () => L.safehouse, r: 42, label: 'Grab the stash at the safehouse',
        arrive: () => { setWanted(Math.max(S.wanted, 2)); say('Sol Vega', 'That alarm was NOT in the brochure. Two stars — lose them or outrun them, just get here!'); } },
      { target: () => L.garage, r: 52, label: 'Deliver the stash to the garage', needCar: false,
        arrive: () => say('Sol Vega', 'You smell like burnt rubber and bad decisions. $450. Worth every cent.') },
    ],
  },
  {
    name: 'DOCKSIDE CRATES', pay: 600,
    intro: () => say('Sol Vega', 'Three crates walked off a truck at the docks. Collect all three, then meet my contact at the end of the pier.'),
    stages: [
      { target: () => crateTarget(), r: 40, label: 'Collect the crates at the docks (0/3)', dynamic: true,
        arrive: () => collectCrate() },
      { target: () => L.pierEnd, r: 42, label: 'Meet the contact at the end of the pier',
        arrive: () => say('Contact', 'Sol said you were quick. She undersold it. $600 — and tell her the pier is hers.') },
    ],
  },
  {
    name: 'THE SUNSET TAKEOVER', pay: 1500,
    intro: () => say('Sol Vega', "Last job, Rio. The golden Comet parked at my casino — Vega's own trophy car. Take it. Three stars the second you move it. Lose the law and reach the old airstrip, north-west."),
    stages: [
      { target: () => (comet && !comet.dead ? comet : L.cometSpot), r: 60, label: 'Steal the golden Comet at the casino', needCar: 'comet',
        arrive: () => { /* handled by enterCar hook */ } },
      { target: () => L.airstrip, r: 74, label: 'Escape to the old airstrip', needCar: 'comet',
        arrive: () => say('Sol Vega', 'You beautiful maniac. The strip, the sunset, and Vega counting his losses. We OWN this town now.') },
    ],
  },
];

function crateTarget() {
  const i = cratesGot.findIndex(g => !g);
  return i === -1 ? L.pierEnd : L.crates[i];
}
function collectCrate() {
  const i = cratesGot.findIndex(g => !g);
  if (i === -1) return;
  cratesGot[i] = true;
  audio.pickup();
  burst(L.crates[i].x, L.crates[i].y, 14, '#ffd166', 110, 3);
  const n = cratesGot.filter(Boolean).length;
  notice(`Crate collected (${n}/3)`);
  if (n >= 3) advanceStage();
  else {
    const st = MISSIONS[S.mission].stages[0];
    st.label = `Collect the crates at the docks (${n}/3)`;
  }
}

function currentStage() {
  if (S.mission < MISSIONS.length) return MISSIONS[S.mission].stages[S.stage];
  return S.errand;
}

function startMission(i) {
  S.mission = i; S.stage = 0; S.missionTimer = null;
  if (i === 3) cratesGot = [false, false, false];
  if (i === 4) spawnComet();
  const m = MISSIONS[i];
  banner(`MISSION ${i + 1} — ${m.name}`, `$${m.pay} on completion`);
  audio.click();
  if (m.intro) m.intro();
  saveGame();
}

function advanceStage() {
  const m = MISSIONS[S.mission];
  S.stage++;
  if (S.stage >= m.stages.length) completeMission();
}

function completeMission() {
  const m = MISSIONS[S.mission];
  S.cash += m.pay; S.totalEarned += m.pay; S.jobsDone++;
  audio.missionJingle(); audio.cash();
  banner('MISSION COMPLETE', `${m.name} — +$${m.pay}`);
  S.missionTimer = null;
  if (S.mission === MISSIONS.length - 1) {
    S.storyDone = true;
    setWanted(0);
    saveGame();
    setTimeout(() => { S.mode = 'done'; audio.fanfare(); }, 900);
    return;
  }
  const next = S.mission + 1;
  setTimeout(() => { if (S.mode === 'play') startMission(next); }, 2600);
  S.mission = MISSIONS.length; // gap state: no active objective until next starts
  S.errand = null;
  saveGame();
}

// Endless paid errands after the story (and during the gap between missions).
function makeErrand() {
  const spots = [L.casino, L.docksPickup, L.safehouse, L.clinic, L.pierEnd, L.airstrip, L.garage];
  const from = spots[Math.floor(rng() * spots.length)];
  let to = spots[Math.floor(rng() * spots.length)];
  if (to === from) to = L.casino;
  const pay = 80 + Math.floor(dist(from, to) / 12);
  S.errandStage = 0;
  S.errand = {
    name: 'ERRAND', pay, dynamic: false,
    target: () => (S.errandStage === 0 ? from : to), r: 48,
    label: S.errandStage === 0 ? `Pick up a fare package ($${pay} errand)` : 'Deliver the package',
    arrive: () => {
      if (S.errandStage === 0) {
        S.errandStage = 1;
        S.errand.label = 'Deliver the package';
        audio.pickup();
        notice('Package picked up');
      } else {
        S.cash += pay; S.totalEarned += pay; S.jobsDone++;
        audio.cash(); banner('ERRAND DONE', `+$${pay}`);
        S.errand = null;
        saveGame();
      }
    },
  };
}

// --------------------------------------------------------------- wanted ----
function witnesses(x, y, radius) {
  let seen = false;
  for (const p of peds) if (!p.dead && Math.hypot(p.x - x, p.y - y) < radius && !losBlocked(world, x, y, p.x, p.y)) seen = true;
  for (const c of cars) if (c.kind === 'cop' && Math.hypot(c.x - x, c.y - y) < radius + 60) seen = true;
  return seen;
}

function commitCrime(x, y, stars, radius = 170) {
  if (S.crimeCooldown > 0) return;
  if (witnesses(x, y, radius)) {
    setWanted(S.wanted + stars);
    S.crimeCooldown = 1.2;
  }
}

function setWanted(n) {
  S.wanted = clamp(n, 0, 5);
  if (S.wanted > 0) S.heat = 0;
}

function policeSeesPlayer() {
  for (const c of cars) {
    if (c.kind !== 'cop' || c.dead) continue;
    const d = Math.hypot(c.x - player.x, c.y - player.y);
    if (d < 340 && !losBlocked(world, c.x, c.y, player.x, player.y)) return true;
  }
  return false;
}

// ------------------------------------------------------------ car entry ----
function nearestCar(maxD) {
  let best = null, bd = maxD;
  for (const c of cars) {
    if (c.dead) continue;
    const d = Math.hypot(c.x - player.x, c.y - player.y);
    if (d < bd) { bd = d; best = c; }
  }
  return best;
}

function enterCar(car) {
  const wasParked = car.kind === 'parked' || car.speed < 4;
  if (car.driver === 'ai') {
    // Yank the driver out; they become a fleeing pedestrian.
    const ped = spawnPed(car.x + Math.cos(car.ang + Math.PI / 2) * 20, car.y + Math.sin(car.ang + Math.PI / 2) * 20);
    ped.state = 'flee'; ped.panicT = 3;
    car.driver = null;
  }
  player.car = car;
  car.driver = 'player';
  audio.door();
  if (wasParked || car.kind === 'traffic') commitCrime(car.x, car.y, 1);
  // Mission hooks: stealing the Comet starts the finale chase. Stage
  // advancement itself is handled by the arrival check (needCar gates it).
  if (S.mission === 4 && S.stage === 0 && car.kind === 'comet') {
    setWanted(Math.max(S.wanted, 3));
    say('Sol Vega', "That's the one! Three stars — the whole strip saw you. Airstrip, north-west. GO!");
  }
}

function exitCar() {
  const car = player.car;
  if (!car) return;
  car.driver = null;
  car.speed = 0;
  player.car = null;
  player.x = car.x + Math.cos(car.ang - Math.PI / 2) * 24;
  player.y = car.y + Math.sin(car.ang - Math.PI / 2) * 24;
  const res = collideCircle(world, player.x, player.y, 9);
  player.x = res.x; player.y = res.y;
  audio.door();
  audio.engine(false);
}

// -------------------------------------------------------------- respawn ----
function respawn(kind) {
  const fine = kind === 'busted'
    ? Math.min(S.cash, 50 + S.wanted * 25 + Math.floor(S.cash * 0.1))
    : Math.min(S.cash, 75);
  S.cash -= fine;
  if (kind === 'busted') S.busts++; else S.wastedCount++;
  if (player.car) { player.car.driver = null; player.car = null; }
  cars = cars.filter(c => c.kind !== 'cop');
  setWanted(0); S.bustMeter = 0;
  player.hp = 100; player.dead = false;
  player.x = L.clinicDoor.x; player.y = L.clinicDoor.y + 16;
  player.vx = 0; player.vy = 0;
  audio.engine(false); audio.siren(false);
  S.overlay = null;
  notice(kind === 'busted' ? `Busted! The clinic patched you up — fee $${fine}` : `Wasted! Clinic bill $${fine}`);
  // If the Comet was lost mid-finale, put it back at the casino.
  if (S.mission === 4 && S.stage === 1) {
    S.stage = 0;
    if (comet) { comet.dead = false; comet.health = 100; comet.x = L.cometSpot.x; comet.y = L.cometSpot.y; comet.ang = L.cometSpot.ang; comet.speed = 0; if (!cars.includes(comet)) cars.push(comet); }
    say('Sol Vega', 'They took the car back to the casino impound, huh? Steal it again. Properly this time.');
  }
  saveGame();
}

function triggerBusted() {
  S.overlay = { title: 'BUSTED', sub: 'Port Solano PD got their man', t: 2.4 };
  audio.bustedJingle(); audio.siren(false); audio.engine(false);
}
function triggerWasted() {
  S.overlay = { title: 'WASTED', sub: 'The sunset claims another wheelman', t: 2.4 };
  audio.fail(); audio.siren(false); audio.engine(false);
}

// --------------------------------------------------------------- update ----
function hurtPlayer(dmg) {
  if (player.dead || S.overlay) return;
  player.hp -= dmg;
  audio.hurt();
  if (player.hp <= 0) { player.hp = 0; player.dead = true; triggerWasted(); }
}

function damageCar(car, dmg) {
  car.health -= dmg;
  if (car.health <= 0 && !car.dead) {
    car.dead = true; car.speed = 0;
    burst(car.x, car.y, 22, '#555', 120, 4);
    burst(car.x, car.y, 10, '#ff9f43', 80, 3);
    audio.crash(1);
    if (player.car === car) { notice('Your ride is wrecked!'); }
  }
}

function updatePlayer(dt) {
  player.punchCd = Math.max(0, player.punchCd - dt);
  if (player.car) { updateDriving(dt); return; }
  // On foot.
  let mx = 0, my = 0;
  if (down('KeyW', 'ArrowUp')) my -= 1;
  if (down('KeyS', 'ArrowDown')) my += 1;
  if (down('KeyA', 'ArrowLeft')) mx -= 1;
  if (down('KeyD', 'ArrowRight')) mx += 1;
  const moving = (mx !== 0 || my !== 0);
  if (moving) {
    const len = Math.hypot(mx, my);
    player.ang = Math.atan2(my / len, mx / len);
    const sprint = down('ShiftLeft', 'ShiftRight') ? 1.45 : 1;
    const sp = 118 * sprint;
    player.x += (mx / len) * sp * dt;
    player.y += (my / len) * sp * dt;
    player.stepT += dt * (sprint > 1 ? 1.4 : 1);
  }
  const res = collideCircle(world, player.x, player.y, 9);
  player.x = res.x; player.y = res.y;
  // Cars push the player if they roll into him.
  for (const c of cars) {
    if (c.dead || Math.abs(c.speed) < 12) continue;
    const d = Math.hypot(c.x - player.x, c.y - player.y);
    if (d < 24) {
      hurtPlayer(Math.min(30, Math.abs(c.speed) * 0.16));
      player.x += Math.cos(Math.atan2(player.y - c.y, player.x - c.x)) * 14;
      player.y += Math.sin(Math.atan2(player.y - c.y, player.x - c.x)) * 14;
    }
  }
  // Enter a car.
  if (hit('KeyE')) {
    const car = nearestCar(38);
    if (car && car.kind !== 'cop') enterCar(car);
    else if (car && car.kind === 'cop') notice('Locked. Police cruisers stay police property.');
  }
  // Punch.
  if (hit('KeyF') && player.punchCd <= 0) {
    player.punchCd = 0.34;
    audio.punch();
    const px = player.x + Math.cos(player.ang) * 24, py = player.y + Math.sin(player.ang) * 24;
    burst(px, py, 3, '#ffeaa7', 60, 2);
    for (const p of peds) {
      if (p.dead) continue;
      if (Math.hypot(p.x - px, p.y - py) < 26) {
        p.hp -= 34; p.hitT = 0.25;
        p.x += Math.cos(player.ang) * 10; p.y += Math.sin(player.ang) * 10;
        audio.hurt();
        if (p.hp <= 0) {
          p.dead = true;
          pickups.push({ x: p.x, y: p.y, kind: 'cash', amount: p.cash, t: 0 });
          burst(p.x, p.y, 10, '#e74c3c', 70, 3);
          commitCrime(p.x, p.y, 2);
          notice(`Dropped $${p.cash}`);
        } else if (p.fighter) { p.state = 'fight'; }
        else { p.state = 'flee'; p.panicT = 2.6; commitCrime(p.x, p.y, 1); }
      }
    }
    for (const c of cars) {
      if (!c.dead && Math.hypot(c.x - px, c.y - py) < 30) damageCar(c, 3);
    }
  }
  audio.engine(false);
}

function updateDriving(dt) {
  const car = player.car;
  const fwd = down('KeyW', 'ArrowUp'), back = down('KeyS', 'ArrowDown');
  const left = down('KeyA', 'ArrowLeft'), right = down('KeyD', 'ArrowRight');
  const topSpeed = car.kind === 'comet' ? 252 : 218;
  const accel = car.kind === 'comet' ? 150 : 128;
  if (fwd) car.speed += accel * dt;
  else if (back) car.speed -= (car.speed > 4 ? 210 : 78) * dt;
  else car.speed -= car.speed * 0.55 * dt; // engine braking / drag
  if (!fwd && !back) car.speed -= Math.sign(car.speed) * Math.min(Math.abs(car.speed), 14 * dt);
  car.speed = clamp(car.speed, -82, topSpeed);
  const steer = (left ? -1 : 0) + (right ? 1 : 0);
  if (steer !== 0 && Math.abs(car.speed) > 2) {
    car.ang += steer * 2.05 * dt * clamp(Math.abs(car.speed) / 90, 0.25, 1) * Math.sign(car.speed);
  }
  const ox = car.x, oy = car.y;
  car.x += Math.cos(car.ang) * car.speed * dt;
  car.y += Math.sin(car.ang) * car.speed * dt;
  // Building collision: slide out, damage by impact speed.
  const res = collideCircle(world, car.x, car.y, 15);
  if (res.hit > 0.5) {
    const impact = Math.abs(car.speed);
    car.x = res.x; car.y = res.y;
    if (impact > 55) {
      damageCar(car, (impact - 55) * 0.22);
      hurtPlayer((impact - 55) * 0.05);
      audio.crash(clamp((impact - 55) / 130, 0.2, 1));
      burst(car.x, car.y, 8, '#dfe6e9', 90, 3);
      S.shake = Math.min(7, (impact - 55) / 22);
    }
    car.speed *= -0.25;
  }
  // Car vs car.
  for (const o of cars) {
    if (o === car || o.dead) continue;
    const d = Math.hypot(o.x - car.x, o.y - car.y);
    if (d < 34 && d > 0.01) {
      const push = (34 - d) / 2;
      const nx = (car.x - o.x) / d, ny = (car.y - o.y) / d;
      car.x += nx * push; car.y += ny * push;
      if (o.kind !== 'cop' || Math.abs(car.speed) > 30) { o.x -= nx * push; o.y -= ny * push; }
      const impact = Math.abs(car.speed - (o.speed || 0));
      if (impact > 42) {
        damageCar(car, (impact - 42) * 0.16);
        damageCar(o, (impact - 42) * 0.2);
        hurtPlayer((impact - 42) * 0.04);
        audio.crash(clamp(impact / 160, 0.2, 1));
        burst((car.x + o.x) / 2, (car.y + o.y) / 2, 9, '#ffeaa7', 100, 3);
        S.shake = Math.min(6, impact / 26);
        if (o.kind === 'cop') setWanted(Math.min(5, S.wanted + 1));
        car.speed *= 0.45; o.speed = (o.speed || 0) * 0.4;
      } else {
        car.speed *= 0.82;
      }
      if (o.driver === 'ai' && o.kind === 'traffic') { o.driver = null; const ped = spawnPed(o.x + 18, o.y); ped.state = 'flee'; ped.panicT = 3; o.kind = 'parked'; }
    }
  }
  // Running over pedestrians is very illegal.
  for (const p of peds) {
    if (p.dead) continue;
    if (Math.hypot(p.x - car.x, p.y - car.y) < 20 && Math.abs(car.speed) > 26) {
      p.dead = true;
      pickups.push({ x: p.x, y: p.y, kind: 'cash', amount: p.cash, t: 0 });
      burst(p.x, p.y, 12, '#e74c3c', 90, 3);
      audio.crash(0.5);
      commitCrime(p.x, p.y, 2, 200);
      hurtPlayer(0);
      notice('You ran someone down!');
    }
  }
  player.x = car.x; player.y = car.y; player.ang = car.ang;
  audio.engine(true, clamp(Math.abs(car.speed) / topSpeed, 0, 1));
  if (hit('KeyE') && Math.abs(car.speed) < 26) exitCar();
  // Smoke from a hurt engine.
  car.smokeT -= dt;
  if (car.health < 45 && car.smokeT <= 0) {
    car.smokeT = 0.09;
    parts.push({ x: car.x + Math.cos(car.ang) * 14, y: car.y + Math.sin(car.ang) * 14, vx: (rng() - 0.5) * 14, vy: -26 - rng() * 16, life: 0, maxLife: 0.8, color: car.health < 20 ? '#e67e22' : '#636e72', size: 4 });
  }
}

function updateTrafficCar(car, dt) {
  if (car.driver !== 'ai' || car.dead) return;
  // Obstacle scan ahead.
  let blocked = false;
  const ax = car.x + Math.cos(car.ang) * 46, ay = car.y + Math.sin(car.ang) * 46;
  for (const o of cars) {
    if (o === car) continue;
    if (Math.hypot(o.x - ax, o.y - ay) < 26) { blocked = true; break; }
  }
  if (!blocked) for (const p of peds) {
    if (!p.dead && Math.hypot(p.x - ax, p.y - ay) < 20) { blocked = true; break; }
  }
  if (!blocked && player.car !== car && !player.car && Math.hypot(player.x - ax, player.y - ay) < 20) blocked = true;
  const cruise = 78;
  car.speed += clamp((blocked ? 0 : cruise) - car.speed, -190 * dt, 62 * dt);
  car.x += Math.cos(car.ang) * car.speed * dt;
  car.y += Math.sin(car.ang) * car.speed * dt;
  // At an intersection, maybe turn onto the crossing road (right-hand lanes).
  car.turnCd -= dt;
  const inIntersection = ((car.x % PITCH) < ROAD) && ((car.y % PITCH) < ROAD);
  if (inIntersection && car.turnCd <= 0 && rng() < 0.012) {
    const bandX = Math.floor(car.x / PITCH) * PITCH, bandY = Math.floor(car.y / PITCH) * PITCH;
    if (car.laneAxis === 'v') {
      const dir = rng() < 0.5 ? 1 : -1;
      car.laneAxis = 'h'; car.laneDir = dir;
      car.y = laneFor('h', bandY, dir);
      car.lanePos = car.y;
      car.ang = dir > 0 ? 0 : Math.PI;
    } else {
      const dir = rng() < 0.5 ? 1 : -1;
      car.laneAxis = 'v'; car.laneDir = dir;
      car.x = laneFor('v', bandX, dir);
      car.lanePos = car.x;
      car.ang = dir > 0 ? Math.PI / 2 : -Math.PI / 2;
    }
    car.turnCd = 2.5;
  }
  // Keep to the lane on straights.
  if (car.laneAxis === 'v') car.x += (car.lanePos - car.x) * Math.min(1, dt * 2);
  else car.y += (car.lanePos - car.y) * Math.min(1, dt * 2);
  // Wrap / despawn far from the player.
  if (car.x < -30 || car.y < -30 || car.x > CITY + 30 || car.y > WORLD_H + 30) car.dead = true;
  const res = collideCircle(world, car.x, car.y, 14);
  car.x = res.x; car.y = res.y;
}

function updateCop(car, dt) {
  if (car.dead) return;
  car.sirenPhase += dt * 9;
  const target = { x: player.x, y: player.y };
  const d = Math.hypot(target.x - car.x, target.y - car.y);
  const want = Math.atan2(target.y - car.y, target.x - car.x);
  const turn = clamp(angDiff(want, car.ang), -2.4 * dt, 2.4 * dt);
  car.ang += turn;
  const topSpeed = 238;
  const desired = d > 60 ? topSpeed : topSpeed * 0.4;
  car.speed += clamp(desired - car.speed, -200 * dt, 118 * dt);
  car.x += Math.cos(car.ang) * car.speed * dt;
  car.y += Math.sin(car.ang) * car.speed * dt;
  const res = collideCircle(world, car.x, car.y, 15);
  if (res.hit > 0.5) { car.x = res.x; car.y = res.y; car.speed *= -0.2; damageCar(car, 2); }
  // Ram the player's car.
  if (player.car && Math.hypot(player.car.x - car.x, player.car.y - car.y) < 32) {
    damageCar(player.car, Math.abs(car.speed) * 0.05);
    hurtPlayer(1.2);
    audio.crash(0.4);
    car.speed *= 0.5;
    S.shake = Math.max(S.shake, 2.5);
  }
  // Despawn when the heat is off and they are far away.
  if (S.wanted === 0 && d > 560) car.dead = true;
}

function updatePed(p, dt) {
  if (p.dead) return;
  p.hitT = Math.max(0, p.hitT - dt);
  p.walkPhase += dt * (Math.abs(p.speed) > 4 ? 9 : 2);
  let tx = null, ty = null, speed = 0;
  const dPlayer = Math.hypot(player.x - p.x, player.y - p.y);
  const danger = (player.car && Math.abs(player.car.speed) > 60 && Math.hypot(player.car.x - p.x, player.car.y - p.y) < 90)
    || (S.wanted >= 3 && dPlayer < 60);
  if (p.state === 'fight' && player.car) { p.state = 'flee'; p.panicT = 2; }
  if (p.state === 'fight' && !player.car) {
    if (dPlayer > 22) { tx = player.x; ty = player.y; speed = 104; }
    else {
      p.atkT = (p.atkT || 0) - dt;
      if (p.atkT <= 0) { p.atkT = 0.85; hurtPlayer(6); burst(player.x, player.y, 4, '#e74c3c', 60, 2); }
      if (player.dead) p.state = 'flee';
    }
  } else if (p.state === 'flee' || danger) {
    p.state = 'flee'; p.panicT = Math.max(p.panicT, 0.6);
    const away = Math.atan2(p.y - player.y, p.x - player.x);
    tx = p.x + Math.cos(away) * 60; ty = p.y + Math.sin(away) * 60; speed = 138;
    p.panicT -= dt;
    if (p.panicT <= 0 && !danger) p.state = 'wander';
  } else {
    // Wander between sidewalk-ish points near blocks.
    if (!p.target || Math.hypot(p.target.x - p.x, p.target.y - p.y) < 12) {
      const c = blockCenter(Math.floor(rng() * 7), Math.floor(rng() * 7));
      p.target = { x: clamp(c.x + (rng() - 0.5) * 300, 16, CITY - 8), y: clamp(c.y + (rng() - 0.5) * 300, 16, WORLD_H - 16) };
    }
    tx = p.target.x; ty = p.target.y; speed = 42;
  }
  if (tx !== null && speed > 0) {
    const a = Math.atan2(ty - p.y, tx - p.x);
    p.ang += clamp(angDiff(a, p.ang), -6 * dt, 6 * dt);
    p.speed = speed;
    p.x += Math.cos(p.ang) * speed * dt;
    p.y += Math.sin(p.ang) * speed * dt;
    const res = collideCircle(world, p.x, p.y, 8);
    p.x = res.x; p.y = res.y;
    if (res.hit > 2) p.target = null;
  } else p.speed = 0;
  if (Math.hypot(p.x - player.x, p.y - player.y) > 900) p.dead = true; // far cleanup
}

// --------------------------------------------------------- master update ---
function update(dt) {
  S.time += dt;
  S.playSecs += dt;
  S.crimeCooldown = Math.max(0, S.crimeCooldown - dt);
  if (S.banner) { S.banner.t -= dt; if (S.banner.t <= 0) S.banner = null; }
  if (S.notice) { S.notice.t -= dt; if (S.notice.t <= 0) S.notice = null; }
  if (S.dialogue) { S.dialogue.t += dt; if (S.dialogue.t > S.dialogue.dur) S.dialogue = null; }
  S.shake = Math.max(0, S.shake - dt * 14);

  if (S.overlay) {
    S.overlay.t -= dt;
    if (S.overlay.t <= 0) respawn(S.overlay.title === 'BUSTED' ? 'busted' : 'wasted');
    return;
  }

  updatePlayer(dt);
  for (const c of cars) {
    if (c.kind === 'traffic') updateTrafficCar(c, dt);
    else if (c.kind === 'cop') updateCop(c, dt);
  }
  for (const p of peds) updatePed(p, dt);
  cars = cars.filter(c => !c.dead || c === player.car || c === comet);
  peds = peds.filter(p => !p.dead);

  // Pickups (dropped cash).
  for (const pk of pickups) {
    pk.t += dt;
    if (Math.hypot(pk.x - player.x, pk.y - player.y) < 26) {
      pk.got = true;
      S.cash += pk.amount; S.totalEarned += pk.amount;
      audio.cash();
      burst(pk.x, pk.y, 6, '#2ecc71', 70, 2);
    }
  }
  pickups = pickups.filter(p => !p.got && p.t < 40);

  // Particles.
  for (const pt of parts) {
    pt.life += dt;
    pt.x += pt.vx * dt; pt.y += pt.vy * dt;
    pt.vx *= 0.92; pt.vy *= 0.92;
  }
  parts = parts.filter(p => p.life < p.maxLife);

  // ---- wanted system -------------------------------------------------------
  const cops = cars.filter(c => c.kind === 'cop');
  if (S.wanted > 0) {
    if (policeSeesPlayer()) S.heat = 0; else S.heat += dt;
    if (S.heat > 13) { setWanted(S.wanted - 1); S.heat = 4; if (S.wanted === 0) notice('You lost the heat.'); }
    const wantCops = Math.min(2 + S.wanted, 6);
    if (cops.length < wantCops && rng() < dt * 0.9) spawnCop();
    audio.siren(cops.length > 0);
    // Bust meter: a nearby cruiser + a slow / on-foot player = arrest.
    const nearCop = cops.some(c => Math.hypot(c.x - player.x, c.y - player.y) < 62);
    const playerSpeed = player.car ? Math.abs(player.car.speed) : 0;
    if (nearCop && playerSpeed < 26 && !player.dead) {
      S.bustMeter += dt / 2.1;
      if (S.bustMeter >= 1) { S.bustMeter = 0; triggerBusted(); }
    } else {
      S.bustMeter = Math.max(0, S.bustMeter - dt * 0.7);
    }
  } else {
    audio.siren(false);
    S.bustMeter = Math.max(0, S.bustMeter - dt);
  }

  // ---- mission / errand progress ------------------------------------------
  const st = currentStage();
  if (st) {
    const t = st.target();
    const inRightCar = !st.needCar
      || (st.needCar === 'any' && !!player.car)
      || (st.needCar === 'comet' && player.car && player.car.kind === 'comet');
    if (dist(player, t) < st.r && inRightCar) {
      if (st.arrive) st.arrive();
      if (S.mission < MISSIONS.length && !st.dynamic) advanceStage();
      else if (S.mission >= MISSIONS.length && st === S.errand) { /* errand handles itself in arrive */ }
    }
  } else if (S.storyDone && S.mission >= MISSIONS.length && !S.errand) {
    makeErrand();
  }
  if (S.missionTimer !== null) {
    S.missionTimer -= dt;
    if (S.missionTimer <= 0) {
      S.missionTimer = null;
      audio.fail();
      banner('OUT OF TIME', 'Sol is not pleased. Try the run again.');
      S.stage = 0;
      say('Sol Vega', 'Too slow, Rio. The package run resets — docks first, then the casino. Again.');
    }
  }

  // ---- ambient population ---------------------------------------------------
  const trafficCount = cars.filter(c => c.kind === 'traffic').length;
  if (trafficCount < 13 && rng() < dt * 1.4) spawnTrafficCar(player.x, player.y);
  const parkedCount = cars.filter(c => c.kind === 'parked').length;
  if (parkedCount < 15 && rng() < dt * 0.8) spawnParkedCar();
  if (peds.length < 16 && rng() < dt * 1.6) spawnPedNear();
}

// ------------------------------------------------------------ game start ---
function resetWorldEntities() {
  cars = []; peds = []; pickups = []; parts = [];
  comet = null;
  for (let i = 0; i < 13; i++) spawnTrafficCar(player.x, player.y, true);
  for (let i = 0; i < 15; i++) spawnParkedCar();
  for (let i = 0; i < 15; i++) spawnPedNear();
}

function newGame() {
  Object.assign(S, {
    cash: 40, totalEarned: 0, mission: 0, stage: 0, storyDone: false,
    busts: 0, wastedCount: 0, jobsDone: 0, wanted: 0, heat: 0, bustMeter: 0,
    errand: null, missionTimer: null, playSecs: 0, overlay: null,
  });
  player.hp = 100; player.car = null; player.dead = false;
  player.x = L.garage.x + 36; player.y = L.garage.y + 52; player.ang = Math.PI;
  resetWorldEntities();
  S.mode = 'play'; S.paused = false;
  banner('PORT SOLANO', 'A sunset city, ripe for the taking');
  setTimeout(() => { if (S.mode === 'play') startMission(0); }, 1200);
}

function continueGame() {
  const sv = loadSave();
  if (!sv) { newGame(); return; }
  Object.assign(S, {
    cash: sv.cash ?? 40, totalEarned: sv.totalEarned ?? 0, storyDone: !!sv.storyDone,
    busts: sv.busts ?? 0, wastedCount: sv.wastedCount ?? 0, jobsDone: sv.jobsDone ?? 0,
    wanted: 0, heat: 0, bustMeter: 0, errand: null, missionTimer: null,
    playSecs: sv.playSecs ?? 0, overlay: null, stage: 0,
  });
  player.hp = 100; player.car = null; player.dead = false;
  player.x = L.garage.x + 36; player.y = L.garage.y + 52;
  resetWorldEntities();
  S.mode = 'play'; S.paused = false;
  if (sv.storyDone || (sv.mission ?? 0) >= MISSIONS.length) {
    S.mission = MISSIONS.length;
    banner('WELCOME BACK', 'Free roam — errands pay cash');
    makeErrand();
  } else {
    startMission(sv.mission ?? 0);
  }
}

// ---------------------------------------------------------- shot staging ---
function stageShot(kind) {
  resetWorldEntities();
  player.hp = 100;
  if (kind === 'start') {
    S.mode = 'title';
    player.x = L.casino.x; player.y = L.casino.y + 190;
    return;
  }
  if (kind === 'play') {
    S.mode = 'play';
    S.cash = 1250; S.totalEarned = 2450; S.jobsDone = 4;
    S.mission = 4; S.stage = 1; S.storyDone = false;
    spawnComet();
    // Rio is driving the golden Comet west along the casino strip road.
    comet.x = L.casino.x + 120; comet.y = 284 + 16; comet.ang = Math.PI; comet.speed = 0;
    comet.driver = 'player';
    player.car = comet;
    player.x = comet.x; player.y = comet.y; player.ang = Math.PI;
    player.hp = 82;
    setWanted(3);
    // Three cruisers closing in behind (east of) the Comet.
    const spots = [
      { x: comet.x + 120, y: 284 + 16, ang: Math.PI },
      { x: comet.x + 205, y: 284 + 46, ang: Math.PI + 0.12 },
      { x: comet.x + 90, y: 284 + 48, ang: Math.PI - 0.1 },
    ];
    for (const s of spots) {
      const cop = makeCar(s.x, s.y, s.ang, 'cop', '#ecf0f1');
      cop.driver = 'cop';
      cars.push(cop);
    }
    // A few bystanders on the casino sidewalk.
    for (let i = 0; i < 4; i++) {
      const p = spawnPed(L.casino.x - 130 + i * 62, L.casino.y + 108);
      p.state = 'wander'; p.target = { x: p.x, y: p.y };
    }
    say('Sol Vega', "That's Vega's golden Comet — the whole strip just saw you take it. Airstrip, north-west. RUN, Rio!", 9999);
    return;
  }
  if (kind === 'end') {
    S.mode = 'done';
    S.cash = 3040; S.totalEarned = 3000; S.jobsDone = 5;
    S.storyDone = true; S.mission = MISSIONS.length;
    S.busts = 1; S.wastedCount = 0; S.playSecs = 1500;
    player.x = L.airstrip.x; player.y = L.airstrip.y;
    spawnComet();
    comet.x = L.airstrip.x + 30; comet.y = L.airstrip.y + 6; comet.ang = 0.3;
    return;
  }
}

// -------------------------------------------------------------- rendering ---
const cam = { x: 0, y: 0 };
function updateCam() {
  cam.x = clamp(player.x - VW / 2, 0, Math.max(0, WORLD_W - VW));
  cam.y = clamp(player.y - VH / 2, 0, Math.max(0, WORLD_H - VH));
}

function drawWorld(t) {
  // Base ground: warm city soil / pavement tone.
  ctx.fillStyle = '#4a3560';
  ctx.fillRect(0, 0, VW, VH);
  const x0 = Math.max(0, cam.x - 40), y0 = Math.max(0, cam.y - 40);
  const x1 = Math.min(WORLD_W, cam.x + VW + 40), y1 = Math.min(WORLD_H, cam.y + VH + 40);

  // City ground slab.
  ctx.fillStyle = '#6b5570';
  ctx.fillRect(x0 - cam.x, y0 - cam.y, Math.min(CITY, x1) - x0, y1 - y0);
  // Beach sand.
  ctx.fillStyle = '#e8c07a';
  ctx.fillRect(Math.max(CITY, x0) - cam.x, y0 - cam.y, Math.min(SEA_X, x1) - Math.max(CITY, x0), y1 - y0);
  // Sea with slow animated shimmer bands.
  if (x1 > SEA_X) {
    const grad = ctx.createLinearGradient(SEA_X - cam.x, 0, WORLD_W - cam.x, 0);
    grad.addColorStop(0, '#2a9d8f');
    grad.addColorStop(1, '#1d6f8e');
    ctx.fillStyle = grad;
    ctx.fillRect(SEA_X - cam.x, y0 - cam.y, x1 - SEA_X, y1 - y0);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 2;
    ctx.beginPath();
    for (let i = 0; i < 7; i++) {
      const wy = ((i * 311 + Math.sin(t * 0.7 + i) * 8) % WORLD_H);
      if (wy < y0 - 20 || wy > y1 + 20) continue;
      const wx = SEA_X + 24 + ((i * 173) % 260);
      ctx.moveTo(wx - cam.x, wy - cam.y);
      ctx.lineTo(wx + 44 - cam.x, wy - cam.y);
    }
    ctx.stroke();
    // Foam line at the water's edge.
    ctx.strokeStyle = 'rgba(255,255,255,0.5)';
    ctx.beginPath();
    ctx.moveTo(SEA_X + Math.sin(t * 1.3) * 3 - cam.x, y0 - cam.y);
    ctx.lineTo(SEA_X + Math.sin(t * 1.3) * 3 - cam.x, y1 - cam.y);
    ctx.stroke();
  }

  // Lot decals.
  for (const lot of world.lots) {
    if (lot.x + lot.w < x0 || lot.x > x1 || lot.y + lot.h < y0 || lot.y > y1) continue;
    const lx = lot.x - cam.x, ly = lot.y - cam.y;
    if (lot.kind === 'parking' || lot.kind === 'apron' || lot.kind === 'dockyard') ctx.fillStyle = '#5d4a63';
    else if (lot.kind === 'plaza') ctx.fillStyle = '#8a6d8f';
    else if (lot.kind === 'yard') ctx.fillStyle = '#5e7d4f';
    else if (lot.kind === 'casino-lot') ctx.fillStyle = '#7a4a6e';
    else if (lot.kind === 'runway') ctx.fillStyle = '#3d3542';
    else if (lot.kind === 'dirt') ctx.fillStyle = '#9c7a54';
    else ctx.fillStyle = '#6b5570';
    ctx.fillRect(lx, ly, lot.w, lot.h);
    if (lot.kind === 'parking') {
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 2;
      for (let i = 1; i < 4; i++) {
        ctx.beginPath(); ctx.moveTo(lx + 14, ly + i * (lot.h / 4)); ctx.lineTo(lx + 60, ly + i * (lot.h / 4)); ctx.stroke();
        ctx.beginPath(); ctx.moveTo(lx + lot.w - 60, ly + i * (lot.h / 4)); ctx.lineTo(lx + lot.w - 14, ly + i * (lot.h / 4)); ctx.stroke();
      }
    }
    if (lot.kind === 'runway') {
      ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 4; ctx.setLineDash([22, 18]);
      ctx.beginPath(); ctx.moveTo(lx + 8, ly + lot.h / 2); ctx.lineTo(lx + lot.w - 8, ly + lot.h / 2); ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = '#ffd166';
      ctx.font = 'bold 26px system-ui, sans-serif'; ctx.textAlign = 'left';
      ctx.fillText('09', lx + 12, ly + lot.h / 2 + 34);
    }
  }

  // Roads: asphalt bands with edge lines and centre dashes.
  ctx.fillStyle = '#3a3340';
  for (let i = 0; i <= 7; i++) {
    const rx = i * PITCH - cam.x, ry = i * PITCH - cam.y;
    if (rx + ROAD > 0 && rx < VW) ctx.fillRect(rx, 0, ROAD, VH);
    if (ry + ROAD > 0 && ry < VH) ctx.fillRect(0, ry, VW, ROAD);
  }
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.55)';
  ctx.lineWidth = 2; ctx.setLineDash([18, 16]);
  ctx.beginPath();
  for (let i = 0; i <= 7; i++) {
    const rx = i * PITCH + ROAD / 2 - cam.x, ry = i * PITCH + ROAD / 2 - cam.y;
    if (rx > -10 && rx < VW + 10) { ctx.moveTo(rx, 0); ctx.lineTo(rx, VH); }
    if (ry > -10 && ry < VH + 10) { ctx.moveTo(0, ry); ctx.lineTo(VW, ry); }
  }
  ctx.stroke(); ctx.setLineDash([]);
  // Sidewalk rims around blocks.
  ctx.strokeStyle = 'rgba(230, 200, 170, 0.5)'; ctx.lineWidth = 3;
  for (let row = 0; row < 7; row++) for (let col = 0; col < 7; col++) {
    const bx = col * PITCH + ROAD - 4 - cam.x, by = row * PITCH + ROAD - 4 - cam.y;
    if (bx + 228 < 0 || bx > VW || by + 228 < 0 || by > VH) continue;
    ctx.strokeRect(bx, by, 228, 228);
  }

  // Pier.
  {
    const p = world.pier;
    ctx.fillStyle = '#8a6844';
    ctx.fillRect(p.x - cam.x, p.y - cam.y, p.w, p.h);
    ctx.strokeStyle = 'rgba(60,40,20,0.6)'; ctx.lineWidth = 2;
    for (let i = 0; i < 8; i++) {
      const px = p.x + i * (p.w / 8) - cam.x;
      ctx.beginPath(); ctx.moveTo(px, p.y - cam.y); ctx.lineTo(px, p.y + p.h - cam.y); ctx.stroke();
    }
    ctx.fillStyle = '#5d4326';
    for (let i = 0; i < 5; i++) ctx.fillRect(p.x + 10 + i * 52 - cam.x, p.y + p.h - cam.y, 8, 12);
  }

  // Props.
  for (const pr of world.props) {
    if (pr.x < x0 - 30 || pr.x > x1 + 30 || pr.y < y0 - 30 || pr.y > y1 + 30) continue;
    const px = pr.x - cam.x, py = pr.y - cam.y;
    if (pr.kind === 'palm') {
      ctx.strokeStyle = '#6d4c2f'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px + 3, py - 13); ctx.stroke();
      ctx.strokeStyle = '#2e9e5b'; ctx.lineWidth = 3;
      for (let i = 0; i < 5; i++) {
        const a = -Math.PI / 2 + (i - 2) * 0.5;
        ctx.beginPath(); ctx.moveTo(px + 3, py - 13);
        ctx.quadraticCurveTo(px + 3 + Math.cos(a) * 12, py - 13 + Math.sin(a) * 10 - 3, px + 3 + Math.cos(a) * 19, py - 13 + Math.sin(a) * 13 + 4);
        ctx.stroke();
      }
    } else if (pr.kind === 'lamp') {
      ctx.fillStyle = '#2f3542';
      ctx.fillRect(px - 2, py - 2, 4, 4);
      ctx.fillStyle = 'rgba(255, 214, 130, 0.9)';
      ctx.beginPath(); ctx.arc(px, py, 3.4, 0, TAU); ctx.fill();
    } else if (pr.kind === 'crates') {
      ctx.fillStyle = '#a9713d';
      ctx.fillRect(px - 11, py - 8, 22, 16);
      ctx.fillStyle = '#c08547';
      ctx.fillRect(px - 7, py - 15, 15, 12);
      ctx.strokeStyle = 'rgba(70,45,20,0.7)'; ctx.lineWidth = 1.5;
      ctx.strokeRect(px - 11, py - 8, 22, 16);
    } else if (pr.kind === 'windsock') {
      ctx.strokeStyle = '#dfe6e9'; ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(px, py); ctx.lineTo(px, py - 26); ctx.stroke();
      ctx.fillStyle = '#ff6b35';
      ctx.beginPath();
      ctx.moveTo(px, py - 26); ctx.lineTo(px + 16 + Math.sin(t * 2) * 2, py - 22); ctx.lineTo(px, py - 18);
      ctx.closePath(); ctx.fill();
    }
  }

  // Buildings: drop shadow, walls, roof, windows, name signs.
  for (const b of world.buildings) {
    if (b.x + b.w < x0 || b.x > x1 || b.y + b.h < y0 || b.y > y1) continue;
    const bx = b.x - cam.x, by = b.y - cam.y;
    const lift = b.hgt * 0.42;
    ctx.fillStyle = 'rgba(20, 8, 30, 0.35)';
    ctx.fillRect(bx + 7, by + 9, b.w, b.h);
    ctx.fillStyle = b.wall;
    ctx.fillRect(bx, by - lift + 8, b.w, b.h);
    ctx.fillStyle = b.roof;
    ctx.fillRect(bx, by - lift, b.w, b.h);
    ctx.strokeStyle = 'rgba(40, 16, 50, 0.55)'; ctx.lineWidth = 2;
    ctx.strokeRect(bx, by - lift, b.w, b.h);
    // Window grid on the roof face (reads as lit windows from above).
    ctx.fillStyle = 'rgba(255, 220, 130, 0.5)';
    const cols = Math.max(1, Math.floor(b.w / 22)), rowsN = Math.max(1, Math.floor(b.h / 22));
    for (let i = 0; i < cols; i++) for (let j = 0; j < rowsN; j++) {
      const h = Math.sin((b.seed * 91 + i * 37 + j * 57) * 12.9898) * 43758.5453;
      if ((h - Math.floor(h)) < 0.45) ctx.fillRect(bx + 6 + i * 22, by - lift + 6 + j * 22, 8, 6);
    }
    if (b.name) {
      ctx.font = 'bold 13px system-ui, sans-serif';
      ctx.textAlign = 'center';
      const w = ctx.measureText(b.name).width + 16;
      ctx.fillStyle = 'rgba(24, 8, 36, 0.85)';
      ctx.fillRect(bx + b.w / 2 - w / 2, by - lift - 24, w, 19);
      ctx.fillStyle = b.name.includes('GRAND') ? '#ffd166' : '#ffe9c9';
      ctx.fillText(b.name, bx + b.w / 2, by - lift - 10);
    }
  }
  // Casino marquee lights.
  {
    const c = L.casino;
    ctx.fillStyle = '#ff2e88';
    for (let i = 0; i < 9; i++) {
      const on = Math.sin(t * 4 + i * 1.3) > 0;
      ctx.globalAlpha = on ? 1 : 0.35;
      ctx.beginPath(); ctx.arc(c.x - 88 + i * 22 - cam.x, 158 - cam.y, 4, 0, TAU); ctx.fill();
    }
    ctx.globalAlpha = 1;
  }
}

function drawCarShape(car) {
  const x = car.x - cam.x, y = car.y - cam.y;
  if (x < -70 || x > VW + 70 || y < -70 || y > VH + 70) return;
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(car.ang);
  const L2 = car.len / 2, W2 = car.wid / 2;
  ctx.fillStyle = 'rgba(15,5,25,0.35)';
  ctx.fillRect(-L2 + 3, -W2 + 4, car.len, car.wid);
  // Body.
  ctx.fillStyle = car.dead ? '#3d3d44' : car.color;
  ctx.beginPath();
  ctx.roundRect(-L2, -W2, car.len, car.wid, 6);
  ctx.fill();
  if (car.kind === 'cop') {
    ctx.fillStyle = '#2b2d42';
    ctx.fillRect(-L2, -W2, car.len * 0.34, car.wid);
    ctx.fillRect(L2 - car.len * 0.3, -W2, car.len * 0.3, car.wid);
    // Light bar: flashing red / blue.
    const phase = Math.sin(car.sirenPhase) > 0;
    ctx.fillStyle = phase ? '#ff3838' : '#3867ff';
    ctx.fillRect(-4, -W2 + 2, 8, 6);
    ctx.fillStyle = phase ? '#3867ff' : '#ff3838';
    ctx.fillRect(-4, W2 - 8, 8, 6);
  }
  if (car.kind === 'comet' && !car.dead) {
    ctx.strokeStyle = '#fff3b0'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(-L2 + 2, -W2 + 2, car.len - 4, car.wid - 4, 5); ctx.stroke();
  }
  // Cabin / windshield.
  ctx.fillStyle = car.dead ? '#22222a' : '#22384f';
  ctx.beginPath(); ctx.roundRect(-6, -W2 + 3.5, 15, car.wid - 7, 3); ctx.fill();
  ctx.fillStyle = 'rgba(160, 220, 255, 0.5)';
  ctx.fillRect(7, -W2 + 4.5, 3, car.wid - 9);
  // Damage shading.
  if (car.health < 55 && !car.dead) {
    ctx.fillStyle = `rgba(30,30,30,${(55 - car.health) / 90})`;
    ctx.beginPath(); ctx.roundRect(-L2, -W2, car.len, car.wid, 6); ctx.fill();
  }
  ctx.restore();
}

function drawPed(p) {
  const x = p.x - cam.x, y = p.y - cam.y;
  if (x < -30 || x > VW + 30 || y < -30 || y > VH + 30) return;
  const bob = Math.sin(p.walkPhase) * (Math.abs(p.speed) > 4 ? 1.6 : 0.5);
  ctx.fillStyle = 'rgba(15,5,25,0.3)';
  ctx.beginPath(); ctx.ellipse(x, y + 5, 8, 3.5, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = p.pants;
  ctx.fillRect(x - 4.5, y - 1 + bob * 0.4, 9, 7);
  ctx.fillStyle = p.hitT > 0 ? '#ff6b6b' : p.shirt;
  ctx.beginPath(); ctx.roundRect(x - 6, y - 8 + bob * 0.3, 12, 10, 3); ctx.fill();
  ctx.fillStyle = '#f2c79b';
  ctx.beginPath(); ctx.arc(x, y - 11 + bob * 0.3, 4.6, 0, TAU); ctx.fill();
  if (p.state === 'fight') {
    ctx.fillStyle = '#ff3838';
    ctx.font = 'bold 13px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('!', x, y - 20);
  }
}

function drawPlayerFigure() {
  const x = player.x - cam.x, y = player.y - cam.y;
  const bob = Math.sin(player.stepT * 7) * 1.2;
  ctx.fillStyle = 'rgba(15,5,25,0.35)';
  ctx.beginPath(); ctx.ellipse(x, y + 5, 9, 4, 0, 0, TAU); ctx.fill();
  ctx.fillStyle = '#1f2a44';
  ctx.fillRect(x - 5, y - 1, 10, 8);
  // Rio's sunset-orange jacket.
  ctx.fillStyle = '#ff6b35';
  ctx.beginPath(); ctx.roundRect(x - 6.5, y - 9 + bob * 0.3, 13, 11, 3); ctx.fill();
  ctx.fillStyle = '#f2c79b';
  ctx.beginPath(); ctx.arc(x, y - 12 + bob * 0.3, 5, 0, TAU); ctx.fill();
  ctx.fillStyle = '#20242e';
  ctx.fillRect(x - 5, y - 16 + bob * 0.3, 10, 4); // cap
  // Facing tick.
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x + Math.cos(player.ang) * 9, y + Math.sin(player.ang) * 9);
  ctx.lineTo(x + Math.cos(player.ang) * 15, y + Math.sin(player.ang) * 15);
  ctx.stroke();
  // Punch flash.
  if (player.punchCd > 0.22) {
    ctx.strokeStyle = 'rgba(255, 234, 167, 0.9)';
    ctx.beginPath();
    ctx.arc(x + Math.cos(player.ang) * 20, y + Math.sin(player.ang) * 20, 7, 0, TAU);
    ctx.stroke();
  }
}

// ------------------------------------------------------- world overlays ----
function drawMarkers(t) {
  // Mission crates (dockside crates mission).
  if (S.mission === 3 && S.stage === 0) {
    L.crates.forEach((c, i) => {
      if (cratesGot[i]) return;
      const x = c.x - cam.x, y = c.y - cam.y;
      ctx.fillStyle = '#ffb703';
      ctx.fillRect(x - 10, y - 8 + Math.sin(t * 3 + i) * 2, 20, 16);
      ctx.strokeStyle = '#7a4a12'; ctx.lineWidth = 2;
      ctx.strokeRect(x - 10, y - 8 + Math.sin(t * 3 + i) * 2, 20, 16);
    });
  }
  // The golden Comet gets a gold beacon until it is taken.
  if (S.mission === 4 && S.stage === 0 && comet && !comet.dead && player.car !== comet) {
    drawBeacon(comet.x, comet.y, '#ffd700', t);
  }
  const st = currentStage();
  if (st && S.mode === 'play') {
    const tg = st.target();
    drawBeacon(tg.x, tg.y, '#ffd166', t);
    // Direction arrow at the screen edge when the target is off-screen.
    const sx = tg.x - cam.x, sy = tg.y - cam.y;
    if (sx < 20 || sx > VW - 20 || sy < 20 || sy > VH - 20) {
      const cxp = clamp(sx, 34, VW - 34), cyp = clamp(sy, 34, VH - 34);
      const a = Math.atan2(sy - VH / 2, sx - VW / 2);
      ctx.save();
      ctx.translate(cxp, cyp); ctx.rotate(a);
      ctx.fillStyle = '#ffd166';
      ctx.beginPath(); ctx.moveTo(14, 0); ctx.lineTo(-8, -8); ctx.lineTo(-8, 8); ctx.closePath(); ctx.fill();
      ctx.restore();
    }
  }
  // Cash pickups.
  for (const pk of pickups) {
    const x = pk.x - cam.x, y = pk.y - cam.y + Math.sin(t * 4 + pk.x) * 2;
    ctx.fillStyle = '#2ecc71';
    ctx.beginPath(); ctx.arc(x, y, 7, 0, TAU); ctx.fill();
    ctx.fillStyle = '#eaffea';
    ctx.font = 'bold 9px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('$', x, y + 3);
  }
  // Particles.
  for (const pt of parts) {
    ctx.globalAlpha = 1 - pt.life / pt.maxLife;
    ctx.fillStyle = pt.color;
    ctx.fillRect(pt.x - cam.x - pt.size / 2, pt.y - cam.y - pt.size / 2, pt.size, pt.size);
  }
  ctx.globalAlpha = 1;
}

function drawBeacon(wx, wy, color, t) {
  const x = wx - cam.x, y = wy - cam.y;
  const pulse = 1 + Math.sin(t * 4) * 0.18;
  const grad = ctx.createLinearGradient(0, y - 190, 0, y);
  grad.addColorStop(0, 'rgba(255, 209, 102, 0)');
  grad.addColorStop(1, 'rgba(255, 209, 102, 0.30)');
  ctx.fillStyle = color === '#ffd700' ? grad : grad;
  ctx.fillRect(x - 13, y - 190, 26, 190);
  ctx.strokeStyle = color; ctx.lineWidth = 3;
  ctx.beginPath(); ctx.arc(x, y, 20 * pulse, 0, TAU); ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x, y + 16 + Math.sin(t * 4) * 3);
  ctx.lineTo(x - 8, y + 2 + Math.sin(t * 4) * 3);
  ctx.lineTo(x + 8, y + 2 + Math.sin(t * 4) * 3);
  ctx.closePath(); ctx.fill();
}

// ------------------------------------------------------------------ HUD ----
function starRow() {
  ctx.font = '26px system-ui, sans-serif';
  ctx.textAlign = 'right';
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i < S.wanted ? (Math.sin(S.time * 6) > 0 || S.shot ? '#ffd166' : '#ff9f43') : 'rgba(255,255,255,0.22)';
    ctx.fillText('★', VW - 24 - (4 - i) * 30, 44);
  }
  if (S.wanted > 0 && S.heat > 3) {
    ctx.font = '12px system-ui, sans-serif';
    ctx.fillStyle = 'rgba(255,255,255,0.75)';
    ctx.fillText('heat cooling…', VW - 24, 66);
  }
}

function drawMinimap() {
  const mw = 188, mh = 158, mx = 16, my = VH - mh - 16;
  const sc = Math.min(mw / WORLD_W, mh / WORLD_H);
  const ox = mx + (mw - WORLD_W * sc) / 2, oy = my + (mh - WORLD_H * sc) / 2;
  ctx.fillStyle = 'rgba(16, 8, 28, 0.78)';
  ctx.beginPath(); ctx.roundRect(mx, my, mw, mh, 8); ctx.fill();
  ctx.strokeStyle = 'rgba(255, 209, 102, 0.5)'; ctx.lineWidth = 1.5;
  ctx.beginPath(); ctx.roundRect(mx, my, mw, mh, 8); ctx.stroke();
  ctx.save();
  ctx.beginPath(); ctx.roundRect(mx, my, mw, mh, 8); ctx.clip();
  // Land + sea.
  ctx.fillStyle = '#54436b';
  ctx.fillRect(ox, oy, CITY * sc, WORLD_H * sc);
  ctx.fillStyle = '#1d6f8e';
  ctx.fillRect(ox + SEA_X * sc, oy, (WORLD_W - SEA_X) * sc, WORLD_H * sc);
  ctx.fillStyle = '#e8c07a';
  ctx.fillRect(ox + CITY * sc, oy, (SEA_X - CITY) * sc, WORLD_H * sc);
  // Roads.
  ctx.strokeStyle = 'rgba(230,230,240,0.5)'; ctx.lineWidth = 1;
  ctx.beginPath();
  for (let i = 0; i <= 7; i++) {
    ctx.moveTo(ox + (i * PITCH + ROAD / 2) * sc, oy);
    ctx.lineTo(ox + (i * PITCH + ROAD / 2) * sc, oy + WORLD_H * sc);
    ctx.moveTo(ox, oy + (i * PITCH + ROAD / 2) * sc);
    ctx.lineTo(ox + CITY * sc, oy + (i * PITCH + ROAD / 2) * sc);
  }
  ctx.stroke();
  const dot = (wx, wy, color, r = 3) => {
    ctx.fillStyle = color;
    ctx.beginPath(); ctx.arc(ox + wx * sc, oy + wy * sc, r, 0, TAU); ctx.fill();
  };
  // Objective.
  const st = currentStage();
  if (st && S.mode === 'play') {
    const tg = st.target();
    if (Math.sin(S.time * 5) > -0.4 || S.shot) dot(tg.x, tg.y, '#ffd166', 4);
  }
  if (S.mission === 4 && S.stage === 0 && comet && !comet.dead) dot(comet.x, comet.y, '#ffd700', 3.4);
  // Police blips flash blue/red.
  for (const c of cars) if (c.kind === 'cop' && !c.dead) dot(c.x, c.y, Math.sin(S.time * 7 + c.id) > 0 ? '#ff3838' : '#4d7cff', 3);
  // Player arrow.
  ctx.save();
  ctx.translate(ox + player.x * sc, oy + player.y * sc);
  ctx.rotate(player.ang);
  ctx.fillStyle = '#ffffff';
  ctx.beginPath(); ctx.moveTo(6, 0); ctx.lineTo(-4, -4); ctx.lineTo(-4, 4); ctx.closePath(); ctx.fill();
  ctx.restore();
  ctx.restore();
}

function drawHUD() {
  // Cash + health (top-left).
  ctx.fillStyle = 'rgba(16, 8, 28, 0.66)';
  ctx.beginPath(); ctx.roundRect(16, 14, 218, 64, 8); ctx.fill();
  ctx.fillStyle = '#2ecc71';
  ctx.font = 'bold 24px system-ui, sans-serif'; ctx.textAlign = 'left';
  ctx.fillText(`$${S.cash}`, 28, 44);
  ctx.fillStyle = 'rgba(20, 12, 30, 0.9)';
  ctx.fillRect(28, 54, 150, 11);
  ctx.fillStyle = player.hp > 30 ? '#e74c3c' : (Math.sin(S.time * 8) > 0 ? '#e74c3c' : '#ff8fa3');
  ctx.fillRect(28, 54, 150 * clamp(player.hp, 0, 100) / 100, 11);
  ctx.strokeStyle = 'rgba(255,255,255,0.4)'; ctx.lineWidth = 1;
  ctx.strokeRect(28, 54, 150, 11);
  if (player.car) {
    ctx.fillStyle = 'rgba(20, 12, 30, 0.9)';
    ctx.fillRect(186, 54, 40, 11);
    ctx.fillStyle = '#f39c12';
    ctx.fillRect(186, 54, 40 * clamp(player.car.health, 0, 100) / 100, 11);
    ctx.strokeRect(186, 54, 40, 11);
  }
  starRow();
  // Mission name (top-right under stars).
  if (S.mission < MISSIONS.length) {
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#ffd166'; ctx.textAlign = 'right';
    ctx.fillText(`MISSION ${S.mission + 1}: ${MISSIONS[S.mission].name}`, VW - 24, 88);
  } else if (S.storyDone) {
    ctx.font = 'bold 13px system-ui, sans-serif';
    ctx.fillStyle = '#ffd166'; ctx.textAlign = 'right';
    ctx.fillText('FREE ROAM — PORT SOLANO IS YOURS', VW - 24, 88);
  }
  // Objective (top-centre).
  const st = currentStage();
  if (st) {
    const tg = st.target();
    const d = Math.round(dist(player, tg));
    ctx.font = 'bold 17px system-ui, sans-serif';
    const label = `${st.label}  ·  ${d}m`;
    const w = ctx.measureText(label).width + 34;
    ctx.fillStyle = 'rgba(16, 8, 28, 0.72)';
    ctx.beginPath(); ctx.roundRect(VW / 2 - w / 2, 14, w, 36, 9); ctx.fill();
    ctx.fillStyle = '#ffe9c9'; ctx.textAlign = 'center';
    ctx.fillText(label, VW / 2, 39);
  }
  // Mission timer.
  if (S.missionTimer !== null) {
    const sLeft = Math.max(0, Math.ceil(S.missionTimer));
    ctx.font = 'bold 22px system-ui, sans-serif';
    ctx.fillStyle = sLeft <= 20 ? (Math.sin(S.time * 8) > 0 ? '#ff3838' : '#ffd166') : '#ffe9c9';
    ctx.textAlign = 'center';
    ctx.fillText(`⏱ ${Math.floor(sLeft / 60)}:${String(sLeft % 60).padStart(2, '0')}`, VW / 2, 78);
  }
  // Bust meter.
  if (S.bustMeter > 0.02) {
    ctx.fillStyle = 'rgba(16, 8, 28, 0.75)';
    ctx.beginPath(); ctx.roundRect(VW / 2 - 110, VH - 120, 220, 26, 7); ctx.fill();
    ctx.fillStyle = '#3867ff';
    ctx.fillRect(VW / 2 - 102, VH - 112, 204 * clamp(S.bustMeter, 0, 1), 10);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 11px system-ui, sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('BUSTED METER — MOVE!', VW / 2, VH - 122 + 26);
  }
  // Speed (bottom-right while driving).
  if (player.car) {
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillStyle = '#ffe9c9'; ctx.textAlign = 'right';
    ctx.fillText(`${Math.round(Math.abs(player.car.speed) * 0.36)} km/h`, VW - 22, VH - 22);
  }
  drawMinimap();
  // Controls hint (bottom-centre, subtle).
  ctx.font = '12px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 240, 220, 0.55)'; ctx.textAlign = 'center';
  ctx.fillText(player.car ? 'WASD drive · E exit · P pause · M mute' : 'WASD move · Shift sprint · E enter car · F punch · P pause · M mute', VW / 2, VH - 10);
  // Banner.
  if (S.banner) {
    const a = clamp(S.banner.t, 0, 1);
    ctx.globalAlpha = a;
    ctx.textAlign = 'center';
    ctx.font = 'bold 40px system-ui, sans-serif';
    ctx.fillStyle = '#ffd166';
    ctx.shadowColor = 'rgba(0,0,0,0.7)'; ctx.shadowBlur = 12;
    ctx.fillText(S.banner.title, VW / 2, 150);
    ctx.shadowBlur = 0;
    if (S.banner.sub) {
      ctx.font = '17px system-ui, sans-serif';
      ctx.fillStyle = '#ffe9c9';
      ctx.fillText(S.banner.sub, VW / 2, 180);
    }
    ctx.globalAlpha = 1;
  }
  // Notice toast.
  if (S.notice) {
    ctx.font = 'bold 15px system-ui, sans-serif';
    const w = ctx.measureText(S.notice.text).width + 28;
    ctx.fillStyle = 'rgba(16, 8, 28, 0.8)';
    ctx.beginPath(); ctx.roundRect(VW / 2 - w / 2, 196, w, 30, 8); ctx.fill();
    ctx.fillStyle = '#aef2c1'; ctx.textAlign = 'center';
    ctx.fillText(S.notice.text, VW / 2, 216);
  }
  // Dialogue box.
  if (S.dialogue) {
    const d = S.dialogue;
    ctx.fillStyle = 'rgba(14, 6, 24, 0.88)';
    ctx.beginPath(); ctx.roundRect(240, VH - 108, VW - 480, 78, 10); ctx.fill();
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.roundRect(240, VH - 108, VW - 480, 78, 10); ctx.stroke();
    ctx.fillStyle = '#ffd166';
    ctx.font = 'bold 14px system-ui, sans-serif'; ctx.textAlign = 'left';
    ctx.fillText(d.who.toUpperCase(), 258, VH - 82);
    ctx.fillStyle = '#fff4e0';
    ctx.font = '15px system-ui, sans-serif';
    wrapText(d.text, 258, VH - 60, VW - 516, 20);
  }
}

function wrapText(text, x, y, maxW, lh) {
  const words = text.split(' ');
  let line = '', yy = y;
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (ctx.measureText(test).width > maxW && line) {
      ctx.fillText(line, x, yy);
      line = w; yy += lh;
    } else line = test;
  }
  if (line) ctx.fillText(line, x, yy);
}

// ---------------------------------------------------------------- screens ---
let titleButtons = [];
function drawTitle() {
  ctx.fillStyle = 'rgba(24, 6, 34, 0.55)';
  ctx.fillRect(0, 0, VW, VH);
  ctx.textAlign = 'center';
  ctx.font = 'bold 92px system-ui, sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.shadowColor = 'rgba(255, 60, 120, 0.65)'; ctx.shadowBlur = 26;
  ctx.fillText('PORT SOLANO', VW / 2, 208);
  ctx.shadowBlur = 0;
  ctx.font = 'bold 34px system-ui, sans-serif';
  ctx.fillStyle = '#ff6b9d';
  ctx.fillText('S U N S E T   T A K E O V E R', VW / 2, 256);
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillStyle = '#ffe9c9';
  ctx.fillText('Rio Vane is broke. Fixer Sol Vega has five jobs, one golden car, and a city that never says no.', VW / 2, 296);
  ctx.fillText('Steal cars, run packages, dodge the law — take Port Solano before the sun goes down.', VW / 2, 320);

  titleButtons = [];
  const sv = loadSave();
  const items = [{ label: '▶  NEW GAME', action: 'new' }];
  if (sv) items.push({ label: `▶  CONTINUE — $${sv.cash} · ${sv.storyDone ? 'story complete' : `mission ${(sv.mission ?? 0) + 1}`}`, action: 'continue' });
  items.forEach((it, i) => {
    const w = 430, h = 52, x = VW / 2 - w / 2, y = 356 + i * 66;
    ctx.fillStyle = 'rgba(20, 10, 36, 0.85)';
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.fill();
    ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, 10); ctx.stroke();
    ctx.fillStyle = '#ffe9c9';
    ctx.font = 'bold 20px system-ui, sans-serif';
    ctx.fillText(it.label, VW / 2, y + 34);
    titleButtons.push({ x, y, w, h, action: it.action });
  });
  ctx.font = '14px system-ui, sans-serif';
  ctx.fillStyle = 'rgba(255, 240, 220, 0.8)';
  ctx.fillText('WASD / arrows — move & drive · E — enter / exit car · F — punch · Shift — sprint', VW / 2, 356 + items.length * 66 + 26);
  ctx.fillText('P / Esc — pause · M — mute · Progress saves automatically', VW / 2, 356 + items.length * 66 + 48);
}

function drawPause() {
  ctx.fillStyle = 'rgba(16, 6, 26, 0.66)';
  ctx.fillRect(0, 0, VW, VH);
  ctx.textAlign = 'center';
  ctx.font = 'bold 52px system-ui, sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.fillText('PAUSED', VW / 2, 320);
  ctx.font = '17px system-ui, sans-serif';
  ctx.fillStyle = '#ffe9c9';
  ctx.fillText('Progress saved. Press P or Esc to get back to work.', VW / 2, 360);
  ctx.fillText(`Cash $${S.cash} · Earned $${S.totalEarned} · Jobs done ${S.jobsDone}`, VW / 2, 392);
}

function drawDone() {
  ctx.fillStyle = 'rgba(20, 6, 30, 0.62)';
  ctx.fillRect(0, 0, VW, VH);
  const w = 620, h = 430, x = VW / 2 - w / 2, y = 130;
  ctx.fillStyle = 'rgba(18, 8, 30, 0.92)';
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.fill();
  ctx.strokeStyle = '#ffd166'; ctx.lineWidth = 2.5;
  ctx.beginPath(); ctx.roundRect(x, y, w, h, 14); ctx.stroke();
  ctx.textAlign = 'center';
  ctx.font = 'bold 40px system-ui, sans-serif';
  ctx.fillStyle = '#ffd166';
  ctx.fillText('THE SUNSET TAKEOVER', VW / 2, y + 62);
  ctx.font = 'bold 19px system-ui, sans-serif';
  ctx.fillStyle = '#ff6b9d';
  ctx.fillText('★ STORY COMPLETE ★', VW / 2, y + 96);
  ctx.font = '16px system-ui, sans-serif';
  ctx.fillStyle = '#ffe9c9';
  const lines = [
    'Rio took the golden Comet, lost the law, and watched',
    'the sun go down on a city that now works for Sol Vega.',
    '',
    `Total earned .......... $${S.totalEarned}`,
    `Cash in pocket ........ $${S.cash}`,
    `Missions .............. 5 / 5`,
    `Jobs & errands ........ ${S.jobsDone}`,
    `Busted ................ ${S.busts}×`,
    `Wasted ................ ${S.wastedCount}×`,
    `Time in Port Solano ... ${Math.floor(S.playSecs / 60)} min`,
  ];
  lines.forEach((ln, i) => ctx.fillText(ln, VW / 2, y + 136 + i * 24));
  ctx.font = 'bold 16px system-ui, sans-serif';
  ctx.fillStyle = '#aef2c1';
  ctx.fillText(S.shot ? 'Free roam unlocked — the city stays open.' : 'Press ENTER — free roam: endless paid errands await.', VW / 2, y + h - 24);
}

function drawOverlay() {
  const o = S.overlay;
  ctx.fillStyle = o.title === 'BUSTED' ? 'rgba(20, 30, 90, 0.55)' : 'rgba(90, 10, 10, 0.55)';
  ctx.fillRect(0, 0, VW, VH);
  ctx.textAlign = 'center';
  ctx.font = 'bold 84px system-ui, sans-serif';
  ctx.fillStyle = o.title === 'BUSTED' ? '#7aa2ff' : '#ff5252';
  ctx.shadowColor = 'rgba(0,0,0,0.8)'; ctx.shadowBlur = 18;
  ctx.fillText(o.title, VW / 2, VH / 2);
  ctx.shadowBlur = 0;
  ctx.font = '18px system-ui, sans-serif';
  ctx.fillStyle = '#ffe9c9';
  ctx.fillText(o.sub, VW / 2, VH / 2 + 38);
}

// ---------------------------------------------------------------- render ---
function render(t) {
  updateCam();
  ctx.save();
  if (S.shake > 0.2) ctx.translate((rng() - 0.5) * S.shake, (rng() - 0.5) * S.shake);
  drawWorld(t);
  drawMarkers(t);
  for (const c of cars) drawCarShape(c);
  for (const p of peds) drawPed(p);
  if (!player.car) drawPlayerFigure();
  else {
    // Bust ring around the player's car when the meter climbs.
    if (S.bustMeter > 0.02) {
      ctx.strokeStyle = '#3867ff'; ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(player.x - cam.x, player.y - cam.y, 34, -Math.PI / 2, -Math.PI / 2 + S.bustMeter * TAU);
      ctx.stroke();
    }
  }
  ctx.restore();
  // Sunset vignette.
  const vg = ctx.createLinearGradient(0, 0, 0, VH);
  vg.addColorStop(0, 'rgba(255, 110, 60, 0.10)');
  vg.addColorStop(0.5, 'rgba(0,0,0,0)');
  vg.addColorStop(1, 'rgba(30, 5, 50, 0.20)');
  ctx.fillStyle = vg;
  ctx.fillRect(0, 0, VW, VH);

  if (S.mode === 'play') drawHUD();
  if (S.mode === 'title') drawTitle();
  if (S.mode === 'done') drawDone();
  if (S.paused && S.mode === 'play') drawPause();
  if (S.overlay) drawOverlay();
}

// ----------------------------------------------------------------- input ---
canvas.addEventListener('pointerdown', (e) => {
  const r = canvas.getBoundingClientRect();
  const x = (e.clientX - r.left) * (VW / r.width);
  const y = (e.clientY - r.top) * (VH / r.height);
  if (S.mode === 'title') {
    for (const b of titleButtons) {
      if (x >= b.x && x <= b.x + b.w && y >= b.y && y <= b.y + b.h) {
        audio.ensure(); audio.click();
        if (b.action === 'new') newGame(); else continueGame();
      }
    }
  }
});

// ------------------------------------------------------------------ loop ---
let last = performance.now();
function frame(now) {
  const dt = Math.min(0.033, (now - last) / 1000 || 0.016);
  last = now;
  const t = now / 1000;

  if (hit('KeyM')) { audio.ensure(); audio.setMuted(!audio.muted); notice(audio.muted ? 'Sound off' : 'Sound on'); }

  if (S.mode === 'title' && !S.shot) {
    if (hit('KeyN')) newGame();
    else if (hit('Enter') || hit('KeyC')) { if (loadSave()) continueGame(); else newGame(); }
  } else if (S.mode === 'done' && !S.shot) {
    if (hit('Enter')) {
      S.mode = 'play';
      banner('FREE ROAM', 'Errands pay cash. The city is yours.');
      if (!S.errand) makeErrand();
    }
  } else if (S.mode === 'play') {
    if (hit('KeyP') || hit('Escape')) {
      S.paused = !S.paused;
      if (S.paused) saveGame();
      audio.click();
    }
    if (!S.paused && !S.shot) update(dt);
  }
  render(t);
  pressed = {};
  requestAnimationFrame(frame);
}

// ------------------------------------------------------------------ init ---
if (SHOT) {
  stageShot(SHOT);
} else {
  player.x = L.casino.x; player.y = L.casino.y + 190;
  resetWorldEntities();
  S.mode = 'title';
}
requestAnimationFrame(frame);

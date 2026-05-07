/**
 * game.js — Jankowo Duel Game Engine
 * Canvas 2D, physics, networking, weapons
 */

// ─── CONSTANTS ────────────────────────────────────────────────
const CANVAS_W = 1280, CANVAS_H = 720;
const GROUND_Y = CANVAS_H - 80;
const GRAVITY  = 0.56;
const JUMP_F   = -13.5;
const SPEED    = 4.07;

const WEAPONS = [
  { id: 0, name: 'SOPLICA',           icon: '🍶', dmg:  5, color: '#00eefc', speed: 7.4, size: 14, ammo: Infinity, maxAge: 200 },
  { id: 1, name: 'SEX ON THE MORENA', icon: '🥂', dmg: 25, color: '#ffabf3', speed: 5.6, size: 18, ammo:  5, maxAge: 130 },
  { id: 2, name: 'JANKOWO LIBRE',     icon: '🍾', dmg: 35, color: '#abd600', speed: 4.5, size: 22, ammo:  2, maxAge:  80 },
];

const P_W = 40, P_H = 64;
const MAX_HP = 100;

// ─── STATE ────────────────────────────────────────────────────
let canvas, ctx;
let animId;
let lastFrameTime = 0;
const FRAME_MS = 1000 / 60; // lock physics to 60 fps
let gameRunning = false;
let gameEnded   = false; // guard against double-endGame
let frameCount  = 0;   // proper frame counter for sendState throttle
let countdown   = 3;
let countdownTimer;
let roundTime   = 180; // seconds
let roundInterval;

const keys = {};

// Players
function makeAmmo() { return WEAPONS.map(w => w.ammo); }
const players = [
  { x: 160, y: GROUND_Y - P_H, vx: 0, vy: 0, hp: MAX_HP, onGround: false,
    facing: 1, weaponIdx: 0, cooldown: 0, throwing: false, ammo: null, hitTimer: 0,
    name: 'Gracz 1', color: '#ffabf3', darkColor: '#c067a0', isLocal: true },
  { x: CANVAS_W - 200, y: GROUND_Y - P_H, vx: 0, vy: 0, hp: MAX_HP, onGround: false,
    facing: -1, weaponIdx: 0, cooldown: 0, throwing: false, ammo: null, hitTimer: 0,
    name: 'Gracz 2', color: '#00eefc', darkColor: '#007a8a', isLocal: false },
];
players.forEach(p => { p.ammo = makeAmmo(); });

const bottles = []; // { x, y, vx, vy, weapon, owner, age }
const particles = []; // { x, y, vx, vy, color, life, maxLife, r }

// Session data
let myPlayerNum     = 1; // 1 or 2
let isHost          = false;
let botMode         = false;
let botDecisionTimer = 0;

// ─── INIT ─────────────────────────────────────────────────────
let _controlsAttached = false;

// Called by lobby.js after WebSocket room is established (no page navigation)
window.initGame = function (playerName, playerNum, isBotMode = false) {
  myPlayerNum      = playerNum;
  botMode          = isBotMode;
  botDecisionTimer = 0;
  gameRunning = false;
  gameEnded   = false;
  frameCount  = 0;
  bottles.length    = 0;
  particles.length  = 0;
  dmgNumbers.length = 0;

  players.forEach((p, i) => {
    p.hp        = MAX_HP;
    p.weaponIdx = 0;
    p.cooldown  = 0;
    p.throwing  = false;
    p.hitTimer  = 0;
    p.ammo      = makeAmmo();
    p.x = i === 0 ? 160 : CANVAS_W - 200;
    p.y = GROUND_Y - P_H;
    p.vx = p.vy = 0;
    p.targetX = p.x;
    p.targetY = p.y;
    p.isLocal = (i === playerNum - 1);
  });
  players[playerNum - 1].name = playerName;
  if (botMode) players[1].name = '🤖 BOT';

  // One-time DOM/event setup (survives across rematches and back-to-lobby)
  if (!_controlsAttached) {
    canvas = document.getElementById('game-canvas');
    ctx    = canvas.getContext('2d');
    window.addEventListener('resize', resizeCanvas);
    setupControls();
    document.getElementById('btn-rematch').addEventListener('click', restartGame);
    document.getElementById('btn-back-lobby').addEventListener('click', backToLobby);
    _controlsAttached = true;
  }

  resizeCanvas();
  if (!botMode) setupNetwork();
  updateHUD();
  drawBackground();
  document.getElementById('overlay-gameover').classList.add('hidden');
  startCountdown();
};

function backToLobby() {
  Network.destroy();
  gameRunning = false;
  cancelAnimationFrame(animId);
  clearInterval(roundInterval);
  clearInterval(countdownTimer);
  document.getElementById('overlay-gameover').classList.add('hidden');
  document.getElementById('overlay-countdown').classList.add('hidden');
  document.getElementById('game-section').style.display  = 'none';
  document.getElementById('lobby-section').style.display = 'block';
  document.body.className = 'lobby-page';
  // Re-enable lobby UI
  document.getElementById('lobby-actions').classList.remove('hidden');
  document.getElementById('waiting-state').classList.add('hidden');
  document.getElementById('status-message').classList.add('hidden');
  document.getElementById('btn-create-room').disabled = false;
  document.getElementById('btn-join-room').disabled   = false;
}

function resizeCanvas() {
  canvas.width  = window.innerWidth;
  canvas.height = window.innerHeight;
}

// ─── CONTROLS ─────────────────────────────────────────────────
function setupControls() {
  window.addEventListener('keydown', e => { keys[e.code] = true;  handleKeyDown(e); });
  window.addEventListener('keyup',   e => { keys[e.code] = false; });
}

function handleKeyDown(e) {
  if (!gameRunning) return;
  const me   = players[myPlayerNum - 1];
  const pIdx = myPlayerNum - 1;

  // Wszyscy gracze używają tych samych klawiszy (grają na osobnych maszynach)
  if (e.code === 'KeyQ') switchWeapon(me, -1);
  if (e.code === 'KeyE') switchWeapon(me,  1);
  if (e.code === 'KeyF') tryThrow(me, pIdx);

  // Prevent scroll
  if (['ArrowUp','ArrowDown','ArrowLeft','ArrowRight','Space'].includes(e.code)) {
    e.preventDefault();
  }
}

function switchWeapon(player, dir) {
  player.weaponIdx = (player.weaponIdx + dir + WEAPONS.length) % WEAPONS.length;
  updateWeaponHUD(players.indexOf(player));
  sendState();
}

function tryThrow(player, pIdx) {
  if (player.cooldown > 0) return;
  const w = WEAPONS[player.weaponIdx];
  // Sprawdź ammo
  if (player.ammo[player.weaponIdx] <= 0) {
    // Brak amunicji — spróbuj automatycznie zmienić broń
    const alt = player.ammo.findIndex((a) => a > 0);
    if (alt === -1) return; // wszystkie puste
    switchWeapon(player, alt - player.weaponIdx);
    return;
  }
  player.ammo[player.weaponIdx]--;

  const dir = player.facing;
  const bx  = player.x + (dir > 0 ? P_W : 0);
  const by  = player.y + P_H * 0.3;
  spawnBottle(bx, by, dir * w.speed, -5, w, pIdx);

  player.cooldown = 40;
  player.throwing = true;
  setTimeout(() => { player.throwing = false; }, 300);

  Network.send({ t: 'throw', bx, by, vx: dir * w.speed, vy: -5, wId: w.id, owner: pIdx });
  sendState();
}

function spawnBottle(bx, by, vx, vy, w, owner) {
  bottles.push({ x: bx, y: by, vx, vy, weapon: w, owner, age: 0 });
}

// ─── NETWORK ──────────────────────────────────────────────────
function setupNetwork() {
  Network.onState(handleRemoteState);
  Network.onDisconnected(() => {
    showStatus('Przeciwnik się rozłączył!', 'error');
  });
}

function sendState() {
  const me = players[myPlayerNum - 1];
  Network.send({
    t: 's',
    x: me.x, y: me.y, vx: me.vx, vy: me.vy,
    hp: me.hp, facing: me.facing,
    weaponIdx: me.weaponIdx,
    throwing: me.throwing,
    ammo: me.ammo,
    name: me.name,
  });
}

function handleRemoteState(data) {
  if (data.t === 'throw') {
    const remoteOwner = 2 - myPlayerNum;
    const b = { x: data.bx, y: data.by, vx: data.vx, vy: data.vy, weapon: WEAPONS[data.wId], owner: remoteOwner, age: 0 };
    // Fixed 3-frame advance (~50ms typical latency) — clock-based offsets caused
    // bottles to teleport past players when client clocks drifted, killing hit detection
    for (let f = 0; f < 3; f++) {
      b.x += b.vx; b.y += b.vy; b.vy += GRAVITY * 0.5; b.age++;
    }
    bottles.push(b);
    return;
  }
  // Dedicated HP event — sent immediately on hit for fast sync
  if (data.t === 'hp') {
    const remIdx = 2 - myPlayerNum;
    players[remIdx].hp = data.hp;
    updateHUD();
    // Show hit effects on observer's screen too
    spawnHitExplosion(players[remIdx]);
    if (data.hp <= 0) endGame(myPlayerNum - 1); // remote player died
    return;
  }
  if (data.t !== 's') return;

  const remIdx = 2 - myPlayerNum;
  const them   = players[remIdx];
  them.targetX = data.x; them.targetY = data.y;
  them.vx = data.vx; them.vy = data.vy;
  them.facing    = data.facing;
  them.weaponIdx = data.weaponIdx;
  them.throwing  = data.throwing;
  if (data.ammo !== undefined) them.ammo = data.ammo;
  if (data.hp   !== undefined) them.hp   = data.hp;
  if (data.name)               them.name = data.name;

  updateHUD();
  updateWeaponHUD(remIdx);
}

// ─── GAME LOOP ────────────────────────────────────────────────
function startCountdown() {
  const overlay = document.getElementById('overlay-countdown');
  const numEl   = document.getElementById('countdown-number');
  overlay.classList.remove('hidden');
  countdown = 3;
  numEl.textContent = countdown;

  countdownTimer = setInterval(() => {
    countdown--;
    if (countdown <= 0) {
      clearInterval(countdownTimer);
      numEl.textContent = 'GO!';
      setTimeout(() => { overlay.classList.add('hidden'); startGame(); }, 600);
    } else {
      numEl.textContent = countdown;
    }
  }, 1000);
}

function startGame() {
  gameRunning    = true;
  roundTime      = 180;
  lastFrameTime  = 0;
  roundInterval  = setInterval(tickTimer, 1000);
  loop(0);
}

function tickTimer() {
  roundTime--;
  const m = Math.floor(roundTime / 60);
  const s = roundTime % 60;
  document.getElementById('round-timer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
  if (roundTime <= 0) endGame(-1); // draw
}

function loop(timestamp) {
  if (!gameRunning) return;
  animId = requestAnimationFrame(loop);
  if (timestamp - lastFrameTime < FRAME_MS) return; // skip if < 16.67ms elapsed
  lastFrameTime = timestamp;
  update();
  render();
}

// ─── UPDATE ───────────────────────────────────────────────────
function update() {
  const me = players[myPlayerNum - 1];

  // Input dla lokalnego gracza — te same klawisze dla wszystkich
  if      (keys['KeyA'] || keys['ArrowLeft'])  { me.vx = -SPEED; me.facing = -1; }
  else if (keys['KeyD'] || keys['ArrowRight']) { me.vx =  SPEED; me.facing =  1; }
  else me.vx = 0;
  if ((keys['KeyW'] || keys['ArrowUp'] || keys['Space']) && me.onGround) { me.vy = JUMP_F; me.onGround = false; }

  // Physics for local player
  applyPhysics(me);

  // Cooldown
  if (me.cooldown > 0) me.cooldown--;

  // Bottles
  for (let i = bottles.length - 1; i >= 0; i--) {
    const b = bottles[i];
    b.x += b.vx;
    b.y += b.vy;
    b.vy += GRAVITY * 0.5;
    b.age++;

    // Ground collision
    if (b.y > GROUND_Y - 10) { spawnBottleParticles(b); bottles.splice(i, 1); continue; }

    // Out of bounds
    if (b.x < -50 || b.x > CANVAS_W + 50) { bottles.splice(i, 1); continue; }

    // Max age (zasięg zależny od broni)
    if (b.age > b.weapon.maxAge) { spawnBottleParticles(b); bottles.splice(i, 1); continue; }

    // Hit detection: each client checks if enemy bottles hit their own player
    const isEnemyBottle = (b.owner !== myPlayerNum - 1);
    const mySelf        = players[myPlayerNum - 1];
    if (isEnemyBottle && hitTest(b, mySelf)) {
      applyDamage(mySelf, b.weapon.dmg, b.weapon.color);
      spawnBottleParticles(b);
      bottles.splice(i, 1);
      continue;
    }

    // In bot mode: also check if player's bottles hit the bot (player 2)
    if (botMode && b.owner === 0 && hitTest(b, players[1])) {
      applyDamage(players[1], b.weapon.dmg, b.weapon.color);
      spawnBottleParticles(b);
      bottles.splice(i, 1);
      continue;
    }
  }

  // Smooth remote player position with lerp (fixes stutter between packets)
  if (!botMode) {
    const remIdx = myPlayerNum === 1 ? 1 : 0;
    const rem = players[remIdx];
    if (rem.targetX !== undefined) {
      rem.x += (rem.targetX - rem.x) * 0.35;
      rem.y += (rem.targetY - rem.y) * 0.35;
    }
  }

  // Bot AI
  if (botMode) updateBot();

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vy += 0.15;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }

  // Hit timers
  players.forEach(p => { if (p.hitTimer > 0) p.hitTimer--; });

  // Send state every 2 frames (~30/s at 60fps) for smoother sync
  frameCount++;
  if (!botMode && frameCount % 2 === 0) sendState();
}

// ─── BOT AI ───────────────────────────────────────────────────
function updateBot() {
  const bot    = players[1];
  const target = players[0];
  if (bot.hp <= 0 || target.hp <= 0) return;

  const dx    = target.x - bot.x;
  const absDx = Math.abs(dx);
  const FIGHT_DIST = 200;

  // Face target
  bot.facing = dx >= 0 ? 1 : -1;

  // Movement: close in or back off to maintain fight distance
  if (absDx > FIGHT_DIST + 40) {
    bot.vx = (dx > 0 ? 1 : -1) * SPEED * 0.88;
  } else if (absDx < FIGHT_DIST - 40) {
    bot.vx = (dx > 0 ? -1 : 1) * SPEED * 0.7;
  } else {
    bot.vx = 0;
  }

  // Random jump: dodge or chase
  if (bot.onGround && Math.random() < 0.009) {
    bot.vy = JUMP_F;
    bot.onGround = false;
  }

  // Weapon selection: prefer highest-dmg weapon that still has ammo
  for (let i = WEAPONS.length - 1; i >= 0; i--) {
    if (bot.ammo[i] > 0) { bot.weaponIdx = i; break; }
  }

  // Throw when in range and both timers allow it
  botDecisionTimer--;
  if (bot.cooldown <= 0 && botDecisionTimer <= 0 && absDx < 520 && bot.ammo[bot.weaponIdx] > 0) {
    const w   = WEAPONS[bot.weaponIdx];
    const dir = bot.facing;
    // Slight vertical arc — aim higher when target is far away
    const aimVy = absDx > 320 ? -7 : -4;
    bot.ammo[bot.weaponIdx]--;  // Infinity - 1 === Infinity, so Soplica is safe
    spawnBottle(bot.x + (dir > 0 ? P_W : 0), bot.y + P_H * 0.3, dir * w.speed, aimVy, w, 1);
    bot.cooldown      = 38 + Math.floor(Math.random() * 28);
    bot.throwing      = true;
    botDecisionTimer  = 18 + Math.floor(Math.random() * 35);
    setTimeout(() => { bot.throwing = false; }, 300);
  }

  // Physics
  applyPhysics(bot);
  if (bot.cooldown > 0) bot.cooldown--;
}

function isLocalPlayer(p) { return p.isLocal; }

function applyPhysics(p) {
  p.vy += GRAVITY;
  p.x  += p.vx;
  p.y  += p.vy;

  if (p.y + P_H >= GROUND_Y) {
    p.y = GROUND_Y - P_H;
    p.vy = 0;
    p.onGround = true;
  } else {
    p.onGround = false;
  }

  // Walls
  if (p.x < 10) p.x = 10;
  if (p.x + P_W > CANVAS_W - 10) p.x = CANVAS_W - P_W - 10;
}

function hitTest(b, target) {
  return b.x > target.x - 20 && b.x < target.x + P_W + 20 &&
         b.y > target.y - 12 && b.y < target.y + P_H + 12;
}

function applyDamage(player, dmg, color) {
  player.hp = Math.max(0, player.hp - dmg);
  updateHUD();
  flashDamage(color);
  spawnDmgNumber(player.x + P_W / 2, player.y, dmg, color);
  spawnHitExplosion(player);
  Network.send({ t: 'hp', hp: player.hp });
  if (player.hp <= 0) {
    endGame(players.indexOf(player) === 0 ? 1 : 0);
  }
}

function endGame(winnerIdx) {
  if (gameEnded) return;  // prevent double-trigger
  gameEnded   = true;
  gameRunning = false;
  clearInterval(roundInterval);
  cancelAnimationFrame(animId);

  const overlay = document.getElementById('overlay-gameover');
  const title   = document.getElementById('gameover-title');
  const winner  = document.getElementById('gameover-winner');

  if (winnerIdx === -1) {
    title.textContent = 'REMIS!';
    winner.textContent = '🤝';
  } else {
    title.textContent = 'WYGRYWA!';
    winner.textContent = players[winnerIdx].name;
    winner.style.color = players[winnerIdx].color;
    winner.style.textShadow = `0 0 30px ${players[winnerIdx].color}`;
  }
  overlay.classList.remove('hidden');
}

function restartGame() {
  document.getElementById('overlay-gameover').classList.add('hidden');
  players.forEach((p, i) => {
    p.hp = MAX_HP; p.weaponIdx = 0; p.cooldown = 0; p.throwing = false; p.hitTimer = 0;
    p.ammo = makeAmmo();
    p.x = i === 0 ? 160 : CANVAS_W - 200;
    p.y = GROUND_Y - P_H;
    p.vx = 0; p.vy = 0;
    p.targetX = p.x; p.targetY = p.y;
  });
  gameEnded        = false;
  frameCount       = 0;
  botDecisionTimer = 0;
  bottles.length = 0; particles.length = 0;
  updateHUD();
  startCountdown();
}

// ─── RENDER ───────────────────────────────────────────────────
function render() {
  const cw = canvas.width, ch = canvas.height;
  const scaleX = cw / CANVAS_W, scaleY = ch / CANVAS_H;
  const scale  = Math.min(scaleX, scaleY);
  const offX   = (cw - CANVAS_W * scale) / 2;
  const offY   = (ch - CANVAS_H * scale) / 2;

  ctx.save();
  ctx.clearRect(0, 0, cw, ch);
  ctx.translate(offX, offY);
  ctx.scale(scale, scale);

  drawBackground();
  drawBottles();
  drawPlayers();
  drawParticles();
  drawDmgNumbers();

  ctx.restore();
}

function initBgData() {
  const cw = CANVAS_W, ch = CANVAS_H;
  const WC = ['#ff5cdb99','#00eefc99','#b3f00099','#ffab0099','#a855f799'];

  const stars = Array.from({ length: 140 }, () => ({
    x: Math.random() * cw, y: Math.random() * ch * 0.62,
    r: Math.random() * 1.8 + 0.3, a: 0.3 + Math.random() * 0.7,
    phase: Math.random() * Math.PI * 2, warm: Math.random() > 0.82,
  }));

  const farBuildings = [];
  for (let fx = -10; fx < cw + 20;) {
    const fw = 28 + Math.random() * 55, fh = 80 + Math.random() * 180;
    farBuildings.push({ x: fx, y: GROUND_Y - fh, w: fw, h: fh });
    fx += fw + 1 + Math.random() * 10;
  }

  const defs = [
    [0,195,82],[92,235,57],[158,160,108],[276,200,72],[354,140,98],
    [462,190,68],[540,165,92],[640,145,80],[728,210,90],[828,168,100],
    [938,190,74],[1022,148,106],[1138,198,84],[1232,178,80],
  ];
  const buildings = defs.map(([bx, topY, bw]) => {
    const bh = GROUND_Y - topY;
    const wins = [];
    for (let wy2 = topY + 14; wy2 < GROUND_Y - 16; wy2 += 18)
      for (let wx2 = bx + 8; wx2 < bx + bw - 10; wx2 += 13)
        if (Math.random() > 0.4)
          wins.push({ x: wx2, y: wy2, c: WC[Math.floor(Math.random() * WC.length)], on: Math.random() > 0.15 });
    return {
      x: bx, y: topY, w: bw, h: bh, wins,
      antenna: bh > 150,
      sign: Math.random() > 0.55 ? {
        ox: Math.floor(bw * 0.18), oy: Math.floor(bh * 0.25),
        sw: Math.floor(bw * 0.64), c: WC[Math.floor(Math.random() * WC.length)].slice(0, 7),
      } : null,
    };
  });
  window._bgData = { stars, farBuildings, buildings };
}

function drawBackground() {
  if (!window._bgData) initBgData();
  const { stars, farBuildings, buildings } = window._bgData;
  const cw = CANVAS_W, ch = CANVAS_H, now = Date.now();

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, GROUND_Y);
  sky.addColorStop(0, '#020008'); sky.addColorStop(0.4, '#090520'); sky.addColorStop(1, '#180e38');
  ctx.fillStyle = sky; ctx.fillRect(0, 0, cw, ch);

  // Moon
  ctx.save();
  const mx = cw * 0.83, my = 82;
  const halo = ctx.createRadialGradient(mx, my, 0, mx, my, 115);
  halo.addColorStop(0, '#bbddff20'); halo.addColorStop(0.5, '#8899ff0c'); halo.addColorStop(1, '#00000000');
  ctx.fillStyle = halo; ctx.fillRect(mx - 115, my - 115, 230, 230);
  ctx.shadowColor = '#cce4ff'; ctx.shadowBlur = 35;
  ctx.fillStyle = '#ddeeff';
  ctx.beginPath(); ctx.arc(mx, my, 40, 0, Math.PI * 2); ctx.fill();
  ctx.globalAlpha = 0.13; ctx.fillStyle = '#7799aa';
  [[mx-11, my-7, 7], [mx+14, my+11, 5], [mx-4, my+15, 5]].forEach(([cx2,cy2,r]) => {
    ctx.beginPath(); ctx.arc(cx2, cy2, r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();

  // Stars
  ctx.save();
  stars.forEach(s => {
    ctx.globalAlpha = s.a * (0.5 + 0.5 * Math.sin(now / 700 + s.phase));
    ctx.fillStyle = s.warm ? '#ffd080' : '#ffffff';
    ctx.shadowColor = s.warm ? '#ff8800' : '#aaaaff'; ctx.shadowBlur = s.r * 3;
    ctx.beginPath(); ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2); ctx.fill();
  });
  ctx.restore();

  // Far buildings (dark silhouette)
  ctx.fillStyle = '#06041c';
  farBuildings.forEach(b => ctx.fillRect(b.x, b.y, b.w, b.h));

  // Mid buildings
  buildings.forEach(b => {
    const bg2 = ctx.createLinearGradient(b.x, 0, b.x + b.w, 0);
    bg2.addColorStop(0, '#0b0921'); bg2.addColorStop(0.5, '#0f0d28'); bg2.addColorStop(1, '#0b0921');
    ctx.fillStyle = bg2; ctx.fillRect(b.x, b.y, b.w, b.h);
    ctx.fillStyle = '#ffffff09';
    ctx.fillRect(b.x, b.y, 2, b.h); ctx.fillRect(b.x + b.w - 2, b.y, 2, b.h); ctx.fillRect(b.x, b.y, b.w, 2);
    b.wins.forEach(win => {
      if (!win.on) return;
      ctx.fillStyle = win.c; ctx.shadowColor = win.c; ctx.shadowBlur = 4;
      ctx.fillRect(win.x, win.y, 8, 10);
    });
    ctx.shadowBlur = 0;
    if (b.sign) {
      const pulse = 0.65 + 0.35 * Math.sin(now / 480 + b.x * 0.01);
      ctx.globalAlpha = pulse; ctx.fillStyle = b.sign.c;
      ctx.shadowColor = b.sign.c; ctx.shadowBlur = 9 * pulse;
      ctx.fillRect(b.x + b.sign.ox, b.y + b.sign.oy, b.sign.sw, 5);
      ctx.globalAlpha = 1; ctx.shadowBlur = 0;
    }
    if (b.antenna) {
      ctx.strokeStyle = '#ffffff20'; ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(b.x + b.w / 2, b.y); ctx.lineTo(b.x + b.w / 2, b.y - 22); ctx.stroke();
      const blink = Math.sin(now / 650 + b.x) > 0;
      ctx.fillStyle = blink ? '#ff3333' : '#550000';
      ctx.shadowColor = '#ff3333'; ctx.shadowBlur = blink ? 12 : 0;
      ctx.beginPath(); ctx.arc(b.x + b.w / 2, b.y - 24, 3, 0, Math.PI * 2); ctx.fill();
      ctx.shadowBlur = 0;
    }
  });

  // Ground fog
  const fog = ctx.createLinearGradient(0, GROUND_Y - 90, 0, GROUND_Y);
  fog.addColorStop(0, '#00000000'); fog.addColorStop(1, '#130a3050');
  ctx.fillStyle = fog; ctx.fillRect(0, GROUND_Y - 90, cw, 90);

  // Ground
  const gnd = ctx.createLinearGradient(0, GROUND_Y, 0, ch);
  gnd.addColorStop(0, '#1c1245'); gnd.addColorStop(1, '#0d0820');
  ctx.fillStyle = gnd; ctx.fillRect(0, GROUND_Y, cw, ch - GROUND_Y);

  // Neon ground line
  const gl = ctx.createLinearGradient(0, GROUND_Y, cw, GROUND_Y);
  gl.addColorStop(0, '#ff5cdb'); gl.addColorStop(0.33, '#00eefc');
  gl.addColorStop(0.66, '#b3f000'); gl.addColorStop(1, '#a855f7');
  ctx.strokeStyle = gl; ctx.lineWidth = 3;
  ctx.shadowColor = '#00eefc'; ctx.shadowBlur = 20;
  ctx.beginPath(); ctx.moveTo(0, GROUND_Y); ctx.lineTo(cw, GROUND_Y); ctx.stroke();

  // Ground reflection glow
  const gr = ctx.createLinearGradient(0, GROUND_Y, 0, GROUND_Y + 55);
  gr.addColorStop(0, '#00eefc18'); gr.addColorStop(1, '#00000000');
  ctx.fillStyle = gr; ctx.fillRect(0, GROUND_Y, cw, 55);
  ctx.shadowBlur = 0;

  // Perspective grid
  ctx.lineWidth = 1;
  for (let gx = 0; gx < cw; gx += 50) {
    ctx.strokeStyle = '#ffffff07';
    ctx.beginPath(); ctx.moveTo(gx, GROUND_Y); ctx.lineTo(gx + 34, ch); ctx.stroke();
  }
  for (let row = 0; row < 5; row++) {
    ctx.globalAlpha = 0.04 * (1 - row / 5);
    ctx.beginPath(); ctx.moveTo(0, GROUND_Y + 12 + row * 16); ctx.lineTo(cw, GROUND_Y + 12 + row * 16); ctx.stroke();
  }
  ctx.globalAlpha = 1;
}

function drawPlayers() {
  players.forEach((p, idx) => {
    if (p.hp <= 0) return;
    const x = p.x, y = p.y, col = p.color, dark = p.darkColor, now = Date.now();

    ctx.save();
    if (p.facing < 0) { ctx.translate(x + P_W, y); ctx.scale(-1, 1); }
    else              { ctx.translate(x, y); }

    // Ground shadow
    ctx.globalAlpha = 0.35; ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 14;
    ctx.beginPath(); ctx.ellipse(P_W / 2, P_H + 3, 22, 5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    // Leg animation
    const moving = Math.abs(p.vx) > 0.15;
    const swing  = moving ? Math.sin(now / 88) * 10 : 0;

    // Thighs
    ctx.fillStyle = dark; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.roundRect(4,  P_H - 30, 13, 16, [4,4,0,0]); ctx.fill();
    ctx.beginPath(); ctx.roundRect(23, P_H - 30, 13, 16, [4,4,0,0]); ctx.fill();

    // Shins (animated)
    ctx.beginPath(); ctx.roundRect(5,  P_H - 15 + swing * 0.35, 11, 15 - swing * 0.35, [0,0,3,3]); ctx.fill();
    ctx.beginPath(); ctx.roundRect(24, P_H - 15 - swing * 0.35, 11, 15 + swing * 0.35, [0,0,3,3]); ctx.fill();

    // Boots
    ctx.fillStyle = '#12102a'; ctx.shadowColor = col; ctx.shadowBlur = 5;
    ctx.beginPath(); ctx.roundRect(2,  P_H - 5, 16, 7, [0,0,4,4]); ctx.fill();
    ctx.beginPath(); ctx.roundRect(22, P_H - 5, 16, 7, [0,0,4,4]); ctx.fill();
    // Boot neon trim
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.55; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.moveTo(2, P_H - 5); ctx.lineTo(18, P_H - 5); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(22, P_H - 5); ctx.lineTo(38, P_H - 5); ctx.stroke();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    // Torso
    ctx.shadowColor = col; ctx.shadowBlur = 18;
    const tg = ctx.createLinearGradient(5, P_H * 0.3, P_W - 5, P_H * 0.72);
    tg.addColorStop(0, col); tg.addColorStop(0.6, col + 'cc'); tg.addColorStop(1, dark);
    ctx.fillStyle = tg;
    ctx.beginPath(); ctx.roundRect(5, P_H * 0.3, P_W - 10, P_H * 0.42, [5,5,3,3]); ctx.fill();
    ctx.shadowBlur = 0;

    // Chest armor plate
    ctx.fillStyle = dark + 'bb';
    ctx.beginPath(); ctx.roundRect(9, P_H * 0.33, P_W - 18, P_H * 0.24, 4); ctx.fill();
    // Energy core line
    ctx.strokeStyle = col; ctx.lineWidth = 2; ctx.globalAlpha = 0.75;
    ctx.shadowColor = col; ctx.shadowBlur = 10;
    ctx.beginPath(); ctx.moveTo(11, P_H * 0.44); ctx.lineTo(P_W - 11, P_H * 0.44); ctx.stroke();
    ctx.globalAlpha = 1; ctx.shadowBlur = 0;

    // Shoulder pads
    ctx.fillStyle = col + 'cc'; ctx.shadowColor = col; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.roundRect(0, P_H * 0.29, 8, 12, 2); ctx.fill();
    ctx.beginPath(); ctx.roundRect(P_W - 8, P_H * 0.29, 8, 12, 2); ctx.fill();

    // Belt
    ctx.fillStyle = '#ffffff20'; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.roundRect(5, P_H * 0.7, P_W - 10, 5, 2); ctx.fill();
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 6;
    ctx.beginPath(); ctx.roundRect(P_W / 2 - 4, P_H * 0.69, 8, 7, 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Neck
    ctx.fillStyle = col;
    ctx.beginPath(); ctx.roundRect(P_W / 2 - 5, P_H * 0.22, 10, P_H * 0.1, 2); ctx.fill();

    // Helmet
    ctx.shadowColor = col; ctx.shadowBlur = 22;
    const hg = ctx.createRadialGradient(P_W / 2 - 5, P_H * 0.12, 1, P_W / 2, P_H * 0.18, P_H * 0.23);
    hg.addColorStop(0, '#ffffff44'); hg.addColorStop(0.35, col); hg.addColorStop(1, dark);
    ctx.fillStyle = hg;
    ctx.beginPath(); ctx.arc(P_W / 2, P_H * 0.18, P_H * 0.23, 0, Math.PI * 2); ctx.fill();
    ctx.shadowBlur = 0;

    // Helmet ridge
    ctx.fillStyle = dark;
    ctx.beginPath(); ctx.roundRect(P_W / 2 - 6, -2, 12, P_H * 0.1, [3,3,0,0]); ctx.fill();

    // Visor
    ctx.fillStyle = '#000814';
    ctx.beginPath(); ctx.roundRect(P_W * 0.35, P_H * 0.1, P_W * 0.42, P_H * 0.11, [1,5,5,1]); ctx.fill();
    ctx.strokeStyle = col; ctx.lineWidth = 1.5; ctx.globalAlpha = 0.85;
    ctx.shadowColor = col; ctx.shadowBlur = 8;
    ctx.beginPath(); ctx.roundRect(P_W * 0.35, P_H * 0.1, P_W * 0.42, P_H * 0.11, [1,5,5,1]); ctx.stroke();
    // Visor scan reflection
    ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 1; ctx.globalAlpha = 0.25; ctx.shadowBlur = 0;
    ctx.beginPath(); ctx.moveTo(P_W * 0.37, P_H * 0.145); ctx.lineTo(P_W * 0.74, P_H * 0.145); ctx.stroke();
    ctx.globalAlpha = 1;

    // Arm
    const armY = p.throwing ? P_H * 0.35 - 8 : P_H * 0.38;
    ctx.fillStyle = col; ctx.shadowColor = col; ctx.shadowBlur = 9;
    ctx.beginPath(); ctx.roundRect(P_W - 5, armY, 15, 11, [2,4,4,2]); ctx.fill();
    ctx.shadowBlur = 0;

    // Weapon icon
    ctx.font = '20px serif'; ctx.globalAlpha = p.throwing ? 0.65 : 1;
    ctx.fillText(WEAPONS[p.weaponIdx].icon, P_W - 4, armY - 1);
    ctx.globalAlpha = 1;

    // Name tag
    ctx.shadowColor = col; ctx.shadowBlur = 10; ctx.fillStyle = col;
    ctx.font = 'bold 10px "Spline Sans", sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(p.name || `P${idx + 1}`, P_W / 2, -11);
    ctx.textAlign = 'left'; ctx.shadowBlur = 0;

    ctx.restore();

    // Hit ring — world space, after restore
    if (p.hitTimer > 0) {
      const cx = x + P_W / 2, cy = y + P_H / 2;
      const progress = 1 - p.hitTimer / 22;
      const radius = P_W * 0.5 + progress * P_H * 2.2;
      const alpha = p.hitTimer / 22;
      ctx.save();
      ctx.globalAlpha = alpha; ctx.shadowColor = col; ctx.shadowBlur = 28;
      ctx.strokeStyle = '#ffffff'; ctx.lineWidth = 4;
      ctx.beginPath(); ctx.arc(cx, cy, radius, 0, Math.PI * 2); ctx.stroke();
      ctx.globalAlpha = alpha * 0.5; ctx.strokeStyle = col; ctx.lineWidth = 8;
      ctx.beginPath(); ctx.arc(cx, cy, radius * 0.6, 0, Math.PI * 2); ctx.stroke();
      ctx.restore();
    }
  });
}

function drawBottles() {
  bottles.forEach(b => {
    const w = b.weapon;
    const angle = Math.atan2(b.vy, b.vx) + Math.PI / 4;

    ctx.save();
    ctx.translate(b.x, b.y);
    ctx.rotate(angle + (b.age * 0.15));

    // Glow
    ctx.shadowColor = w.color;
    ctx.shadowBlur  = 16;

    // Bottle trail
    ctx.globalAlpha = 0.3;
    ctx.fillStyle = w.color;
    ctx.beginPath();
    ctx.ellipse(-b.vx * 1.5, -b.vy * 1.5, w.size * 0.5, w.size * 0.3, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Bottle shape
    ctx.fillStyle = w.color;
    ctx.beginPath();
    ctx.roundRect(-w.size / 2, -w.size, w.size, w.size * 2, w.size * 0.3);
    ctx.fill();

    // Bottle neck
    ctx.fillStyle = w.color + 'aa';
    ctx.fillRect(-w.size * 0.2, -w.size * 1.5, w.size * 0.4, w.size * 0.6);

    ctx.shadowBlur = 0;
    ctx.restore();
  });
}

// ─── PARTICLES ────────────────────────────────────────────────
function spawnHitExplosion(player) {
  const cx    = player.x + P_W / 2;
  const cy    = player.y + P_H / 2;
  const col   = player.color;
  const WHITE = '#ffffff';

  // Main burst ring
  for (let i = 0; i < 36; i++) {
    const angle = (i / 36) * Math.PI * 2 + Math.random() * 0.25;
    const spd   = 4 + Math.random() * 10;
    particles.push({
      x: cx, y: cy,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - 4,
      color: i % 3 === 0 ? WHITE : col,
      life: 40 + Math.random() * 30,
      maxLife: 70,
      r: 3 + Math.random() * 6,
    });
  }
  // Upward sparks
  for (let i = 0; i < 12; i++) {
    particles.push({
      x: cx + (Math.random() - 0.5) * P_W * 1.2,
      y: cy,
      vx: (Math.random() - 0.5) * 6,
      vy: -(6 + Math.random() * 10),
      color: i % 2 === 0 ? col : WHITE,
      life: 35 + Math.random() * 25,
      maxLife: 60,
      r: 2 + Math.random() * 4,
    });
  }
  player.hitTimer = 22;
}

function spawnBottleParticles(b) {
  const w = b.weapon;
  for (let i = 0; i < 16; i++) {
    const angle = Math.random() * Math.PI * 2;
    const spd   = Math.random() * 5 + 2;
    particles.push({
      x: b.x, y: b.y,
      vx: Math.cos(angle) * spd,
      vy: Math.sin(angle) * spd - 3,
      color: w.color,
      life: 40 + Math.random() * 20,
      maxLife: 60,
      r: Math.random() * 4 + 2,
    });
  }
}

function drawParticles() {
  particles.forEach(p => {
    const alpha = p.life / p.maxLife;
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = p.color;
    ctx.shadowColor = p.color;
    ctx.shadowBlur  = 8;
    ctx.beginPath();
    ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;
  ctx.shadowBlur  = 0;
}

// ─── DMG NUMBERS ──────────────────────────────────────────────
const dmgNumbers = [];

function spawnDmgNumber(x, y, dmg, color) {
  dmgNumbers.push({ x, y, vy: -2, text: `-${dmg}`, color, life: 60 });
}

function drawDmgNumbers() {
  for (let i = dmgNumbers.length - 1; i >= 0; i--) {
    const d = dmgNumbers[i];
    d.y  += d.vy;
    d.vy *= 0.95;
    d.life--;
    const alpha = d.life / 60;
    ctx.save();
    ctx.globalAlpha = alpha;
    ctx.fillStyle   = d.color;
    ctx.shadowColor = d.color;
    ctx.shadowBlur  = 14;
    ctx.font        = 'bold 28px "Spline Sans", sans-serif';
    ctx.textAlign   = 'center';
    ctx.fillText(d.text, d.x, d.y);
    ctx.restore();
    if (d.life <= 0) dmgNumbers.splice(i, 1);
  }
}

// ─── HUD UPDATES ──────────────────────────────────────────────
function updateHUD() {
  // Player names
  document.getElementById('hud-p1-name').textContent = players[0].name;
  document.getElementById('hud-p2-name').textContent = players[1].name;

  // HP
  [0, 1].forEach(i => {
    const pct = Math.max(0, players[i].hp / MAX_HP * 100);
    document.getElementById(`hp-p${i+1}-fill`).style.width = pct + '%';
    document.getElementById(`hp-p${i+1}-value`).textContent = players[i].hp;
  });

  [0, 1].forEach(i => updateWeaponHUD(i));
}

function updateWeaponHUD(pIdx) {
  const p = players[pIdx];
  const w = WEAPONS[p.weaponIdx];
  const n = pIdx + 1;
  const ammoLeft = p.ammo ? p.ammo[p.weaponIdx] : w.ammo;
  const ammoStr  = ammoLeft === Infinity ? '∞' : ammoLeft;
  document.getElementById(`weapon-p${n}-icon`).textContent = w.icon;
  document.getElementById(`weapon-p${n}-name`).textContent = w.name;
  document.getElementById(`weapon-p${n}-dmg`).textContent  = `-${w.dmg} ×${ammoStr}`;
}

function flashDamage(color) {
  const el = document.getElementById('damage-flash');
  el.className = 'damage-flash';
  el.classList.add(color === '#ffabf3' ? 'flash-magenta' : 'flash-cyan');
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 300);
}

function showStatus(msg, type) {
  // Simple console fallback
  console.warn(`[${type}] ${msg}`);
}

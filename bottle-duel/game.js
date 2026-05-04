/**
 * game.js — Party Duel Game Engine
 * Canvas 2D, physics, networking, weapons
 */

// ─── CONSTANTS ────────────────────────────────────────────────
const CANVAS_W = 1280, CANVAS_H = 720;
const GROUND_Y = CANVAS_H - 80;
const GRAVITY  = 0.6;
const JUMP_F   = -14;
const SPEED    = 4.5;

const WEAPONS = [
  // ammo: ile rzutów w rundzie; maxAge: jak daleko doleci (w klatkach)
  { id: 0, name: 'SOPLICA',           icon: '🍶', dmg: 15, color: '#00eefc', speed: 9,   size: 14, ammo: 10, maxAge: 200 },
  { id: 1, name: 'SEX ON THE MORENA', icon: '🥂', dmg: 25, color: '#ffabf3', speed: 7,   size: 18, ammo:  5, maxAge: 130 },
  { id: 2, name: 'JANKOWO LIBRE',     icon: '🍾', dmg: 35, color: '#abd600', speed: 5.5, size: 22, ammo:  2, maxAge:  80 },
];

const P_W = 40, P_H = 64;
const MAX_HP = 100;

// ─── STATE ────────────────────────────────────────────────────
let canvas, ctx;
let animId;
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
    facing: 1, weaponIdx: 0, cooldown: 0, throwing: false, ammo: null,
    name: 'Gracz 1', color: '#ffabf3', darkColor: '#c067a0', isLocal: true },
  { x: CANVAS_W - 200, y: GROUND_Y - P_H, vx: 0, vy: 0, hp: MAX_HP, onGround: false,
    facing: -1, weaponIdx: 0, cooldown: 0, throwing: false, ammo: null,
    name: 'Gracz 2', color: '#00eefc', darkColor: '#007a8a', isLocal: false },
];
players.forEach(p => { p.ammo = makeAmmo(); });

const bottles = []; // { x, y, vx, vy, weapon, owner, age }
const particles = []; // { x, y, vx, vy, color, life, maxLife, r }

// Session data
let myPlayerNum = 1; // 1 or 2
let isHost      = false;

// ─── INIT ─────────────────────────────────────────────────────
window.addEventListener('load', init);

function init() {
  canvas = document.getElementById('game-canvas');
  ctx    = canvas.getContext('2d');

  resizeCanvas();
  window.addEventListener('resize', resizeCanvas);

  // Session info
  myPlayerNum = parseInt(sessionStorage.getItem('playerNum') || '1');
  isHost      = sessionStorage.getItem('isHost') === 'true';
  players[0].name = sessionStorage.getItem('playerName') || 'Gracz 1';

  // Assign local control
  players[myPlayerNum - 1].isLocal = true;
  players[2 - myPlayerNum].isLocal = false;

  updateHUD();
  setupControls();
  setupNetwork();
  drawBackground(); // static background

  // Rematch / lobby buttons
  document.getElementById('btn-rematch').addEventListener('click', restartGame);
  document.getElementById('btn-back-lobby').addEventListener('click', () => { Network.destroy(); window.location.href = 'index.html'; });

  startCountdown();
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
    const alt = player.ammo.findIndex((a, i) => a > 0);
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

  // Wyślij event rzutu (zamiast synca pozycji butelek)
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
    // Stwórz butelkę z eventu rzutu
    const remoteOwner = 2 - myPlayerNum; // indeks przeciwnika (0-based)
    spawnBottle(data.bx, data.by, data.vx, data.vy, WEAPONS[data.wId], remoteOwner);
    return;
  }
  if (data.t !== 's') return;

  const remIdx = 2 - myPlayerNum; // 0-based index against
  const them   = players[remIdx];
  them.x = data.x; them.y = data.y;
  them.vx = data.vx; them.vy = data.vy;
  them.facing = data.facing;
  them.weaponIdx = data.weaponIdx;
  them.throwing  = data.throwing;
  if (data.ammo)  them.ammo = data.ammo;
  if (data.name)  them.name = data.name;

  // ── CRITICAL FIX: sync HP from remote so health bar updates ──
  if (typeof data.hp === 'number' && data.hp !== them.hp) {
    them.hp = data.hp;
    updateHUD();
    if (them.hp <= 0) {
      endGame(myPlayerNum - 1); // remote player died → local player wins
    }
  } else {
    updateHUD();
  }

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
  gameRunning = true;
  roundTime   = 180;
  roundInterval = setInterval(tickTimer, 1000);
  loop();
}

function tickTimer() {
  roundTime--;
  const m = Math.floor(roundTime / 60);
  const s = roundTime % 60;
  document.getElementById('round-timer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
  if (roundTime <= 0) endGame(-1); // draw
}

function loop() {
  if (!gameRunning) return;
  animId = requestAnimationFrame(loop);
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

    // Detekcja trafienia: każdy sprawdza, czy butelka PRZECIWNIKA trafia w NIEGO
    // owner to 0-based index, myPlayerNum-1 to 0-based local
    const isEnemyBottle = (b.owner !== myPlayerNum - 1);
    const mySelf        = players[myPlayerNum - 1];
    if (isEnemyBottle && hitTest(b, mySelf)) {
      applyDamage(mySelf, b.weapon.dmg, b.weapon.color);
      spawnBottleParticles(b);
      bottles.splice(i, 1);
      continue;
    }
  }

  // Particles
  for (let i = particles.length - 1; i >= 0; i--) {
    const p = particles[i];
    p.x += p.vx; p.y += p.vy;
    p.vy += 0.15;
    p.life--;
    if (p.life <= 0) particles.splice(i, 1);
  }

  // Send state every 3 frames (frameCount is a real counter, animId is NOT)
  frameCount++;
  if (frameCount % 3 === 0) sendState();
}

function isLocalPlayer(p) { return p.isLocal; }

function applyPhysics(p) {
  p.vy += GRAVITY;
  p.x  += p.vx;
  p.y  += p.vy;

  // Ground
  const scale = canvas.height / CANVAS_H;
  const gY = GROUND_Y * scale;
  const scaledGround = gY / scale;

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
  return b.x > target.x - 10 && b.x < target.x + P_W + 10 &&
         b.y > target.y - 10 && b.y < target.y + P_H + 10;
}

function applyDamage(player, dmg, color) {
  player.hp = Math.max(0, player.hp - dmg);
  updateHUD();
  flashDamage(color);
  spawnDmgNumber(player.x + P_W / 2, player.y, dmg, color);
  if (player.hp <= 0) {
    endGame(players.indexOf(player) === 0 ? 1 : 0); // other player wins
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
    p.hp = MAX_HP; p.weaponIdx = 0; p.cooldown = 0; p.throwing = false;
    p.ammo = makeAmmo();
    p.x = i === 0 ? 160 : CANVAS_W - 200;
    p.y = GROUND_Y - P_H;
    p.vx = 0; p.vy = 0;
  });
  gameEnded   = false;
  frameCount  = 0;
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

function drawBackground() {
  const cw = CANVAS_W, ch = CANVAS_H;

  // Sky
  const sky = ctx.createLinearGradient(0, 0, 0, ch);
  sky.addColorStop(0, '#0d0b1a');
  sky.addColorStop(1, '#1a1040');
  ctx.fillStyle = sky;
  ctx.fillRect(0, 0, cw, ch);

  // Stars
  if (!window._stars) {
    window._stars = [];
    for (let i = 0; i < 80; i++) {
      window._stars.push({ x: Math.random() * cw, y: Math.random() * ch * 0.7, r: Math.random() * 1.5 + 0.5, a: Math.random() });
    }
  }
  window._stars.forEach(s => {
    ctx.globalAlpha = s.a * (0.5 + 0.5 * Math.sin(Date.now() / 1000 + s.x));
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(s.x, s.y, s.r, 0, Math.PI * 2);
    ctx.fill();
  });
  ctx.globalAlpha = 1;

  // Cityscape silhouette
  ctx.fillStyle = '#0f0c24';
  const buildings = [
    [0,200,80,300],[90,240,60,260],[160,180,100,320],[270,220,70,280],
    [350,160,90,340],[450,210,60,290],[520,190,80,310],[610,170,70,330],
    [690,230,80,270],[780,190,90,310],[880,210,70,290],[960,170,100,330],
    [1070,220,80,280],[1160,200,70,300],[1240,180,40,320],
  ];
  buildings.forEach(([x,y,w,h]) => {
    ctx.fillRect(x, y, w, h);
    // windows
    ctx.fillStyle = Math.random() > 0.7 ? '#ffe94a44' : '#00eefc22';
    for (let wy = y + 10; wy < y + h - 10; wy += 20) {
      for (let wx = x + 8; wx < x + w - 8; wx += 14) {
        if (Math.random() > 0.5) ctx.fillRect(wx, wy, 7, 10);
      }
    }
    ctx.fillStyle = '#0f0c24';
  });

  // Neon ground platform
  const gY = GROUND_Y;
  ctx.fillStyle = '#1a1040';
  ctx.fillRect(0, gY, cw, ch - gY);

  // Ground neon line
  const gGrad = ctx.createLinearGradient(0, gY, cw, gY);
  gGrad.addColorStop(0,   '#ffabf3');
  gGrad.addColorStop(0.5, '#00eefc');
  gGrad.addColorStop(1,   '#abd600');
  ctx.strokeStyle = gGrad;
  ctx.lineWidth = 3;
  ctx.shadowColor = '#00eefc';
  ctx.shadowBlur  = 15;
  ctx.beginPath();
  ctx.moveTo(0, gY); ctx.lineTo(cw, gY);
  ctx.stroke();
  ctx.shadowBlur = 0;

  // Grid lines on ground
  ctx.strokeStyle = '#ffffff0a';
  ctx.lineWidth = 1;
  for (let gx = 0; gx < cw; gx += 60) {
    ctx.beginPath();
    ctx.moveTo(gx, gY); ctx.lineTo(gx + 40, ch);
    ctx.stroke();
  }
}

function drawPlayers() {
  players.forEach((p, idx) => {
    if (p.hp <= 0) return;
    const x = p.x, y = p.y;
    const facing = p.facing;
    const col = p.color;

    ctx.save();
    // Flip sprite based on facing
    if (facing < 0) {
      ctx.translate(x + P_W, y);
      ctx.scale(-1, 1);
    } else {
      ctx.translate(x, y);
    }

    // Shadow
    ctx.fillStyle = col + '44';
    ctx.beginPath();
    ctx.ellipse(P_W / 2, P_H + 4, 18, 6, 0, 0, Math.PI * 2);
    ctx.fill();

    // Body glow
    ctx.shadowColor = col;
    ctx.shadowBlur  = 20;

    // Legs (running animation)
    const legAnim = Math.sin(Date.now() / 120 * Math.abs(p.vx || 0.5)) * 8;
    ctx.fillStyle = p.darkColor;
    // Leg 1
    ctx.fillRect(6, P_H - 24, 12, 24 + legAnim);
    // Leg 2
    ctx.fillRect(22, P_H - 24, 12, 24 - legAnim);

    // Body
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.roundRect(4, P_H * 0.3, P_W - 8, P_H * 0.45, 6);
    ctx.fill();

    // Head
    ctx.beginPath();
    ctx.arc(P_W / 2, P_H * 0.2, P_H * 0.2, 0, Math.PI * 2);
    ctx.fill();

    // Eyes
    ctx.shadowBlur = 0;
    ctx.fillStyle = '#0d0b1a';
    ctx.beginPath();
    ctx.arc(P_W * 0.6, P_H * 0.17, 3.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#ffffff';
    ctx.beginPath();
    ctx.arc(P_W * 0.62, P_H * 0.16, 1.5, 0, Math.PI * 2);
    ctx.fill();

    // Arm / throw pose
    const armY = p.throwing ? P_H * 0.4 - 8 : P_H * 0.4;
    ctx.fillStyle = col;
    ctx.fillRect(P_W - 6, armY, 14, 10);

    // Weapon preview
    const w = WEAPONS[p.weaponIdx];
    ctx.font = '18px serif';
    ctx.shadowBlur = 0;
    ctx.fillText(w.icon, P_W - 2, armY - 4);

    // Player number tag
    ctx.shadowBlur = 8;
    ctx.shadowColor = col;
    ctx.fillStyle = col;
    ctx.font = 'bold 11px "Spline Sans", sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`P${idx + 1}`, P_W / 2, -8);
    ctx.textAlign = 'left';

    ctx.restore();
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
  document.getElementById(`weapon-p${n}-icon`).textContent = w.icon;
  document.getElementById(`weapon-p${n}-name`).textContent = w.name;
  document.getElementById(`weapon-p${n}-dmg`).textContent  = `-${w.dmg} ×${ammoLeft}`;
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

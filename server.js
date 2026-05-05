const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });
const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'bottle-duel')));
app.get('*', (_req, res) => res.sendFile(path.join(__dirname, 'bottle-duel', 'index.html')));

const rooms = new Map(); // code -> { p1: ws, p2: ws }

function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let c = '';
  for (let i = 0; i < 4; i++) c += chars[Math.floor(Math.random() * chars.length)];
  return c;
}

function send(ws, data) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

wss.on('connection', (ws) => {
  ws.roomCode = null;
  ws.playerNum = null;

  ws.on('message', (raw) => {
    let msg;
    try { msg = JSON.parse(raw.toString()); } catch { return; }

    if (msg.t === 'create') {
      let code;
      do { code = genCode(); } while (rooms.has(code));
      rooms.set(code, { p1: ws, p2: null });
      ws.roomCode = code;
      ws.playerNum = 1;
      send(ws, { t: 'created', code });

    } else if (msg.t === 'join') {
      const code = (msg.code || '').toUpperCase();
      const room = rooms.get(code);
      if (!room)       { send(ws, { t: 'error', msg: 'Nie ma takiego pokoju.' }); return; }
      if (room.p2)     { send(ws, { t: 'error', msg: 'Pokój jest już pełny.' }); return; }
      room.p2 = ws;
      ws.roomCode = code;
      ws.playerNum = 2;
      send(ws,      { t: 'joined', code, playerNum: 2 });
      send(room.p1, { t: 'opponent_joined' });

    } else if (msg.t === 'relay') {
      const room = rooms.get(ws.roomCode);
      if (!room) return;
      const other = ws.playerNum === 1 ? room.p2 : room.p1;
      if (other) send(other, msg.data);
    }
  });

  ws.on('close', () => {
    const code = ws.roomCode;
    if (!code) return;
    const room = rooms.get(code);
    if (!room) return;
    const other = ws.playerNum === 1 ? room.p2 : room.p1;
    if (other) send(other, { t: 'opponent_left' });
    rooms.delete(code);
  });
});

server.listen(PORT, () => console.log(`Jankowo Duel on port ${PORT}`));

/**
 * network.js — PeerJS multiplayer manager
 */

window.Network = (function () {
  let peer = null;
  let conn = null;
  let isHost = false;
  let roomCode = '';
  let onStateCallback       = null;
  let onConnectedCallback   = null;
  let onDisconnectedCallback= null;

  function generateCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 4; i++) code += chars[Math.floor(Math.random() * chars.length)];
    return code;
  }

  // ── peer factory ──────────────────────────────────────────────
  function createPeer(id) {
    const opts = {
      debug: 2,
      config: {
        iceServers: [
          { urls: 'stun:stun.l.google.com:19302' },
          { urls: 'stun:stun1.l.google.com:19302' },
          { urls: 'stun:stun2.l.google.com:19302' },
          // free TURN — helps with symmetric NAT / same-browser
          {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
          {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
          },
        ],
      },
    };
    return id ? new Peer(id, opts) : new Peer(opts);
  }

  // ── data handlers shared ──────────────────────────────────────
  function attachDataHandlers(c) {
    c.on('data', (data) => {
      if (onStateCallback) onStateCallback(data);
    });
    c.on('close', () => {
      if (onDisconnectedCallback) onDisconnectedCallback();
    });
    c.on('error', (err) => console.warn('[Net] conn error', err));
  }

  // ── CREATE ROOM (host) ────────────────────────────────────────
  function createRoom(code) {
    return new Promise((resolve, reject) => {
      roomCode = code || generateCode();
      isHost   = true;
      peer     = createPeer('pduel-' + roomCode);

      peer.on('open', (id) => {
        console.log('[Net] host open, id:', id);
        resolve(roomCode);
      });

      peer.on('error', (err) => {
        console.error('[Net] host peer error:', err.type, err);
        if (err.type === 'unavailable-id') {
          peer.destroy();
          createRoom(generateCode()).then(resolve).catch(reject);
        } else {
          reject(err);
        }
      });

      peer.on('connection', (c) => {
        console.log('[Net] incoming connection from', c.peer);
        conn = c;
        c.on('open', () => {
          console.log('[Net] conn open (host side)');
          attachDataHandlers(c);
          if (onConnectedCallback) onConnectedCallback(true);
        });
        c.on('error', (e) => console.warn('[Net] incoming conn error', e));
      });
    });
  }

  // ── JOIN ROOM (guest) ─────────────────────────────────────────
  function joinRoom(code) {
    return new Promise((resolve, reject) => {
      roomCode = code;
      isHost   = false;
      peer     = createPeer(null);

      const timeoutId = setTimeout(() => {
        console.error('[Net] join timeout');
        reject(new Error('Timeout — host nie odpowiada. Sprawdź kod pokoju.'));
      }, 20000);

      peer.on('open', (myId) => {
        console.log('[Net] guest open, myId:', myId, '→ connecting to pduel-' + code);
        conn = peer.connect('pduel-' + code, { reliable: true, serialization: 'json' });

        conn.on('open', () => {
          clearTimeout(timeoutId);
          console.log('[Net] conn open (guest side)');
          attachDataHandlers(conn);
          if (onConnectedCallback) onConnectedCallback(false);
          resolve();
        });

        conn.on('error', (err) => {
          clearTimeout(timeoutId);
          console.error('[Net] conn error (guest):', err);
          reject(err);
        });
      });

      peer.on('error', (err) => {
        clearTimeout(timeoutId);
        console.error('[Net] guest peer error:', err.type, err);
        reject(new Error('Błąd PeerJS: ' + err.type));
      });
    });
  }

  // ── SEND ─────────────────────────────────────────────────────
  function send(data) {
    if (conn && conn.open) {
      try { conn.send(data); } catch(e) { console.warn('[Net] send fail', e); }
    }
  }

  // ── CALLBACKS ─────────────────────────────────────────────────
  function onState(cb)        { onStateCallback = cb; }
  function onConnected(cb)    { onConnectedCallback = cb; }
  function onDisconnected(cb) { onDisconnectedCallback = cb; }

  function destroy() {
    try { conn && conn.close(); } catch(_){}
    try { peer && peer.destroy(); } catch(_){}
    conn = null; peer = null;
  }

  return { createRoom, joinRoom, send, onState, onConnected, onDisconnected, destroy,
           getIsHost: () => isHost, getRoomCode: () => roomCode };
})();

/**
 * network.js — WebSocket multiplayer (server-side rooms)
 */

window.Network = (function () {
  let ws = null;
  let _playerNum = null;
  let _roomCode  = '';
  let onStateCb        = null;
  let onConnectedCb    = null;
  let onDisconnectedCb = null;

  function wsUrl() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${proto}//${location.host}`;
  }

  function _connect() {
    return new Promise((resolve, reject) => {
      ws = new WebSocket(wsUrl());
      ws.onopen  = () => resolve();
      ws.onerror = () => reject(new Error('Błąd połączenia z serwerem'));
      ws.onclose = () => { if (onDisconnectedCb) onDisconnectedCb(); };
      ws.onmessage = (e) => _handle(JSON.parse(e.data));
    });
  }

  function _handle(msg) {
    switch (msg.t) {
      case 'opponent_joined':
        if (onConnectedCb) onConnectedCb(true);
        break;
      case 'opponent_left':
        if (onDisconnectedCb) onDisconnectedCb();
        break;
      default:
        if (onStateCb) onStateCb(msg);
    }
  }

  // ── PUBLIC ────────────────────────────────────────────────────

  function createRoom() {
    return _connect().then(() => new Promise((resolve, reject) => {
      const orig = ws.onmessage;
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'created') {
          _playerNum = 1;
          _roomCode  = msg.code;
          ws.onmessage = (e2) => _handle(JSON.parse(e2.data));
          resolve(msg.code);
        } else if (msg.t === 'error') {
          reject(new Error(msg.msg));
        } else {
          orig && orig(e);
        }
      };
      ws.send(JSON.stringify({ t: 'create' }));
    }));
  }

  function joinRoom(code) {
    return _connect().then(() => new Promise((resolve, reject) => {
      ws.onmessage = (e) => {
        const msg = JSON.parse(e.data);
        if (msg.t === 'joined') {
          _playerNum = msg.playerNum;
          _roomCode  = msg.code;
          ws.onmessage = (e2) => _handle(JSON.parse(e2.data));
          if (onConnectedCb) onConnectedCb(false);
          resolve();
        } else if (msg.t === 'error') {
          reject(new Error(msg.msg));
        }
      };
      ws.send(JSON.stringify({ t: 'join', code }));
    }));
  }

  function send(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ t: 'relay', data }));
    }
  }

  function onState(cb)        { onStateCb        = cb; }
  function onConnected(cb)    { onConnectedCb    = cb; }
  function onDisconnected(cb) { onDisconnectedCb = cb; }

  function destroy() {
    if (ws) { ws.onclose = null; ws.close(); ws = null; }
  }

  return {
    createRoom, joinRoom, send,
    onState, onConnected, onDisconnected, destroy,
    getIsHost:    () => _playerNum === 1,
    getRoomCode:  () => _roomCode,
    getPlayerNum: () => _playerNum,
  };
})();

/**
 * lobby.js — Ekran lobby / menu
 */

(function () {
  const elName        = document.getElementById('player-name');
  const elBtnCreate   = document.getElementById('btn-create-room');
  const elBtnJoin     = document.getElementById('btn-join-room');
  const elCodeInput   = document.getElementById('room-code-input');
  const elActions     = document.getElementById('lobby-actions');
  const elWaiting     = document.getElementById('waiting-state');
  const elCodeDisplay = document.getElementById('room-code-display');
  const elBtnCopy     = document.getElementById('btn-copy-code');
  const elStatus      = document.getElementById('status-message');

  // BG Particles
  const bgParticles = document.getElementById('bg-particles');
  for (let i = 0; i < 25; i++) {
    const p = document.createElement('div');
    p.className = 'particle';
    const size = Math.random() * 4 + 2;
    const colors = ['#ff5cdb', '#00eefc', '#b3f000', '#a855f7'];
    p.style.cssText = `
      width: ${size}px;
      height: ${size}px;
      left: ${Math.random() * 100}%;
      background: ${colors[Math.floor(Math.random() * colors.length)]};
      animation-duration: ${9 + Math.random() * 12}s;
      animation-delay: ${Math.random() * 12}s;
    `;
    bgParticles.appendChild(p);
  }

  function showStatus(msg, type = 'info') {
    elStatus.textContent = msg;
    elStatus.className = 'status-msg ' + type;
    elStatus.classList.remove('hidden');
  }
  function hideStatus() { elStatus.classList.add('hidden'); }

  /** Validates nick — highlights field and returns false if empty */
  function validateName() {
    const name = elName.value.trim();
    if (!name) {
      elName.focus();
      elName.style.borderColor = '#ff4466';
      elName.style.boxShadow   = '0 0 0 3px #ff446633';
      showStatus('Wpisz swój pseudonim!', 'error');
      setTimeout(() => {
        elName.style.borderColor = '';
        elName.style.boxShadow   = '';
      }, 2000);
      return null;
    }
    return name;
  }

  function setButtonsDisabled(val) {
    elBtnCreate.disabled = val;
    elBtnJoin.disabled   = val;
  }

  // ─── STWÓRZ POKÓJ ─────────────────────────────────────────────
  elBtnCreate.addEventListener('click', async () => {
    const name = validateName();
    if (!name) return;

    showStatus('Tworzę pokój...', 'info');
    setButtonsDisabled(true);

    Network.onConnected(() => {
      sessionStorage.setItem('playerName', name);
      sessionStorage.setItem('playerNum',  '1');
      sessionStorage.setItem('isHost',     'true');
      window.location.href = 'game.html';
    });

    try {
      const code = await Network.createRoom();
      sessionStorage.setItem('roomCode', code);
      elCodeDisplay.textContent = code;
      elActions.classList.add('hidden');
      elWaiting.classList.remove('hidden');
      hideStatus();
    } catch (err) {
      showStatus('Błąd tworzenia pokoju: ' + (err.message || err), 'error');
      setButtonsDisabled(false);
    }
  });

  // ─── KOPIUJ KOD ───────────────────────────────────────────────
  elBtnCopy.addEventListener('click', () => {
    const code = elCodeDisplay.textContent;
    navigator.clipboard.writeText(code).then(() => {
      elBtnCopy.textContent = '✅ Skopiowano!';
      setTimeout(() => { elBtnCopy.textContent = '📋 Kopiuj kod'; }, 2000);
    });
  });

  // ─── DOŁĄCZ ───────────────────────────────────────────────────
  elBtnJoin.addEventListener('click', async () => {
    const name = validateName();
    if (!name) return;

    const code = elCodeInput.value.trim().toUpperCase();
    if (code.length < 4) {
      showStatus('Wpisz 4-znakowy kod pokoju!', 'error');
      elCodeInput.focus();
      return;
    }

    showStatus('Łączę się z pokojem ' + code + '...', 'info');
    setButtonsDisabled(true);

    // Register BEFORE joinRoom — callback fires inside conn.on('open')
    Network.onConnected(() => {
      sessionStorage.setItem('playerName', name);
      sessionStorage.setItem('playerNum',  '2');
      sessionStorage.setItem('roomCode',   code);
      sessionStorage.setItem('isHost',     'false');
      window.location.href = 'game.html';
    });

    try {
      await Network.joinRoom(code);
      // If we reach here, conn is open and onConnected already fired → redirected
    } catch (err) {
      showStatus('❌ ' + (err.message || 'Błąd połączenia'), 'error');
      setButtonsDisabled(false);
    }
  });

  // Enter w polu kodu → join
  elCodeInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') elBtnJoin.click();
  });

  // Tylko alfanumeryczne, wielkie litery
  elCodeInput.addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  });

  // Reset nick highlight on input
  elName.addEventListener('input', () => {
    elName.style.borderColor = '';
    elName.style.boxShadow   = '';
  });

})();

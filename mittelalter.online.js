(() => {
  const STORAGE_KEY = 'mittelalterLobby';
  const DEFAULT_SERVER = localStorage.getItem('mittelalterServerUrl') || 'https://mittelalter-server.onrender.com';
  const PLAYER_NAMES = ['Christoph', 'Vanessa', 'David', 'Gast'];
  const COLOR_NAMES = ['Rot', 'Blau', 'Grün', 'Gelb'];

  let socket = null;
  let currentServer = DEFAULT_SERVER;
  let reconnectTimer = null;
  let intentionallyClosed = false;

  const $ = (id) => document.getElementById(id);

  function normalizeName(name) {
    const clean = String(name || '').trim().slice(0, 24);
    return PLAYER_NAMES.includes(clean) ? clean : '';
  }

  function normalizeRoom(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function normalizeSlotIndex(value) {
    const n = Number(value);
    return Number.isInteger(n) && n >= 0 && n < COLOR_NAMES.length ? n : null;
  }

  function loadState() {
    try {
      return JSON.parse(sessionStorage.getItem(STORAGE_KEY) || '{}');
    } catch (_err) {
      return {};
    }
  }

  function saveState(patch = {}) {
    const next = {
      playerName: '',
      roomCode: '',
      playerId: '',
      sessionToken: '',
      slotIndex: null,
      isHost: false,
      players: [],
      started: false,
      connected: false,
      serverUrl: currentServer,
      ...loadState(),
      ...patch,
    };

    if (!normalizeName(next.playerName)) next.playerName = '';
    next.roomCode = normalizeRoom(next.roomCode);
    next.slotIndex = normalizeSlotIndex(next.slotIndex);

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    sessionStorage.setItem('playerName', next.playerName || '');
    sessionStorage.setItem('roomCode', next.roomCode || '');
    sessionStorage.setItem('playerId', next.playerId || '');
    sessionStorage.setItem('sessionToken', next.sessionToken || '');
    sessionStorage.setItem('isHost', next.isHost ? 'true' : 'false');
    sessionStorage.setItem('mittelalterLastMode', 'online');
    sessionStorage.setItem('mittelalterGameOnlineMode', 'lobby_only');

    localStorage.setItem('playerName', next.playerName || '');
    localStorage.setItem('roomCode', next.roomCode || '');
    localStorage.setItem('playerId', next.playerId || '');
    localStorage.setItem('sessionToken', next.sessionToken || '');
    localStorage.setItem('isHost', next.isHost ? 'true' : 'false');
    localStorage.setItem('mittelalterLastMode', 'online');
    localStorage.setItem('mittelalterGameOnlineMode', 'lobby_only');
    localStorage.setItem('mittelalterServerUrl', next.serverUrl || currentServer);

    return next;
  }

  function setInfo(text, isError = false) {
    const el = $('roomInfo');
    if (!el) return;
    el.innerText = text || '';
    el.style.color = isError ? '#ffb4b4' : '';
  }

  function playerLabel(player) {
    const name = String(player?.name || 'Spieler');
    const teamIndex = normalizeSlotIndex(player?.slotIndex);
    const colorText = teamIndex == null ? '' : ` · ${COLOR_NAMES[teamIndex]}`;
    return `${name}${colorText}${player?.isHost ? ' 👑' : ''}${player?.connected === false ? ' (getrennt)' : ''}`;
  }

  function renderPlayers(players = []) {
    const list = $('playerList');
    if (!list) return;
    list.innerHTML = '';

    if (!players.length) {
      const div = document.createElement('div');
      div.className = 'player';
      div.innerText = 'Noch keine Spieler im Raum';
      list.appendChild(div);
      return;
    }

    players.forEach((player) => {
      const div = document.createElement('div');
      div.className = 'player';
      div.innerText = playerLabel(player);
      list.appendChild(div);
    });
  }

  function syncNameButtons(selectedName) {
    document.querySelectorAll('.quickNameBtn[data-player-name]').forEach((btn) => {
      const isSelected = btn.dataset.playerName === selectedName;
      btn.classList.toggle('selected', isSelected);
    });

    const label = $('selectedPlayerLabel');
    if (label) {
      label.innerText = selectedName ? `Gewählt: ${selectedName}` : 'Noch kein Spieler gewählt';
    }
  }

  function syncColorButtons(selectedSlotIndex, players = [], myPlayerId = '') {
    const occupiedByOthers = new Set(
      (players || [])
        .filter((p) => p && p.id !== myPlayerId)
        .map((p) => normalizeSlotIndex(p.slotIndex))
        .filter((n) => n != null)
    );

    document.querySelectorAll('.colorBtn[data-slot]').forEach((btn) => {
      const slotIndex = normalizeSlotIndex(btn.dataset.slot);
      const isSelected = slotIndex === selectedSlotIndex;
      const isLocked = occupiedByOthers.has(slotIndex);

      btn.classList.toggle('selected', isSelected);
      btn.classList.toggle('locked', !!isLocked);
      btn.disabled = !!isLocked;
      btn.setAttribute('aria-disabled', isLocked ? 'true' : 'false');
      btn.title = slotIndex == null ? 'Farbe' : `${COLOR_NAMES[slotIndex]}${isLocked ? ' (belegt)' : ''}`;
    });

    const label = $('selectedColorLabel');
    if (label) {
      if (selectedSlotIndex == null) {
        label.innerText = 'Noch keine Farbe gewählt';
      } else if (occupiedByOthers.has(selectedSlotIndex)) {
        label.innerText = `Gewählt: ${COLOR_NAMES[selectedSlotIndex]} (aktuell belegt)`;
      } else {
        label.innerText = `Gewählt: ${COLOR_NAMES[selectedSlotIndex]}`;
      }
    }
  }

  function syncUi() {
    const state = loadState();
    if ($('roomInput')) $('roomInput').value = state.roomCode || '';

    renderPlayers(state.players || []);
    syncNameButtons(state.playerName || '');
    syncColorButtons(normalizeSlotIndex(state.slotIndex), state.players || [], state.playerId || '');

    const hasRoom = !!state.roomCode;
    const playerCount = Array.isArray(state.players) ? state.players.length : 0;
    const startBtn = $('startBtn');
    if (startBtn) {
      const enabled = !!(hasRoom && state.connected && state.isHost && playerCount >= 2);
      startBtn.disabled = !enabled;
      startBtn.style.opacity = enabled ? '1' : '0.6';
      startBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
      startBtn.style.display = state.isHost ? 'block' : 'none';
      startBtn.innerText = state.isHost
        ? (playerCount >= 2 ? 'Spiel starten' : 'Spiel starten (mind. 2 Spieler)')
        : 'Auf Host warten';
    }

    const soloTestBtn = $('soloTestBtn');
    if (soloTestBtn) {
      const enabled = !!(hasRoom && state.connected && state.isHost && playerCount === 1 && !state.started);
      soloTestBtn.disabled = !enabled;
      soloTestBtn.style.opacity = enabled ? '1' : '0.6';
      soloTestBtn.style.cursor = enabled ? 'pointer' : 'not-allowed';
      soloTestBtn.style.display = state.isHost ? 'block' : 'none';
      soloTestBtn.innerText = playerCount === 1
        ? '🧪 1-Spieler-Test starten'
        : '🧪 1-Spieler-Test (nur allein im Raum)';
    }

    const serverBox = $('serverStatus');
    if (serverBox) {
      serverBox.innerText = `Server: ${state.serverUrl || currentServer}`;
    }
  }

  function toWsUrl(httpUrl) {
    return httpUrl.replace(/^https:/i, 'wss:').replace(/^http:/i, 'ws:');
  }

  function send(msg) {
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      setInfo('Keine aktive Verbindung zum Server.', true);
      return false;
    }
    socket.send(JSON.stringify(msg));
    return true;
  }

  function handleRoomState(room, infoText, self = null) {
    const state = loadState();
    const me = self || (room.players || []).find((p) => p.id === state.playerId) || null;
    const slotIndex = me ? normalizeSlotIndex(me.slotIndex) : normalizeSlotIndex(state.slotIndex);

    saveState({
      roomCode: room.roomCode || state.roomCode,
      playerName: me?.name || state.playerName,
      playerId: me?.id || self?.playerId || state.playerId,
      sessionToken: self?.sessionToken || state.sessionToken || '',
      slotIndex,
      isHost: !!me?.isHost,
      players: room.players || [],
      started: !!room.gameState?.started,
      connected: true,
    });

    setInfo(infoText || `Raum ${room.roomCode} aktiv · ${room.players.length} Spieler`);
    syncUi();
  }

  function handleMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw.data);
    } catch (_err) {
      setInfo('Antwort vom Server konnte nicht gelesen werden.', true);
      return;
    }

    switch (msg.type) {
      case 'hello': {
        const state = loadState();
        setInfo('Verbunden. Du kannst jetzt einen Raum erstellen oder beitreten.');
        if (state.roomCode && state.playerName && state.slotIndex != null) {
          send({
            type: 'join_room',
            roomCode: state.roomCode,
            name: state.playerName,
            playerId: state.playerId || undefined,
            sessionToken: state.sessionToken || undefined,
            slotIndex: state.slotIndex,
          });
        } else if (state.roomCode) {
          send({ type: 'sync_request' });
        }
        syncUi();
        return;
      }
      case 'room_created':
        saveState({
          roomCode: msg.room.roomCode,
          playerId: msg.self.playerId,
          sessionToken: msg.self.sessionToken || '',
          playerName: msg.self.name,
          slotIndex: normalizeSlotIndex(msg.self.slotIndex),
          isHost: true,
          players: msg.room.players,
          started: false,
          connected: true,
        });
        handleRoomState(msg.room, `Raum erstellt: ${msg.room.roomCode}`, {
          playerId: msg.self.playerId,
          sessionToken: msg.self.sessionToken || '',
          name: msg.self.name,
          slotIndex: normalizeSlotIndex(msg.self.slotIndex),
          isHost: true,
        });
        return;
      case 'room_joined':
        saveState({
          roomCode: msg.room.roomCode,
          playerId: msg.self.playerId,
          sessionToken: msg.self.sessionToken || '',
          playerName: msg.self.name,
          slotIndex: normalizeSlotIndex(msg.self.slotIndex),
          isHost: !!msg.self.isHost,
          players: msg.room.players,
          started: !!msg.room.gameState?.started,
          connected: true,
        });
        handleRoomState(msg.room, `Du bist Raum ${msg.room.roomCode} beigetreten.`, {
          playerId: msg.self.playerId,
          sessionToken: msg.self.sessionToken || '',
          name: msg.self.name,
          slotIndex: normalizeSlotIndex(msg.self.slotIndex),
          isHost: !!msg.self.isHost,
        });
        return;
      case 'room_state':
        handleRoomState(msg.room, msg.info || `Raum ${msg.room.roomCode} synchronisiert.`, msg.self || null);
        return;
      case 'game_started': {
        if (msg.room) handleRoomState(msg.room, msg.info || 'Spiel startet …', msg.self || null);
        const state = loadState();
        window.location.href = `Mittelalter.index.html?room=${encodeURIComponent(state.roomCode)}&player=${encodeURIComponent(state.playerName || '')}`;
        return;
      }
      case 'error_message':
        setInfo(msg.message || 'Serverfehler.', true);
        return;
      case 'noop':
      case 'pong':
        return;
      default:
        return;
    }
  }

  function connect() {
    intentionallyClosed = false;
    clearTimeout(reconnectTimer);

    try {
      socket = new WebSocket(toWsUrl(currentServer));
    } catch (err) {
      setInfo(`WebSocket konnte nicht geöffnet werden: ${err.message}`, true);
      return;
    }

    setInfo('Verbinde mit Server …');
    syncUi();

    socket.addEventListener('open', () => {
      saveState({ connected: true, serverUrl: currentServer });
      syncUi();
    });

    socket.addEventListener('message', handleMessage);

    socket.addEventListener('close', () => {
      saveState({ connected: false });
      syncUi();
      if (!intentionallyClosed) {
        setInfo('Verbindung getrennt. Neuer Verbindungsversuch …', true);
        reconnectTimer = setTimeout(connect, 1500);
      }
    });

    socket.addEventListener('error', () => {
      setInfo('Verbindung zum Mittelalter-Server fehlgeschlagen.', true);
    });
  }

  window.selectQuickName = function selectQuickName(name) {
    const state = loadState();
    if (state.roomCode && state.playerId && Array.isArray(state.players) && state.players.some((p) => p?.id === state.playerId)) {
      setInfo('Name und Farbe sind im Raum gesperrt. Verlasse den Raum, um sie zu ändern.', true);
      return;
    }
    const normalized = normalizeName(name);
    saveState({ playerName: normalized });
    syncUi();
  };

  window.selectColor = function selectColor(slotIndex) {
    const normalizedSlotIndex = normalizeSlotIndex(slotIndex);
    const state = loadState();
    if (state.roomCode && state.playerId && Array.isArray(state.players) && state.players.some((p) => p?.id === state.playerId)) {
      setInfo('Name und Farbe sind im Raum gesperrt. Verlasse den Raum, um sie zu ändern.', true);
      return;
    }
    const occupiedByOthers = new Set(
      (state.players || [])
        .filter((p) => p && p.id !== state.playerId)
        .map((p) => normalizeSlotIndex(p.slotIndex))
        .filter((n) => n != null)
    );

    if (normalizedSlotIndex == null || occupiedByOthers.has(normalizedSlotIndex)) {
      setInfo('Diese Farbe ist bereits belegt.', true);
      return;
    }

    saveState({ slotIndex: normalizedSlotIndex });
    syncUi();
  };

  window.createRoom = function createRoom() {
    const state = loadState();
    const playerName = normalizeName(state.playerName);
    const slotIndex = normalizeSlotIndex(state.slotIndex);

    if (!playerName) {
      setInfo('Bitte zuerst einen Spielernamen per Button wählen.', true);
      return;
    }
    if (slotIndex == null) {
      setInfo('Bitte zuerst eine Farbe wählen.', true);
      return;
    }

    saveState({ playerName, slotIndex });
    send({ type: 'create_room', name: playerName, slotIndex });
  };

  window.joinRoom = function joinRoom() {
    const state = loadState();
    const playerName = normalizeName(state.playerName);
    const roomCode = normalizeRoom($('roomInput')?.value);
    const slotIndex = normalizeSlotIndex(state.slotIndex);

    if ($('roomInput')) $('roomInput').value = roomCode;

    if (!playerName) {
      setInfo('Bitte zuerst einen Spielernamen per Button wählen.', true);
      return;
    }
    if (slotIndex == null) {
      setInfo('Bitte zuerst eine Farbe wählen.', true);
      return;
    }
    if (!roomCode) {
      setInfo('Bitte einen Raumcode eingeben.', true);
      return;
    }

    saveState({ playerName, roomCode, slotIndex });
    send({
      type: 'join_room',
      roomCode,
      name: playerName,
      playerId: state.playerId || undefined,
      sessionToken: state.sessionToken || undefined,
      slotIndex,
    });
  };

  window.startGame = function startGame() {
    const state = loadState();
    if (!state.isHost) {
      setInfo('Nur der Host darf das Spiel starten.', true);
      return;
    }
    if (!Array.isArray(state.players) || state.players.length < 2) {
      setInfo('Für ein normales Spiel werden mindestens 2 Spieler benötigt. Nutze zum Entwickeln den 1-Spieler-Test.', true);
      return;
    }
    send({ type: 'start_game' });
  };

  window.startSoloTest = function startSoloTest() {
    const state = loadState();
    if (!state.isHost) {
      setInfo('Nur der Host darf den 1-Spieler-Test starten.', true);
      return;
    }
    if (!state.roomCode || !state.connected) {
      setInfo('Bitte zuerst einen Raum erstellen und die Serververbindung abwarten.', true);
      return;
    }
    if (!Array.isArray(state.players) || state.players.length !== 1) {
      setInfo('Der 1-Spieler-Test ist nur verfügbar, wenn genau ein Spieler im Raum ist.', true);
      return;
    }
    setInfo('1-Spieler-Test wird serverseitig gestartet …');
    send({ type: 'start_game', testMode: true });
  };

  window.goBack = function goBack() {
    intentionallyClosed = true;
    try { send({ type: 'leave_room' }); } catch (_err) {}
    try { socket?.close(); } catch (_err) {}
    saveState({ roomCode:'', playerId:'', sessionToken:'', players:[], isHost:false, started:false, connected:false });
    try {
      localStorage.removeItem('roomCode');
      localStorage.removeItem('playerId');
      localStorage.removeItem('sessionToken');
      sessionStorage.removeItem('roomCode');
      sessionStorage.removeItem('playerId');
      sessionStorage.removeItem('sessionToken');
    } catch (_err) {}
    window.location.href = 'Mittelalter.index.html';
  };

  window.addEventListener('DOMContentLoaded', () => {
    const state = saveState({
      playerName: localStorage.getItem('playerName') || '',
      roomCode: localStorage.getItem('roomCode') || '',
      playerId: localStorage.getItem('playerId') || '',
      sessionToken: localStorage.getItem('sessionToken') || '',
      slotIndex: normalizeSlotIndex(loadState().slotIndex),
    });
    if (state.playerName && !PLAYER_NAMES.includes(state.playerName)) {
      saveState({ playerName: '' });
    }
    if ($('roomInput')) $('roomInput').value = state.roomCode || '';
    syncUi();
    connect();
  });
})();

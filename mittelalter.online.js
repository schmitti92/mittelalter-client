(() => {
  const STORAGE_KEY = 'mittelalterLobby';
  const DEFAULT_SERVER = localStorage.getItem('mittelalterServerUrl') || 'https://mittelalter-server.onrender.com';

  let socket = null;
  let currentServer = DEFAULT_SERVER;
  let reconnectTimer = null;
  let intentionallyClosed = false;

  const $ = (id) => document.getElementById(id);

  function normalizeName(name) {
    return String(name || '').trim().slice(0, 24) || '';
  }

  function normalizeRoom(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function normalizeSlotIndex(slotIndex) {
    const n = Number(slotIndex);
    return Number.isInteger(n) && n >= 0 && n < 4 ? n : null;
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

    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    sessionStorage.setItem('playerName', next.playerName || '');
    sessionStorage.setItem('roomCode', next.roomCode || '');
    sessionStorage.setItem('playerId', next.playerId || '');
    sessionStorage.setItem('sessionToken', next.sessionToken || '');
    sessionStorage.setItem('slotIndex', next.slotIndex == null ? '' : String(next.slotIndex));
    sessionStorage.setItem('isHost', next.isHost ? 'true' : 'false');
    sessionStorage.setItem('mittelalterLastMode', 'online');
    sessionStorage.setItem('mittelalterGameOnlineMode', 'lobby_only');

    localStorage.setItem('playerName', next.playerName || '');
    localStorage.setItem('roomCode', next.roomCode || '');
    localStorage.setItem('playerId', next.playerId || '');
    localStorage.setItem('sessionToken', next.sessionToken || '');
    localStorage.setItem('slotIndex', next.slotIndex == null ? '' : String(next.slotIndex));
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

  function slotLabel(slotIndex) {
    return ['Rot', 'Blau', 'Grün', 'Gelb'][Number(slotIndex)] || `Slot ${Number(slotIndex) + 1}`;
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
      const colorText = slotLabel(player.slotIndex);
      const label = `${player.name} · ${colorText}${player.isHost ? ' 👑' : ''}${player.connected === false ? ' (getrennt)' : ''}`;
      div.innerText = label;
      list.appendChild(div);
    });
  }

  function syncUi() {
    const state = loadState();
    if ($('roomInput')) $('roomInput').value = state.roomCode || '';

    if (typeof window.applyLobbySelectionFromState === 'function') {
      window.applyLobbySelectionFromState(state);
    }

    if (typeof window.updateColorAvailability === 'function') {
      window.updateColorAvailability(state.players || [], state.playerId || '');
    }

    renderPlayers(state.players || []);

    const hasRoom = !!state.roomCode;
    const startBtn = document.querySelector('.startBtn');
    if (startBtn) {
      startBtn.disabled = !hasRoom || !state.connected || !state.isHost;
      startBtn.style.opacity = startBtn.disabled ? '0.6' : '1';
      startBtn.style.cursor = startBtn.disabled ? 'not-allowed' : 'pointer';
      startBtn.innerText = state.isHost ? 'Spiel starten' : 'Auf Host warten';
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

  function getSelectionOrShowError() {
    const state = loadState();
    const domSelection = typeof window.getLobbySelection === 'function' ? window.getLobbySelection() : {};
    const playerName = normalizeName(domSelection?.selectedName || state.playerName);
    const slotIndex = normalizeSlotIndex(domSelection?.selectedSlotIndex ?? state.slotIndex);

    if (!playerName) {
      setInfo('Bitte einen Spieler-Button wählen.', true);
      return null;
    }

    if (slotIndex == null) {
      setInfo('Bitte eine freie Farbe wählen.', true);
      return null;
    }

    saveState({ playerName, slotIndex });
    return { playerName, slotIndex };
  }

  function handleRoomState(room, infoText, self = null) {
    const state = loadState();
    const me = self || (room.players || []).find((p) => p.id === state.playerId) || null;
    const slotIndex = normalizeSlotIndex(me?.slotIndex ?? state.slotIndex);

    saveState({
      roomCode: room.roomCode || state.roomCode,
      playerId: me?.id || state.playerId || '',
      playerName: me?.name || state.playerName || '',
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
        const roomCode = normalizeRoom(state.roomCode);
        if (roomCode) send({ type: 'sync_request' });
        setInfo('Verbunden. Du kannst jetzt einen Raum erstellen oder beitreten.');
        syncUi();
        return;
      }
      case 'room_created': {
        const self = msg.self || {};
        handleRoomState(msg.room, `Raum erstellt: ${msg.room.roomCode}`, {
          id: self.playerId,
          sessionToken: self.sessionToken,
          name: self.name,
          isHost: true,
          slotIndex: self.slotIndex,
        });
        return;
      }
      case 'room_joined': {
        const self = msg.self || {};
        handleRoomState(msg.room, `Du bist Raum ${msg.room.roomCode} beigetreten.`, {
          id: self.playerId,
          sessionToken: self.sessionToken,
          name: self.name,
          isHost: !!self.isHost,
          slotIndex: self.slotIndex,
        });
        return;
      }
      case 'room_state':
        handleRoomState(msg.room, msg.info || `Raum ${msg.room.roomCode} synchronisiert.`);
        return;
      case 'game_started': {
        if (msg.room) handleRoomState(msg.room, msg.info || 'Spiel startet …');
        const state = loadState();
        window.location.href = `Mittelalter.index.html?room=${encodeURIComponent(state.roomCode)}&player=${encodeURIComponent(state.playerName || '')}`;
        return;
      }
      case 'error_message':
        setInfo(msg.message || 'Serverfehler.', true);
        syncUi();
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

  window.createRoom = function createRoom() {
    const selection = getSelectionOrShowError();
    if (!selection) return;
    send({
      type: 'create_room',
      name: selection.playerName,
      slotIndex: selection.slotIndex,
    });
  };

  window.joinRoom = function joinRoom() {
    const selection = getSelectionOrShowError();
    if (!selection) return;

    const roomCode = normalizeRoom($('roomInput')?.value);
    if ($('roomInput')) $('roomInput').value = roomCode;

    if (!roomCode) {
      setInfo('Bitte einen Raumcode eingeben.', true);
      return;
    }

    const state = loadState();
    saveState({ playerName: selection.playerName, roomCode, slotIndex: selection.slotIndex });

    send({
      type: 'join_room',
      roomCode,
      name: selection.playerName,
      slotIndex: selection.slotIndex,
      playerId: state.playerId || '',
      sessionToken: state.sessionToken || '',
    });
  };

  window.startGame = function startGame() {
    const state = loadState();
    if (!state.isHost) {
      setInfo('Nur der Host darf das Spiel starten.', true);
      return;
    }
    send({ type: 'start_game' });
  };

  window.goBack = function goBack() {
    intentionallyClosed = true;
    try { send({ type: 'leave_room' }); } catch (_err) {}
    try { socket?.close(); } catch (_err) {}
    window.location.href = 'index.html';
  };

  window.addEventListener('DOMContentLoaded', () => {
    const state = loadState();
    if ($('roomInput')) $('roomInput').value = state.roomCode || '';
    syncUi();
    connect();
  });
})();

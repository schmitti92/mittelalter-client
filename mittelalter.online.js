(() => {
  const STORAGE_KEY = 'mittelalterLobby';
  const DEFAULT_SERVER = localStorage.getItem('mittelalterServerUrl') || 'https://mittelalter-server.onrender.com';

  let socket = null;
  let currentServer = DEFAULT_SERVER;
  let reconnectTimer = null;
  let intentionallyClosed = false;

  const $ = (id) => document.getElementById(id);

  function normalizeName(name) {
    return String(name || '').trim().slice(0, 24) || 'Spieler';
  }

  function normalizeRoom(code) {
    return String(code || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 6);
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
    sessionStorage.setItem('isHost', next.isHost ? 'true' : 'false');
    sessionStorage.setItem('mittelalterLastMode', 'online');
    sessionStorage.setItem('mittelalterGameOnlineMode', 'lobby_only');
    localStorage.setItem('playerName', next.playerName || '');
    localStorage.setItem('roomCode', next.roomCode || '');
    localStorage.setItem('playerId', next.playerId || '');
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
      const label = `${player.name}${player.isHost ? ' 👑' : ''}${player.connected === false ? ' (getrennt)' : ''}`;
      div.innerText = label;
      list.appendChild(div);
    });
  }

  function syncUi() {
    const state = loadState();
    if ($('nameInput')) $('nameInput').value = state.playerName || '';
    if ($('roomInput')) $('roomInput').value = state.roomCode || '';

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

  function handleRoomState(room, infoText) {
    const state = loadState();
    const me = (room.players || []).find((p) => p.id === state.playerId);

    saveState({
      roomCode: room.roomCode || state.roomCode,
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
      case 'room_created':
        saveState({
          roomCode: msg.room.roomCode,
          playerId: msg.self.playerId,
          playerName: msg.self.name,
          isHost: true,
          players: msg.room.players,
          started: false,
          connected: true,
        });
        handleRoomState(msg.room, `Raum erstellt: ${msg.room.roomCode}`);
        return;
      case 'room_joined':
        saveState({
          roomCode: msg.room.roomCode,
          playerId: msg.self.playerId,
          playerName: msg.self.name,
          isHost: false,
          players: msg.room.players,
          started: !!msg.room.gameState?.started,
          connected: true,
        });
        handleRoomState(msg.room, `Du bist Raum ${msg.room.roomCode} beigetreten.`);
        return;
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
    const playerName = normalizeName($('nameInput')?.value);
    if ($('nameInput')) $('nameInput').value = playerName;
    saveState({ playerName });
    send({ type: 'create_room', name: playerName });
  };

  window.joinRoom = function joinRoom() {
    const playerName = normalizeName($('nameInput')?.value);
    const roomCode = normalizeRoom($('roomInput')?.value);
    if ($('nameInput')) $('nameInput').value = playerName;
    if ($('roomInput')) $('roomInput').value = roomCode;

    if (!roomCode) {
      setInfo('Bitte einen Raumcode eingeben.', true);
      return;
    }

    saveState({ playerName, roomCode });
    send({ type: 'join_room', roomCode, name: playerName });
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
    if ($('nameInput')) $('nameInput').value = state.playerName || '';
    if ($('roomInput')) $('roomInput').value = state.roomCode || '';
    syncUi();
    connect();
  });
})();

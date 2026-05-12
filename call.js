// ─── STATE ───────────────────────────────────────────────
let peer = null;
let localStream = null;
let screenStream = null;
let myName = '';
let myRoomId = '';
let isHost = false;
let micEnabled = true;
let camEnabled = true;
let screenSharing = false;
let chatOpen = false;

// peerId -> { call, dataConn, name }
const connections = {};
// peerId -> outbound screen-share MediaConnection
const screenCalls = {};
// tileId -> tile element
const videoTiles = {};

// ─── HELPERS ─────────────────────────────────────────────
const $ = (id) => document.getElementById(id);

function toast(msg, dur = 2500) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), dur);
}

function showError(msg) {
  const b = $('error-banner');
  b.textContent = msg;
  b.classList.add('show');
}
function hideError() { $('error-banner').classList.remove('show'); }
function setSpinner(id, on) { $(id).classList.toggle('show', on); }

function uid(len = 10) { return Math.random().toString(36).slice(2, 2 + len); }

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}
function formatTime(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
}

// ─── LOBBY ───────────────────────────────────────────────
async function startPreview() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false
    });
    $('preview').srcObject = stream;
  } catch (e) {
    // preview is optional
  }
}

function stopPreview() {
  const pv = $('preview');
  if (pv.srcObject) {
    pv.srcObject.getTracks().forEach(t => t.stop());
    pv.srcObject = null;
  }
}

// Pre-fill room ID from URL
(function () {
  const r = new URLSearchParams(location.search).get('room');
  if (r) $('room-input').value = r;
})();

startPreview();

// ─── CREATE / JOIN ───────────────────────────────────────
function getLocalStream() {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
}

async function createRoom() {
  hideError();
  myName = $('name-input').value.trim() || 'You';
  setSpinner('create-spinner', true);
  $('create-btn').disabled = true;

  try {
    localStream = await getLocalStream();
  } catch (e) {
    showError('Camera/mic permission denied. Please allow access and retry.');
    setSpinner('create-spinner', false);
    $('create-btn').disabled = false;
    return;
  }

  isHost = true;
  myRoomId = 'gc-' + uid();
  initPeer(myRoomId);
}

async function joinRoom() {
  hideError();
  const roomId = $('room-input').value.trim();
  myName = $('join-name-input').value.trim() || 'Guest';
  if (!roomId) { showError('Please enter a room ID.'); return; }

  setSpinner('join-spinner', true);
  $('join-btn').disabled = true;

  try {
    localStream = await getLocalStream();
  } catch (e) {
    showError('Camera/mic permission denied. Please allow access and retry.');
    setSpinner('join-spinner', false);
    $('join-btn').disabled = false;
    return;
  }

  isHost = false;
  myRoomId = roomId;
  initPeer(null);
}

// ─── PEER LIFECYCLE ──────────────────────────────────────
function initPeer(peerId) {
  const opts = {
    debug: 0,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' }
      ]
    }
  };

  peer = peerId ? new Peer(peerId, opts) : new Peer(opts);

  peer.on('open', () => {
    setSpinner('create-spinner', false);
    setSpinner('join-spinner', false);
    stopPreview();
    enterRoom();
    if (!isHost) connectToPeer(myRoomId);
  });

  peer.on('call', handleIncomingCall);
  peer.on('connection', handleIncomingData);
  peer.on('error', (err) => {
    console.warn('PeerJS error:', err);
    if (err.type === 'peer-unavailable') {
      toast('⚠️ Could not reach that room. Check the room ID.');
    } else if (err.type === 'network') {
      toast('⚠️ Network error. Retrying...');
    }
  });
}

function enterRoom() {
  $('lobby').style.display = 'none';
  $('room').style.display = 'flex';
  $('room-id-display').textContent = myRoomId;
  history.replaceState({}, '', '?room=' + myRoomId);
  addLocalTile();
}

// ─── TILES ───────────────────────────────────────────────
function buildTile(id, name, { isLocal = false, isScreen = false } = {}) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isLocal ? ' local' : '') + (isScreen ? ' screenshare' : '');
  tile.dataset.tileId = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  tile.appendChild(video);

  if (!isScreen) {
    const camOff = document.createElement('div');
    camOff.className = 'cam-off-overlay';
    const av = document.createElement('div');
    av.className = 'avatar-circle';
    av.textContent = (name[0] || '?').toUpperCase();
    const avName = document.createElement('div');
    avName.className = 'avatar-name';
    avName.textContent = name;
    camOff.appendChild(av);
    camOff.appendChild(avName);
    tile.appendChild(camOff);
  }

  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';
  const info = document.createElement('div');
  info.className = 'tile-info';

  const nameEl = document.createElement('span');
  nameEl.className = 'tile-name';
  nameEl.textContent = name + (isScreen ? ' — Screen' : '');
  info.appendChild(nameEl);

  if (isLocal) {
    const badge = document.createElement('span');
    badge.className = 'tile-badge';
    badge.textContent = 'You';
    info.appendChild(badge);
  }

  const status = document.createElement('div');
  status.className = 'status-indicator status-good';
  info.appendChild(status);

  overlay.appendChild(info);
  tile.appendChild(overlay);

  if (!isScreen) {
    const muteIcon = document.createElement('div');
    muteIcon.className = 'tile-muted-icon';
    muteIcon.textContent = '🔇';
    tile.appendChild(muteIcon);
  }

  return tile;
}

function addTile(id, stream, name, opts = {}) {
  if (videoTiles[id]) {
    videoTiles[id].querySelector('video').srcObject = stream;
    return videoTiles[id];
  }
  const tile = buildTile(id, name, opts);
  tile.querySelector('video').srcObject = stream;
  $('video-grid').appendChild(tile);
  videoTiles[id] = tile;
  updateGrid();
  return tile;
}

function addLocalTile()       { addTile('local', localStream, myName, { isLocal: true }); }
function addRemoteCamTile(id, stream, name) { addTile(id, stream, name); }
function addScreenTile(id, stream, name)    { addTile(id, stream, name, { isScreen: true }); }

function removeTile(id) {
  const tile = videoTiles[id];
  if (!tile) return;
  tile.remove();
  delete videoTiles[id];
  updateGrid();
}

function updateGrid() {
  const grid = $('video-grid');
  const n = grid.children.length;
  grid.className = 'n' + Math.min(n, 9);
  updateParticipantCount();
}

function updateParticipantCount() {
  const total = Object.keys(connections).length + 1;
  $('participant-count').textContent = total + ' participant' + (total !== 1 ? 's' : '');
}

function updateTileStatus(peerId, state) {
  const si = videoTiles[peerId] && videoTiles[peerId].querySelector('.status-indicator');
  if (si) si.className = 'status-indicator status-' + state;
}

// ─── DATA CONNECTIONS ────────────────────────────────────
function ensureConn(peerId) {
  if (!connections[peerId]) {
    connections[peerId] = { call: null, dataConn: null, name: 'Guest' };
  }
  return connections[peerId];
}

function connectToPeer(peerId) {
  if (connections[peerId]) return;

  const dataConn = peer.connect(peerId, { metadata: { name: myName } });

  dataConn.on('open', () => {
    ensureConn(peerId).dataConn = dataConn;
    callPeer(peerId);
    if (screenSharing && screenStream) callPeerWithScreen(peerId);
  });
  dataConn.on('data',  (data) => handleDataMessage(peerId, data));
  dataConn.on('close', () => cleanupPeer(peerId));
}

function handleIncomingData(dataConn) {
  const peerId = dataConn.peer;
  const name = (dataConn.metadata && dataConn.metadata.name) || 'Guest';

  const conn = ensureConn(peerId);
  conn.dataConn = dataConn;
  conn.name = name;

  dataConn.on('open', () => {
    sendData(peerId, { type: 'identity', name: myName });
    // Mesh discovery: tell newcomer about other peers we already know.
    Object.keys(connections)
      .filter(id => id !== peerId)
      .forEach(kp => sendData(peerId, {
        type: 'peer-list', peerId: kp, name: connections[kp].name
      }));
  });
  dataConn.on('data',  (data) => handleDataMessage(peerId, data));
  dataConn.on('close', () => cleanupPeer(peerId));
}

function handleDataMessage(peerId, data) {
  if (!data || !data.type) return;
  const tile = videoTiles[peerId];

  switch (data.type) {
    case 'identity':
      ensureConn(peerId).name = data.name;
      if (tile) {
        tile.querySelector('.tile-name').textContent = data.name;
        const av = tile.querySelector('.avatar-circle');
        if (av) av.textContent = (data.name[0] || '?').toUpperCase();
        const avName = tile.querySelector('.avatar-name');
        if (avName) avName.textContent = data.name;
      }
      break;
    case 'peer-list':
      if (data.peerId !== peer.id && !connections[data.peerId]) {
        connectToPeer(data.peerId);
      }
      break;
    case 'mute-state':
      if (tile) {
        const icon = tile.querySelector('.tile-muted-icon');
        if (icon) icon.classList.toggle('show', data.muted);
      }
      break;
    case 'cam-state':
      if (tile) {
        const camOff = tile.querySelector('.cam-off-overlay');
        if (camOff) camOff.classList.toggle('show', data.off);
      }
      break;
    case 'chat':
      receiveChat({ from: data.from, text: data.text, ts: data.ts });
      break;
  }
}

function sendData(peerId, data) {
  const conn = connections[peerId];
  if (conn && conn.dataConn && conn.dataConn.open) conn.dataConn.send(data);
}

function broadcast(data) {
  Object.keys(connections).forEach(pid => sendData(pid, data));
}

// ─── MEDIA CONNECTIONS ───────────────────────────────────
function callPeer(peerId) {
  const call = peer.call(peerId, localStream, { metadata: { name: myName, type: 'cam' } });
  ensureConn(peerId).call = call;

  call.on('stream', (remoteStream) => {
    addRemoteCamTile(peerId, remoteStream, ensureConn(peerId).name);
  });
  call.on('close', () => removeTile(peerId));
  call.on('error', (e) => { console.warn('Call error:', e); updateTileStatus(peerId, 'bad'); });
}

function callPeerWithScreen(peerId) {
  if (!screenStream) return;
  const call = peer.call(peerId, screenStream, { metadata: { name: myName, type: 'screen' } });
  screenCalls[peerId] = call;
  call.on('error', (e) => console.warn('Screen call error:', e));
}

function handleIncomingCall(call) {
  const meta = call.metadata || {};
  const name = meta.name || 'Guest';
  const isScreen = meta.type === 'screen';
  const peerId = call.peer;

  call.answer(localStream);

  if (isScreen) {
    const screenId = peerId + '-screen';
    call.on('stream', (stream) => {
      if (!videoTiles[screenId]) addScreenTile(screenId, stream, name);
    });
    call.on('close', () => removeTile(screenId));
    return;
  }

  const conn = ensureConn(peerId);
  conn.call = call;
  if (!conn.name || conn.name === 'Guest') conn.name = name;

  call.on('stream', (remoteStream) => {
    addRemoteCamTile(peerId, remoteStream, conn.name);
  });
  call.on('close', () => removeTile(peerId));
  call.on('error', (e) => { console.warn('Incoming call error:', e); updateTileStatus(peerId, 'bad'); });

  monitorCall(call, peerId);
}

function monitorCall(call, peerId) {
  const interval = setInterval(() => {
    if (!call.peerConnection) { clearInterval(interval); return; }
    call.peerConnection.getStats().then(stats => {
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const rtt = report.currentRoundTripTime;
          if (rtt === undefined) return;
          if (rtt < 0.15)      updateTileStatus(peerId, 'good');
          else if (rtt < 0.4)  updateTileStatus(peerId, 'poor');
          else                 updateTileStatus(peerId, 'bad');
        }
      });
    }).catch(() => {});
  }, 3000);
}

function cleanupPeer(peerId) {
  const c = connections[peerId];
  if (c) {
    try { c.call && c.call.close(); }     catch(e){}
    try { c.dataConn && c.dataConn.close(); } catch(e){}
    delete connections[peerId];
  }
  if (screenCalls[peerId]) {
    try { screenCalls[peerId].close(); } catch(e){}
    delete screenCalls[peerId];
  }
  removeTile(peerId);
  removeTile(peerId + '-screen');
}

// ─── CONTROLS ────────────────────────────────────────────
function toggleMic() {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  setControlButton('ctrl-mic', micEnabled ? '🎙️' : '🔇',
                   micEnabled ? 'btn-secondary' : 'btn-off',
                   micEnabled ? 'Mic' : 'Muted');
  broadcast({ type: 'mute-state', muted: !micEnabled });
  const muteIcon = videoTiles['local'] && videoTiles['local'].querySelector('.tile-muted-icon');
  if (muteIcon) muteIcon.classList.toggle('show', !micEnabled);
}

function toggleCam() {
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  setControlButton('ctrl-cam', camEnabled ? '📷' : '🚫',
                   camEnabled ? 'btn-secondary' : 'btn-off',
                   camEnabled ? 'Camera' : 'Cam Off');
  broadcast({ type: 'cam-state', off: !camEnabled });
  const camOff = videoTiles['local'] && videoTiles['local'].querySelector('.cam-off-overlay');
  if (camOff) camOff.classList.toggle('show', !camEnabled);
}

async function toggleScreen() {
  if (screenSharing) stopScreenShare();
  else               await startScreenShare();
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') toast('⚠️ Screen sharing not supported in this browser.');
    return;
  }

  screenSharing = true;
  setControlButton('ctrl-screen', '⏹️', 'btn-active', 'Stop Share');

  addScreenTile('local-screen', screenStream, myName);
  Object.keys(connections).forEach(pid => callPeerWithScreen(pid));

  screenStream.getVideoTracks()[0].onended = stopScreenShare;
}

function stopScreenShare() {
  if (!screenSharing) return;
  screenSharing = false;

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }
  Object.entries(screenCalls).forEach(([pid, call]) => {
    try { call.close(); } catch(e){}
    delete screenCalls[pid];
  });
  removeTile('local-screen');
  setControlButton('ctrl-screen', '🖥️', 'btn-secondary', 'Screen');
}

function endCall() {
  if (localStream)  localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());

  Object.keys(connections).forEach(pid => cleanupPeer(pid));
  if (peer) { try { peer.destroy(); } catch(e){} }

  history.replaceState({}, '', location.pathname);

  $('room').style.display = 'none';
  $('lobby').style.display = 'flex';
  $('video-grid').innerHTML = '';
  Object.keys(videoTiles).forEach(k => delete videoTiles[k]);

  localStream = null;
  screenStream = null;
  micEnabled = true;
  camEnabled = true;
  screenSharing = false;

  setControlButton('ctrl-mic',    '🎙️', 'btn-secondary', 'Mic');
  setControlButton('ctrl-cam',    '📷', 'btn-secondary', 'Camera');
  setControlButton('ctrl-screen', '🖥️', 'btn-secondary', 'Screen');

  if (chatOpen) toggleChat();
  $('chat-messages').innerHTML = '';

  $('create-btn').disabled = false;
  $('join-btn').disabled = false;

  startPreview();
}

function setControlButton(ctrlId, icon, btnClass, label) {
  const btn = document.querySelector('#' + ctrlId + ' .btn');
  btn.textContent = icon;
  btn.className = 'btn ' + btnClass;
  document.querySelector('#' + ctrlId + ' span').textContent = label;
}

function copyRoomLink() {
  const url = location.origin + location.pathname + '?room=' + myRoomId;
  navigator.clipboard.writeText(url)
    .then(()  => toast('✅ Room link copied!'))
    .catch(() => navigator.clipboard.writeText(myRoomId).then(() => toast('✅ Room ID copied!')));
}

// ─── CHAT ────────────────────────────────────────────────
function toggleChat() {
  chatOpen = !chatOpen;
  $('chat-panel').classList.toggle('open', chatOpen);
  if (chatOpen) {
    $('ctrl-chat').classList.remove('has-unread');
    setTimeout(() => $('chat-input').focus(), 150);
  }
}

function sendChat() {
  const input = $('chat-input');
  const text = input.value.trim();
  if (!text) return;
  const msg = { from: myName, text, ts: Date.now() };
  broadcast({ type: 'chat', ...msg });
  renderChatMessage(msg, true);
  input.value = '';
}

function receiveChat(msg) {
  renderChatMessage(msg, false);
  if (!chatOpen) $('ctrl-chat').classList.add('has-unread');
}

function renderChatMessage(msg, isMine) {
  const list = $('chat-messages');
  const el = document.createElement('div');
  el.className = 'chat-msg' + (isMine ? ' mine' : '');
  el.innerHTML =
    '<div class="chat-meta">' +
      '<span class="chat-from">' + (isMine ? 'You' : escapeHtml(msg.from)) + '</span>' +
      '<span class="chat-time">' + formatTime(msg.ts) + '</span>' +
    '</div>' +
    '<div class="chat-text">' + escapeHtml(msg.text) + '</div>';
  list.appendChild(el);
  list.scrollTop = list.scrollHeight;
}

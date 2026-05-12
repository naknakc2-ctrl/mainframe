// ─────────────────────────────────────────────────────────
//  STATE
// ─────────────────────────────────────────────────────────
let peer = null;
let localStream = null;
let screenStream = null;
let myName = '';
let myRoomId = '';
let isHost = false;

// connections: { peerId -> { call, dataConn, name, isMuted, isCamOff } }
const connections = {};

// screenCalls: { peerId -> call }  – outbound screen calls to each peer
const screenCalls = {};

// map peerId -> tileElement
const videoTiles = {};

let micEnabled = true;
let camEnabled = true;
let screenSharing = false;

// ─────────────────────────────────────────────────────────
//  HELPERS
// ─────────────────────────────────────────────────────────
function uid(len = 8) {
  return Math.random().toString(36).slice(2, 2 + len);
}

function toast(msg, dur = 2500) {
  const t = document.getElementById('toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => t.classList.remove('show'), dur);
}

function showError(msg) {
  const b = document.getElementById('error-banner');
  b.textContent = msg;
  b.classList.add('show');
}

function hideError() {
  document.getElementById('error-banner').classList.remove('show');
}

function setSpinner(id, on) {
  document.getElementById(id).classList.toggle('show', on);
}

// ─────────────────────────────────────────────────────────
//  LOBBY — preview camera
// ─────────────────────────────────────────────────────────
async function startPreview() {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 } },
      audio: false
    });
    document.getElementById('preview').srcObject = stream;
  } catch (e) {
    // preview is optional — silently skip
  }
}
startPreview();

// pre-fill from URL params
(function() {
  const p = new URLSearchParams(location.search);
  const r = p.get('room');
  if (r) document.getElementById('room-input').value = r;
})();

// ─────────────────────────────────────────────────────────
//  GET USER MEDIA
// ─────────────────────────────────────────────────────────
async function getLocalStream() {
  return navigator.mediaDevices.getUserMedia({
    video: { width: { ideal: 1280 }, height: { ideal: 720 }, frameRate: { ideal: 30 }, facingMode: 'user' },
    audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
  });
}

// ─────────────────────────────────────────────────────────
//  CREATE / JOIN
// ─────────────────────────────────────────────────────────
async function createRoom() {
  hideError();
  myName = document.getElementById('name-input').value.trim() || 'You';
  setSpinner('create-spinner', true);
  document.getElementById('create-btn').disabled = true;

  try {
    localStream = await getLocalStream();
  } catch (e) {
    showError('Camera/mic permission denied. Please allow access and retry.');
    setSpinner('create-spinner', false);
    document.getElementById('create-btn').disabled = false;
    return;
  }

  isHost = true;
  myRoomId = 'gc-' + uid(10);
  initPeer(myRoomId);
}

async function joinRoom() {
  hideError();
  const roomId = document.getElementById('room-input').value.trim();
  myName = document.getElementById('join-name-input').value.trim() || 'Guest';
  if (!roomId) { showError('Please enter a room ID.'); return; }

  setSpinner('join-spinner', true);
  document.getElementById('join-btn').disabled = true;

  try {
    localStream = await getLocalStream();
  } catch (e) {
    showError('Camera/mic permission denied. Please allow access and retry.');
    setSpinner('join-spinner', false);
    document.getElementById('join-btn').disabled = false;
    return;
  }

  isHost = false;
  myRoomId = roomId;
  initPeer(null); // get random peer ID, then signal host
}

// ─────────────────────────────────────────────────────────
//  PEER INIT
// ─────────────────────────────────────────────────────────
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

  peer.on('open', (id) => {
    setSpinner('create-spinner', false);
    setSpinner('join-spinner', false);
    stopPreview();
    enterRoom();

    if (!isHost) {
      // connect to host room as joiner
      connectToPeer(myRoomId);
    }
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

function stopPreview() {
  const pv = document.getElementById('preview');
  if (pv.srcObject) {
    pv.srcObject.getTracks().forEach(t => t.stop());
    pv.srcObject = null;
  }
}

// ─────────────────────────────────────────────────────────
//  ENTER ROOM UI
// ─────────────────────────────────────────────────────────
function enterRoom() {
  document.getElementById('lobby').style.display = 'none';
  document.getElementById('room').style.display = 'flex';
  document.getElementById('room-id-display').textContent = myRoomId;

  // push room ID to URL so it's shareable
  history.replaceState({}, '', '?room=' + myRoomId);

  addLocalTile();
}

// ─────────────────────────────────────────────────────────
//  VIDEO TILES
// ─────────────────────────────────────────────────────────
function addLocalTile() {
  const tile = buildTile('local', myName, true);
  const video = tile.querySelector('video');
  video.srcObject = localStream;
  video.muted = true;
  document.getElementById('video-grid').appendChild(tile);
  videoTiles['local'] = tile;
  updateGridClass();
}

function buildTile(id, name, isLocal = false, isScreen = false) {
  const tile = document.createElement('div');
  tile.className = 'tile' + (isLocal ? ' local' : '') + (isScreen ? ' screenshare' : '');
  tile.dataset.tileId = id;

  const video = document.createElement('video');
  video.autoplay = true;
  video.playsInline = true;
  if (isLocal) video.muted = true;
  tile.appendChild(video);

  // cam-off overlay
  const camOff = document.createElement('div');
  camOff.className = 'cam-off-overlay';
  const av = document.createElement('div');
  av.className = 'avatar-circle';
  av.textContent = name.charAt(0).toUpperCase();
  const avName = document.createElement('div');
  avName.className = 'avatar-name';
  avName.textContent = name;
  camOff.appendChild(av);
  camOff.appendChild(avName);
  tile.appendChild(camOff);

  // overlay
  const overlay = document.createElement('div');
  overlay.className = 'tile-overlay';
  const info = document.createElement('div');
  info.className = 'tile-info';
  const nameEl = document.createElement('span');
  nameEl.className = 'tile-name';
  nameEl.textContent = name + (isLocal ? ' (You)' : '') + (isScreen ? ' — Screen' : '');
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

  // muted icon
  const muteIcon = document.createElement('div');
  muteIcon.className = 'tile-muted-icon';
  muteIcon.innerHTML = '🔇';
  tile.appendChild(muteIcon);

  return tile;
}

function removeTile(id) {
  const tile = videoTiles[id];
  if (tile) {
    tile.remove();
    delete videoTiles[id];
    updateGridClass();
    updateParticipantCount();
  }
}

function updateGridClass() {
  const grid = document.getElementById('video-grid');
  const n = grid.children.length;
  grid.className = 'n' + Math.min(n, 9);
  updateParticipantCount();
}

function updateParticipantCount() {
  const total = Object.keys(connections).length + 1;
  const el = document.getElementById('participant-count');
  el.textContent = total + ' participant' + (total !== 1 ? 's' : '');
}

// ─────────────────────────────────────────────────────────
//  PEER CONNECTIONS — DATA
// ─────────────────────────────────────────────────────────
function connectToPeer(peerId) {
  if (connections[peerId]) return;

  const dataConn = peer.connect(peerId, { metadata: { name: myName, type: 'join' } });

  dataConn.on('open', () => {
    ensureConn(peerId).dataConn = dataConn;
    // call them with our stream
    callPeer(peerId);
    // share screen if already sharing
    if (screenSharing && screenStream) {
      callPeerWithScreen(peerId);
    }
  });

  dataConn.on('data', (data) => handleDataMessage(peerId, data));
  dataConn.on('close', () => cleanupPeer(peerId));
}

function handleIncomingData(dataConn) {
  const peerId = dataConn.peer;
  const meta = dataConn.metadata || {};
  const name = meta.name || 'Guest';

  ensureConn(peerId).dataConn = dataConn;
  ensureConn(peerId).name = name;

  dataConn.on('open', () => {
    // send them back our name
    sendData(peerId, { type: 'identity', name: myName });
    // tell them about all OTHER peers we know
    const knownPeers = Object.keys(connections).filter(id => id !== peerId);
    knownPeers.forEach(kp => {
      sendData(peerId, { type: 'peer-list', peerId: kp, name: connections[kp].name || 'Guest' });
    });
  });

  dataConn.on('data', (data) => handleDataMessage(peerId, data));
  dataConn.on('close', () => cleanupPeer(peerId));
}

function handleDataMessage(peerId, data) {
  if (!data || !data.type) return;
  switch (data.type) {
    case 'identity':
      ensureConn(peerId).name = data.name;
      const tile = videoTiles[peerId];
      if (tile) {
        tile.querySelector('.tile-name').textContent = data.name;
        tile.querySelector('.avatar-circle').textContent = data.name.charAt(0).toUpperCase();
        tile.querySelector('.avatar-name').textContent = data.name;
      }
      break;
    case 'peer-list':
      // connect to peers we don't know yet
      if (!connections[data.peerId] && data.peerId !== peer.id) {
        connectToPeer(data.peerId);
      }
      break;
    case 'mute-state':
      if (videoTiles[peerId]) {
        const icon = videoTiles[peerId].querySelector('.tile-muted-icon');
        if (icon) icon.classList.toggle('show', data.muted);
      }
      break;
    case 'cam-state':
      if (videoTiles[peerId]) {
        const camOff = videoTiles[peerId].querySelector('.cam-off-overlay');
        if (camOff) camOff.classList.toggle('show', data.off);
      }
      break;
  }
}

function sendData(peerId, data) {
  const conn = connections[peerId];
  if (conn && conn.dataConn && conn.dataConn.open) {
    conn.dataConn.send(data);
  }
}

function broadcast(data) {
  Object.keys(connections).forEach(pid => sendData(pid, data));
}

function ensureConn(peerId) {
  if (!connections[peerId]) connections[peerId] = { call: null, dataConn: null, name: 'Guest', screenCall: null };
  return connections[peerId];
}

// ─────────────────────────────────────────────────────────
//  PEER CONNECTIONS — MEDIA
// ─────────────────────────────────────────────────────────
function callPeer(peerId) {
  const call = peer.call(peerId, localStream, {
    metadata: { name: myName, type: 'cam' }
  });
  ensureConn(peerId).call = call;

  call.on('stream', (remoteStream) => {
    addRemoteTile(peerId, remoteStream, ensureConn(peerId).name || 'Guest');
  });

  call.on('close', () => {
    removeTile(peerId);
  });

  call.on('error', (e) => {
    console.warn('Call error:', e);
    updateTileStatus(peerId, 'bad');
  });
}

function callPeerWithScreen(peerId) {
  if (!screenStream) return;
  const call = peer.call(peerId, screenStream, {
    metadata: { name: myName, type: 'screen' }
  });
  screenCalls[peerId] = call;

  call.on('error', (e) => console.warn('Screen call error:', e));
}

function handleIncomingCall(call) {
  const meta = call.metadata || {};
  const name = meta.name || 'Guest';
  const type = meta.type || 'cam';
  const peerId = call.peer;

  call.answer(localStream);

  if (type === 'screen') {
    call.on('stream', (stream) => {
      const screenId = peerId + '-screen';
      if (!videoTiles[screenId]) {
        addScreenTile(screenId, stream, name);
      }
    });
    call.on('close', () => removeTile(peerId + '-screen'));
    return;
  }

  // cam call
  ensureConn(peerId).call = call;
  if (!ensureConn(peerId).name) ensureConn(peerId).name = name;

  call.on('stream', (remoteStream) => {
    addRemoteTile(peerId, remoteStream, ensureConn(peerId).name || name);
    updateParticipantCount();
  });

  call.on('close', () => {
    removeTile(peerId);
    cleanupPeer(peerId);
  });

  call.on('error', (e) => {
    console.warn('Incoming call error:', e);
    updateTileStatus(peerId, 'bad');
  });

  // monitor connection quality
  monitorCall(call, peerId);
}

function addRemoteTile(peerId, stream, name) {
  if (videoTiles[peerId]) {
    videoTiles[peerId].querySelector('video').srcObject = stream;
    return;
  }
  const tile = buildTile(peerId, name);
  const video = tile.querySelector('video');
  video.srcObject = stream;
  document.getElementById('video-grid').appendChild(tile);
  videoTiles[peerId] = tile;
  updateGridClass();
}

function addScreenTile(id, stream, name) {
  const tile = buildTile(id, name, false, true);
  const video = tile.querySelector('video');
  video.srcObject = stream;
  document.getElementById('video-grid').appendChild(tile);
  videoTiles[id] = tile;
  updateGridClass();
}

function updateTileStatus(peerId, state) {
  const tile = videoTiles[peerId];
  if (!tile) return;
  const si = tile.querySelector('.status-indicator');
  if (!si) return;
  si.className = 'status-indicator status-' + state;
}

function monitorCall(call, peerId) {
  // use getStats to track connection quality
  const interval = setInterval(() => {
    if (!call.peerConnection) { clearInterval(interval); return; }
    call.peerConnection.getStats().then(stats => {
      stats.forEach(report => {
        if (report.type === 'candidate-pair' && report.state === 'succeeded') {
          const rtt = report.currentRoundTripTime;
          if (rtt === undefined) return;
          if (rtt < 0.15) updateTileStatus(peerId, 'good');
          else if (rtt < 0.4) updateTileStatus(peerId, 'poor');
          else updateTileStatus(peerId, 'bad');
        }
      });
    }).catch(() => {});
  }, 3000);
}

// ─────────────────────────────────────────────────────────
//  CLEANUP
// ─────────────────────────────────────────────────────────
function cleanupPeer(peerId) {
  if (connections[peerId]) {
    const c = connections[peerId];
    if (c.call) { try { c.call.close(); } catch(e){} }
    if (c.dataConn) { try { c.dataConn.close(); } catch(e){} }
    delete connections[peerId];
  }
  removeTile(peerId);
  removeTile(peerId + '-screen');
}

// ─────────────────────────────────────────────────────────
//  CONTROLS
// ─────────────────────────────────────────────────────────
function toggleMic() {
  micEnabled = !micEnabled;
  localStream.getAudioTracks().forEach(t => { t.enabled = micEnabled; });
  const btn = document.querySelector('#ctrl-mic .btn');
  btn.textContent = micEnabled ? '🎙️' : '🔇';
  btn.className = 'btn ' + (micEnabled ? 'btn-secondary' : 'btn-off');
  document.querySelector('#ctrl-mic span').textContent = micEnabled ? 'Mic' : 'Muted';
  broadcast({ type: 'mute-state', muted: !micEnabled });
  // update own tile
  const muteIcon = videoTiles['local'] && videoTiles['local'].querySelector('.tile-muted-icon');
  if (muteIcon) muteIcon.classList.toggle('show', !micEnabled);
}

function toggleCam() {
  camEnabled = !camEnabled;
  localStream.getVideoTracks().forEach(t => { t.enabled = camEnabled; });
  const btn = document.querySelector('#ctrl-cam .btn');
  btn.textContent = camEnabled ? '📷' : '🚫';
  btn.className = 'btn ' + (camEnabled ? 'btn-secondary' : 'btn-off');
  document.querySelector('#ctrl-cam span').textContent = camEnabled ? 'Camera' : 'Cam Off';
  broadcast({ type: 'cam-state', off: !camEnabled });
  // update own cam-off overlay
  const camOff = videoTiles['local'] && videoTiles['local'].querySelector('.cam-off-overlay');
  if (camOff) camOff.classList.toggle('show', !camEnabled);
}

async function toggleScreen() {
  if (!screenSharing) {
    await startScreenShare();
  } else {
    stopScreenShare();
  }
}

async function startScreenShare() {
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({
      video: { cursor: 'always', width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: { echoCancellation: false, noiseSuppression: false, sampleRate: 44100 }
    });
  } catch (e) {
    if (e.name !== 'NotAllowedError') {
      toast('⚠️ Screen sharing not supported in this browser.');
    }
    return;
  }

  screenSharing = true;
  const btn = document.querySelector('#ctrl-screen .btn');
  btn.textContent = '⏹️';
  btn.className = 'btn btn-active';
  document.querySelector('#ctrl-screen span').textContent = 'Stop Share';

  // show local screen tile
  const localScreenId = 'local-screen';
  addScreenTile(localScreenId, screenStream, myName);

  // call each existing peer with screen stream
  Object.keys(connections).forEach(pid => callPeerWithScreen(pid));

  // stop if browser ends share
  screenStream.getVideoTracks()[0].onended = () => stopScreenShare();
}

function stopScreenShare() {
  if (!screenSharing) return;
  screenSharing = false;

  if (screenStream) {
    screenStream.getTracks().forEach(t => t.stop());
    screenStream = null;
  }

  // close all screen calls
  Object.entries(screenCalls).forEach(([pid, call]) => {
    try { call.close(); } catch(e){}
    delete screenCalls[pid];
  });

  removeTile('local-screen');

  const btn = document.querySelector('#ctrl-screen .btn');
  btn.textContent = '🖥️';
  btn.className = 'btn btn-secondary';
  document.querySelector('#ctrl-screen span').textContent = 'Screen';
}

function endCall() {
  // stop all tracks
  if (localStream) localStream.getTracks().forEach(t => t.stop());
  if (screenStream) screenStream.getTracks().forEach(t => t.stop());

  // close all connections
  Object.keys(connections).forEach(pid => {
    try { connections[pid].call && connections[pid].call.close(); } catch(e){}
    try { connections[pid].dataConn && connections[pid].dataConn.close(); } catch(e){}
  });
  Object.values(screenCalls).forEach(c => { try { c.close(); } catch(e){} });

  if (peer) { try { peer.destroy(); } catch(e){} }

  // reset URL
  history.replaceState({}, '', location.pathname);

  // go back to lobby
  document.getElementById('room').style.display = 'none';
  document.getElementById('lobby').style.display = 'flex';
  document.getElementById('video-grid').innerHTML = '';
  Object.keys(videoTiles).forEach(k => delete videoTiles[k]);
  Object.keys(connections).forEach(k => delete connections[k]);

  localStream = null; screenStream = null;
  micEnabled = true; camEnabled = true; screenSharing = false;

  // reset controls
  document.querySelector('#ctrl-mic .btn').textContent = '🎙️';
  document.querySelector('#ctrl-mic .btn').className = 'btn btn-secondary';
  document.querySelector('#ctrl-mic span').textContent = 'Mic';
  document.querySelector('#ctrl-cam .btn').textContent = '📷';
  document.querySelector('#ctrl-cam .btn').className = 'btn btn-secondary';
  document.querySelector('#ctrl-cam span').textContent = 'Camera';
  document.querySelector('#ctrl-screen .btn').textContent = '🖥️';
  document.querySelector('#ctrl-screen .btn').className = 'btn btn-secondary';
  document.querySelector('#ctrl-screen span').textContent = 'Screen';

  document.getElementById('create-btn').disabled = false;
  document.getElementById('join-btn').disabled = false;

  startPreview();
}

function copyRoomLink() {
  const url = location.origin + location.pathname + '?room=' + myRoomId;
  navigator.clipboard.writeText(url).then(() => toast('✅ Room link copied!')).catch(() => {
    navigator.clipboard.writeText(myRoomId).then(() => toast('✅ Room ID copied!'));
  });
}

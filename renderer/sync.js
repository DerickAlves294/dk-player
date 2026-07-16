/* ============================================================
   OUVIR JUNTO — sincronização por TRANSFERÊNCIA DE ARQUIVO
   ------------------------------------------------------------
   Um servidor de sinalização (rodando na sua VPS) só ajuda os dois apps
   a se acharem na internet. A partir daí, tudo viaja DIRETO de um PC
   pro outro (P2P).

   Design desta versão: em vez de criar uma barra/player novo e
   separado, a gente REAPROVEITA o player que já existe (capa, título,
   barra de progresso, botões) — quando a faixa ativa da party é a do
   seu amigo, esses mesmos elementos passam a refletir a reprodução dele
   (posição, play/pause), e arrastar a barra ou apertar play/pause passa
   a mandar o comando pro lado que realmente está com o arquivo.
============================================================ */

// >>> TROQUE AQUI pelo IP (ou domínio) da sua VPS Oracle, ex:
// const SIGNALING_URL = "ws://123.45.67.89:8080";
const SIGNALING_URL = "ws://136.248.64.225:8080";

const ICE_SERVERS = [
  { urls: "stun:stun.l.google.com:19302" },
  { urls: "stun:stun1.l.google.com:19302" },
];

const CHUNK_SIZE = 16 * 1024;
const BUFFER_HIGH_WATER = 1 * 1024 * 1024;
const BUFFER_LOW_WATER = 256 * 1024;

const PARTY_PLACEHOLDER_ART = `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:linear-gradient(135deg,var(--surface-3),var(--surface-2));">
  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" stroke-width="1.7"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="2.2" fill="var(--accent)"/></svg>
</div>`;

const Party = {
  ws: null,
  pc: null,
  ctrlChannel: null,
  fileChannel: null,
  code: null,
  role: null,
  connected: false,

  activeSide: "me",      // de quem é a faixa ativa da party: "me" ou "peer"
  activeTrackMeta: null, // {trackId, title, artist}
  isPlaying: false,
  loading: null,         // {title} enquanto sincroniza o início

  peerAudio: null,
  sentTrackIds: new Set(),
  receivedFiles: new Map(),
  pendingPlayTrackId: null,
  pendingPlayMeta: null,
  transferProgress: null, // {direction, trackId, name, pct}

  // Capa da música (arte do álbum), transferida separadamente do áudio —
  // ver sendCoverForTrack/bindFileChannel abaixo.
  sentCoverTrackIds: new Set(),
  receivedCovers: new Map(), // trackId -> object URL da capa recebida
};

let ignoreNextAudioEvent = false;
let ignoreNextSeekBroadcast = false;

function partyLog(...args) { console.log("[OuvirJunto]", ...args); }

function guessMime(filePath) {
  const ext = String(filePath).split(".").pop().toLowerCase();
  const map = { mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", m4a: "audio/mp4", flac: "audio/flac", aac: "audio/aac", oga: "audio/ogg", weba: "audio/webm" };
  return map[ext] || "audio/mpeg";
}

/* ============================================================
   PEER AUDIO — elemento oculto que toca o arquivo recebido. Fica
   separado do <audio> principal de propósito: assim o "ended"/"next"
   automático do seu player (que mexe na SUA fila) nunca é disparado por
   engano por causa da música do seu amigo terminando.
============================================================ */
function ensurePeerAudioEl() {
  if (Party.peerAudio) return Party.peerAudio;
  const el = document.createElement("audio");
  el.id = "peerAudio";
  // Nasce já com o volume que o usuário tinha configurado — sem isso ele
  // sempre começava no volume máximo (100%) até a próxima vez que alguém
  // mexesse na barra de volume.
  el.volume = (typeof audio!=="undefined" && typeof audio.volume==="number") ? audio.volume : 1;
  document.body.appendChild(el);
  Party.peerAudio = el;

  el.addEventListener("timeupdate", () => { if (Party.activeSide === "peer") mirrorProgressToUI(el.currentTime, el.duration || 0); });
  el.addEventListener("loadedmetadata", () => { if (Party.activeSide === "peer") mirrorProgressToUI(el.currentTime, el.duration || 0); });
  el.addEventListener("play", () => { if (Party.activeSide === "peer") mirrorPlayIconToUI(true); });
  el.addEventListener("pause", () => { if (Party.activeSide === "peer") mirrorPlayIconToUI(false); });

  return el;
}

/* ============================================================
   ESPELHAMENTO NO PLAYER JÁ EXISTENTE (miniplayer + tela cheia)
============================================================ */
function mirrorProgressToUI(cur, dur) {
  const pct = dur ? (cur / dur * 100) : 0;
  document.getElementById("seekFill").style.width = pct + "%";
  document.getElementById("seekHandle").style.left = pct + "%";
  document.getElementById("fpSeekFill").style.width = pct + "%";
  document.getElementById("fpSeekHandle").style.left = pct + "%";
  document.getElementById("curTime").textContent = fmtTime(cur);
  document.getElementById("durTime").textContent = fmtTime(dur);
  document.getElementById("fpCurTime").textContent = fmtTime(cur);
  document.getElementById("fpDurTime").textContent = fmtTime(dur);
}

function mirrorPlayIconToUI(isPlaying) {
  const playSvg = '<path d="M8 5v14l11-7z"/>';
  const pauseSvg = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  document.getElementById("playIcon").innerHTML = isPlaying ? pauseSvg : playSvg;
  document.getElementById("fpPlayIcon").innerHTML = isPlaying ? pauseSvg : playSvg;
  document.getElementById("mpArt").classList.toggle("spin", isPlaying);
}

/* Mostra a faixa ATIVA da party (minha ou do amigo) no player. Rodo isso
   com um pequeno atraso (setTimeout 0) pra garantir que fica por cima de
   qualquer atualização que o app.js tenha acabado de fazer no mesmo
   instante (evita a mensagem de "sincronizando" sumir na hora errada). */
function showPartyTrackInMiniplayer(meta, opts = {}) {
  setTimeout(() => {
    const miniplayer = document.getElementById("miniplayer");
    miniplayer.style.display = "grid";
    // Marca visualmente o player como "em sincronia" (brilho na capa etc.
    // — ver .party-active no styles.css). Removido de novo em teardownConnection.
    miniplayer.classList.add("party-active");
    document.getElementById("fullOverlay").classList.add("party-active");

    const isLoading = !!opts.loading;
    const isMine = Party.activeSide === "me";

    if (isMine) {
      // A capa/título/artista real já foram colocados pelo próprio
      // app.js (showMiniplayerForTrack) — só adiciono o aviso, agora como
      // um rótulo destacado (.party-label) em vez de texto plano.
      const artistEl = document.getElementById("mpArtist");
      const fpArtistEl = document.getElementById("fpArtist");
      const base = escapeHtml(meta.artist || "");
      const labelText = isLoading ? `Sincronizando... ${opts.pct || 0}%` : `Tocando pra vocês dois`;
      // Miniplayer: pouco espaço horizontal, então o rótulo vai numa
      // segunda linha, embaixo do nome do artista, em vez de espremido
      // do lado (evita truncar o texto).
      const miniLabel = `<span class="party-label">${labelText}</span>`;
      const miniHtml = base ? `<span class="party-mini-stack">${base}${miniLabel}</span>` : miniLabel;
      // Tela cheia: espaço de sobra, mantém tudo na mesma linha — nome,
      // bolinha e rótulo como itens irmãos, pra alinhar perfeitamente.
      const fullHtml = `<span class="party-artist-line">${base ? `<span class="party-name">${base}</span>` : ""}<span class="party-dot"></span><span class="party-label-text">${labelText}</span></span>`;
      artistEl.innerHTML = miniHtml;
      fpArtistEl.innerHTML = fullHtml;
    } else {
      // Se a capa dessa faixa já chegou (transferida separadamente do
      // áudio — ver sendCoverForTrack), mostra ela; senão, o placeholder
      // genérico até ela chegar (ver applyReceivedCoverIfActive).
      const coverUrl = Party.receivedCovers.get(meta.trackId);
      const artHtmlForPeer = coverUrl ? `<img src="${coverUrl}" alt=""/>` : PARTY_PLACEHOLDER_ART;
      document.getElementById("mpArt").innerHTML = artHtmlForPeer;
      document.getElementById("fpArt").innerHTML = artHtmlForPeer;
      document.getElementById("mpArt").classList.remove("spin");

      const title = isLoading ? `Sincronizando "${meta.title}"...` : meta.title;
      const base = escapeHtml(meta.artist || "");
      const labelText = isLoading ? `${opts.pct || 0}%` : `Ouvindo com seu amigo`;
      const miniLabel = `<span class="party-label">${labelText}</span>`;
      const miniSub = (base && !isLoading) ? `<span class="party-mini-stack">${base}${miniLabel}</span>` : miniLabel;
      const fullSub = isLoading
        ? `<span class="party-artist-line"><span class="party-dot"></span><span class="party-label-text">${labelText}</span></span>`
        : `<span class="party-artist-line">${base ? `<span class="party-name">${base}</span>` : ""}<span class="party-dot"></span><span class="party-label-text">${labelText}</span></span>`;
      document.getElementById("mpTitle").textContent = title;
      document.getElementById("mpArtist").innerHTML = miniSub;
      document.getElementById("fpTitle").textContent = title;
      document.getElementById("fpArtist").innerHTML = fullSub;

      if (isLoading) {
        mirrorProgressToUI(0, 0);
        mirrorPlayIconToUI(false);
      }
    }
  }, 0);
}

/* Chamada quando a capa de uma faixa termina de chegar pelo canal de
   arquivo. Só atualiza o player na tela se essa ainda for a faixa ativa
   do amigo — evita "vazar" a capa de uma música antiga pra cima da que
   está tocando agora, caso a transferência termine atrasada. */
function applyReceivedCoverIfActive(trackId) {
  if (Party.activeSide !== "peer") return;
  if (!Party.activeTrackMeta || Party.activeTrackMeta.trackId !== trackId) return;
  const url = Party.receivedCovers.get(trackId);
  if (!url) return;
  const mpArt = document.getElementById("mpArt");
  const fpArt = document.getElementById("fpArt");
  if (mpArt) mpArt.innerHTML = `<img src="${url}" alt=""/>`;
  if (fpArt) fpArt.innerHTML = `<img src="${url}" alt=""/>`;
}

/* ============================================================
   SINALIZAÇÃO
============================================================ */
function connectSignaling() {
  return new Promise((resolve, reject) => {
    let settled = false;
    const ws = new WebSocket(SIGNALING_URL);
    ws.onopen = () => { settled = true; resolve(ws); };
    ws.onerror = () => { if (!settled) { settled = true; reject(new Error("Falha ao conectar no servidor de sinalização.")); } };
    Party.ws = ws;
  });
}

async function createParty() {
  await connectSignaling();
  setupSocketHandlers();
  Party.ws.send(JSON.stringify({ type: "create" }));
}

async function joinParty(code) {
  await connectSignaling();
  setupSocketHandlers();
  Party.ws.send(JSON.stringify({ type: "join", code: code.trim().toUpperCase() }));
}

function setupSocketHandlers() {
  Party.ws.onmessage = async (event) => {
    let msg;
    try { msg = JSON.parse(event.data); } catch { return; }

    if (msg.type === "created") { Party.code = msg.code; Party.role = "host"; updatePartyUI(); }

    if (msg.type === "joined") {
      Party.code = msg.code;
      Party.role = "guest";
      await setupPeerConnection();
      await createAndSendOffer();
      updatePartyUI();
    }

    if (msg.type === "peer-joined") { await setupPeerConnection(); updatePartyUI(); }

    if (msg.type === "signal") await handleSignal(msg.data);

    if (msg.type === "peer-left") {
      showToast("Seu amigo saiu da party.");
      // Quem era o convidado (guest) não tem pra quem "reconectar" — o
      // host que sumiu era o único dono da sessão. Sem isso, a tela ficava
      // travada mostrando "Conectando com o host...", já que Party.code e
      // Party.role continuavam preenchidos com os valores antigos.
      // Quem é o host continua com o código ativo, esperando outra pessoa
      // entrar (comportamento normal de sala aberta).
      if (Party.role === "guest") leaveParty();
      else teardownConnection(false);
    }

    if (msg.type === "error") {
      showToast(msg.message || "Erro ao entrar na party.");
      leaveParty();
    }
  };

  Party.ws.onclose = () => { Party.connected = false; updatePartyUI(); };
}

function sendSignal(data) {
  if (Party.ws && Party.ws.readyState === WebSocket.OPEN) Party.ws.send(JSON.stringify({ type: "signal", data }));
}

/* ============================================================
   WEBRTC — só canais de dados
============================================================ */
async function setupPeerConnection() {
  if (Party.pc) return;
  partyLog("criando RTCPeerConnection (só canais de dados)...");
  const pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });
  Party.pc = pc;

  pc.onicecandidate = (e) => { if (e.candidate) sendSignal({ candidate: e.candidate }); };
  pc.onconnectionstatechange = () => {
    partyLog("estado da conexão:", pc.connectionState);
    if (pc.connectionState === "connected") { Party.connected = true; updatePartyUI(); }
    if (["disconnected", "failed", "closed"].includes(pc.connectionState)) { Party.connected = false; updatePartyUI(); }
  };

  if (Party.role === "guest") {
    Party.ctrlChannel = pc.createDataChannel("ctrl");
    bindCtrlChannel(Party.ctrlChannel);
    Party.fileChannel = pc.createDataChannel("file");
    Party.fileChannel.binaryType = "arraybuffer";
    Party.fileChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
    bindFileChannel(Party.fileChannel);
  } else {
    pc.ondatachannel = (e) => {
      if (e.channel.label === "ctrl") { Party.ctrlChannel = e.channel; bindCtrlChannel(e.channel); }
      else if (e.channel.label === "file") {
        Party.fileChannel = e.channel;
        Party.fileChannel.binaryType = "arraybuffer";
        Party.fileChannel.bufferedAmountLowThreshold = BUFFER_LOW_WATER;
        bindFileChannel(e.channel);
      }
    };
  }
}

async function createAndSendOffer() {
  const offer = await Party.pc.createOffer();
  await Party.pc.setLocalDescription(offer);
  sendSignal({ sdp: offer });
}

async function handleSignal(data) {
  if (!Party.pc) await setupPeerConnection();
  if (data.sdp) {
    await Party.pc.setRemoteDescription(new RTCSessionDescription(data.sdp));
    if (data.sdp.type === "offer") {
      const answer = await Party.pc.createAnswer();
      await Party.pc.setLocalDescription(answer);
      sendSignal({ sdp: answer });
    }
  }
  if (data.candidate) {
    try { await Party.pc.addIceCandidate(new RTCIceCandidate(data.candidate)); }
    catch (e) { partyLog("erro ao adicionar ICE candidate", e); }
  }
}

/* ============================================================
   CANAL DE CONTROLE
============================================================ */
function bindCtrlChannel(dc) {
  dc.onopen = () => partyLog("✅ canal de controle ABERTO");
  dc.onclose = () => partyLog("canal de controle fechado");
  dc.onerror = (e) => partyLog("ERRO no canal de controle:", e);
  dc.onmessage = (e) => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }

    if (msg.type === "loading") handleRemoteLoading(msg);
    if (msg.type === "now-playing") handleRemoteNowPlaying(msg);
    if (msg.type === "pause") handleRemotePlayState(false);
    if (msg.type === "resume") handleRemotePlayState(true);
    if (msg.type === "seek") handleRemoteSeek(msg.time);

    // Pedidos do outro lado sobre a MINHA faixa (que é a ativa agora)
    if (msg.type === "remote-pause-request" && Party.activeSide === "me") audio.pause();
    if (msg.type === "remote-resume-request" && Party.activeSide === "me") audio.play().catch(() => {});
    if (msg.type === "remote-seek-request" && Party.activeSide === "me") audio.currentTime = msg.time;
    if (msg.type === "party-stop") handlePartyStopRequest();
  };
}

function handleRemoteLoading(msg) {
  partyLog("outro lado está carregando uma música nova:", msg.title);
  Party.activeSide = "peer";
  Party.activeTrackMeta = { trackId: msg.trackId, title: msg.title, artist: msg.artist };
  Party.loading = { title: msg.title };
  Party.isPlaying = false;
  if (!audio.paused) { ignoreNextAudioEvent = true; audio.pause(); }
  if (Party.peerAudio && !Party.peerAudio.paused) Party.peerAudio.pause();
  showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: true, pct: 0 });
  updatePartyUI();
}

function handleRemoteNowPlaying(msg) {
  partyLog("música do outro lado pronta:", msg.title);
  Party.activeSide = "peer";
  Party.activeTrackMeta = { trackId: msg.trackId, title: msg.title, artist: msg.artist };
  Party.loading = null;
  Party.isPlaying = true;
  if (!audio.paused) { ignoreNextAudioEvent = true; audio.pause(); }

  showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: false });

  const cachedUrl = Party.receivedFiles.get(msg.trackId);
  if (cachedUrl) playReceivedTrack(msg.trackId, msg);
  else { Party.pendingPlayTrackId = msg.trackId; Party.pendingPlayMeta = msg; }
  updatePartyUI();
}

function handleRemotePlayState(shouldPlay) {
  if (Party.activeSide !== "peer") return;
  Party.isPlaying = shouldPlay;
  const el = ensurePeerAudioEl();
  if (shouldPlay) el.play().catch((e) => partyLog("❌ erro ao retomar peerAudio:", e.name, e.message));
  else el.pause();
  updatePartyUI();
}

function handleRemoteSeek(time) {
  if (Party.activeSide !== "peer") return;
  const el = ensurePeerAudioEl();
  el.currentTime = time;
}

function playReceivedTrack(trackId, meta) {
  const url = Party.receivedFiles.get(trackId);
  if (!url) return;
  const el = ensurePeerAudioEl();
  el.src = url;
  el.play()
    .then(() => partyLog("tocando arquivo recebido:", meta.title))
    .catch((e) => partyLog("❌ ERRO ao tocar arquivo recebido:", e.name, e.message));
}

/* ============================================================
   CANAL DE ARQUIVO
============================================================ */
function bindFileChannel(dc) {
  let incomingChunks = [];
  let incomingMeta = null;

  dc.onopen = () => partyLog("✅ canal de arquivo ABERTO");
  dc.onclose = () => partyLog("canal de arquivo fechado");
  dc.onerror = (e) => partyLog("ERRO no canal de arquivo:", e);

  dc.onmessage = (e) => {
    if (typeof e.data === "string") {
      let msg;
      try { msg = JSON.parse(e.data); } catch { return; }

      if (msg.type === "file-start") {
        incomingMeta = msg;
        incomingChunks = [];
        if (incomingMeta.kind === "cover") {
          // Transferência pequena e silenciosa — não mexe na barra de
          // progresso "sincronizando X%" que é sobre o áudio.
          updatePartyUI();
        } else {
          Party.transferProgress = { direction: "recv", trackId: msg.trackId, name: msg.name, pct: 0 };
          if (Party.loading && Party.activeTrackMeta && Party.activeTrackMeta.trackId === msg.trackId) {
            showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: true, pct: 0 });
          }
          updatePartyUI();
        }
      } else if (msg.type === "file-end") {
        if (!incomingMeta) return;
        const blob = new Blob(incomingChunks, { type: incomingMeta.mime || "audio/mpeg" });

        if (incomingMeta.kind === "cover") {
          const url = URL.createObjectURL(blob);
          const oldUrl = Party.receivedCovers.get(incomingMeta.trackId);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          Party.receivedCovers.set(incomingMeta.trackId, url);
          partyLog(`capa recebida: ${incomingMeta.trackId}`);
          applyReceivedCoverIfActive(incomingMeta.trackId);
        } else {
          const url = URL.createObjectURL(blob);
          const oldUrl = Party.receivedFiles.get(incomingMeta.trackId);
          if (oldUrl) URL.revokeObjectURL(oldUrl);
          Party.receivedFiles.set(incomingMeta.trackId, url);
          partyLog(`arquivo recebido por completo: ${incomingMeta.name}`);

          if (Party.transferProgress && Party.transferProgress.trackId === incomingMeta.trackId) Party.transferProgress = null;
          updatePartyUI();

          if (Party.pendingPlayTrackId === incomingMeta.trackId) {
            playReceivedTrack(incomingMeta.trackId, Party.pendingPlayMeta);
            Party.pendingPlayTrackId = null;
            Party.pendingPlayMeta = null;
          }
        }
        incomingMeta = null;
        incomingChunks = [];
      }
    } else {
      incomingChunks.push(e.data);
      if (incomingMeta) {
        const receivedSoFar = incomingChunks.reduce((sum, c) => sum + c.byteLength, 0);
        const pct = Math.min(99, Math.round((receivedSoFar / incomingMeta.size) * 100));
        if (Party.transferProgress && Party.transferProgress.trackId === incomingMeta.trackId) {
          Party.transferProgress.pct = pct;
          if (Party.loading && Party.activeTrackMeta && Party.activeTrackMeta.trackId === incomingMeta.trackId) {
            showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: true, pct });
          }
        }
      }
    }
  };
}

// Só um arquivo de cada vez viaja pelo canal — se a capa e o áudio de
// uma faixa fossem mandados ao mesmo tempo (ex: capa da faixa atual +
// pré-carregamento da próxima), os pedaços de um se misturariam com os
// do outro do lado de quem recebe. Essa fila garante que cada
// transferência só começa depois que a anterior manda seu "file-end".
let fileSendChain = Promise.resolve();
function sendFileOverChannel(dc, trackId, arrayBuffer, meta) {
  const kind = meta.kind || "track";
  const run = async () => {
    dc.send(JSON.stringify({ type: "file-start", trackId, name: meta.name, mime: meta.mime, size: arrayBuffer.byteLength, kind }));

    let offset = 0;
    const total = arrayBuffer.byteLength;
    while (offset < total) {
      if (dc.bufferedAmount > BUFFER_HIGH_WATER) {
        await new Promise((resolve) => { dc.onbufferedamountlow = () => resolve(); });
      }
      const end = Math.min(offset + CHUNK_SIZE, total);
      dc.send(arrayBuffer.slice(offset, end));
      offset = end;

      if (kind === "track" && Party.transferProgress && Party.transferProgress.trackId === trackId) {
        Party.transferProgress.pct = Math.min(99, Math.round((offset / total) * 100));
        if (Party.loading && Party.activeTrackMeta && Party.activeTrackMeta.trackId === trackId) {
          showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: true, pct: Party.transferProgress.pct });
        }
      }
    }
    dc.send(JSON.stringify({ type: "file-end", trackId, kind }));
    partyLog(`${kind === "cover" ? "capa enviada" : "arquivo enviado"}: ${meta.name} (${(total / 1024).toFixed(0)} KB)`);
  };

  const result = fileSendChain.then(run, run);
  fileSendChain = result.catch(() => {});
  return result;
}

async function sendTrackFile(track, { isPrefetch } = {}) {
  if (!Party.fileChannel || Party.fileChannel.readyState !== "open") return;
  if (Party.sentTrackIds.has(track.id)) return;

  if (!isPrefetch) Party.transferProgress = { direction: "send", trackId: track.id, name: track.name || track.title, pct: 0 };
  updatePartyUI();

  try {
    const bytes = await window.dkAPI.readFileBuffer(track.path);
    if (!bytes || !bytes.buffer) { partyLog("ERRO: não consegui ler o arquivo pra enviar:", track.path); return; }
    await sendFileOverChannel(Party.fileChannel, track.id, bytes.buffer, { name: track.name || track.title, mime: guessMime(track.path) });
    Party.sentTrackIds.add(track.id);
  } catch (e) {
    partyLog("ERRO ao enviar arquivo:", e);
  } finally {
    if (Party.transferProgress && Party.transferProgress.trackId === track.id) Party.transferProgress = null;
    updatePartyUI();
  }
}

/* Manda a capa (arte do álbum) da faixa pro amigo, se ela existir. Usa os
   bytes brutos guardados em track.coverBytes (extraídos do ID3 pelo
   app.js) em vez de dar fetch() no track.coverUrl — esse é um blob: URL,
   e a Content-Security-Policy do app (connect-src) bloqueia fetch pra
   blob:, então a capa nunca saía do PC de quem está tocando. Com os bytes
   já em mãos, só reempacotamos e mandamos pelo mesmo canal de arquivo
   usado pro áudio, marcados como kind:"cover" pra chegar rápido e não
   virar a "faixa tocando". */
async function sendCoverForTrack(track) {
  if (!Party.fileChannel || Party.fileChannel.readyState !== "open") return;
  if (!track.coverBytes || !track.coverBytes.length) return;
  if (Party.sentCoverTrackIds.has(track.id)) return;
  try {
    const bytes = track.coverBytes;
    const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
    await sendFileOverChannel(Party.fileChannel, track.id, buf, { name: "cover", mime: track.coverMime || "image/jpeg", kind: "cover" });
    Party.sentCoverTrackIds.add(track.id);
  } catch (e) {
    partyLog("erro ao enviar capa:", e);
  }
}

function prefetchNextTrack() {
  if (typeof peekNextTrackId !== "function" || typeof trackById !== "function") return;
  const nextId = peekNextTrackId();
  if (!nextId || Party.sentTrackIds.has(nextId)) return;
  const nextTrack = trackById(nextId);
  if (!nextTrack) return;
  partyLog("pré-carregando em segundo plano:", nextTrack.title || nextTrack.name);
  sendTrackFile(nextTrack, { isPrefetch: true });
}

/* ============================================================
   PLAYER LOCAL — início sincronizado + pause/resume/seek nos dois sentidos
============================================================ */
audio.addEventListener("play", async () => {
  if (ignoreNextAudioEvent) { ignoreNextAudioEvent = false; return; }
  if (!Party.connected || !Party.ctrlChannel || Party.ctrlChannel.readyState !== "open") return;

  const t = typeof currentTrack === "function" ? currentTrack() : null;
  if (!t) return;

  const isNewTrack = !Party.activeTrackMeta || Party.activeTrackMeta.trackId !== t.id || Party.activeSide !== "me";

  if (isNewTrack) {
    ignoreNextAudioEvent = true;
    audio.pause();
    if (Party.peerAudio && !Party.peerAudio.paused) Party.peerAudio.pause();

    Party.activeSide = "me";
    Party.activeTrackMeta = { trackId: t.id, title: t.title, artist: t.artist };
    Party.loading = { title: t.title };
    Party.isPlaying = false;
    Party.ctrlChannel.send(JSON.stringify({ type: "loading", trackId: t.id, title: t.title, artist: t.artist }));
    showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: true, pct: 0 });
    updatePartyUI();

    await sendCoverForTrack(t);
    await sendTrackFile(t);

    Party.loading = null;
    Party.isPlaying = true;
    Party.ctrlChannel.send(JSON.stringify({ type: "now-playing", trackId: t.id, title: t.title, artist: t.artist }));
    ignoreNextAudioEvent = true;
    audio.currentTime = 0;
    audio.play().catch(() => {});
    showPartyTrackInMiniplayer(Party.activeTrackMeta, { loading: false });
    updatePartyUI();

    prefetchNextTrack();
  } else {
    Party.isPlaying = true;
    Party.ctrlChannel.send(JSON.stringify({ type: "resume" }));
    updatePartyUI();
  }
});

audio.addEventListener("pause", () => {
  if (ignoreNextAudioEvent) return;
  if (!Party.connected || !Party.ctrlChannel || Party.ctrlChannel.readyState !== "open") return;
  if (Party.activeSide !== "me") return;
  Party.isPlaying = false;
  Party.ctrlChannel.send(JSON.stringify({ type: "pause" }));
  updatePartyUI();
});

audio.addEventListener("seeked", () => {
  if (ignoreNextSeekBroadcast) { ignoreNextSeekBroadcast = false; return; }
  if (!Party.connected || !Party.ctrlChannel || Party.ctrlChannel.readyState !== "open") return;
  if (Party.activeSide !== "me") return;
  Party.ctrlChannel.send(JSON.stringify({ type: "seek", time: audio.currentTime }));
});

/* Intercepta o botão de play/pause (clique E atalho de teclado) quando a
   faixa ativa é a do amigo — em vez de mexer no MEU player (que não tem
   nada carregado), manda um pedido de controle remoto. */
function requestRemoteToggle() {
  if (!Party.ctrlChannel || Party.ctrlChannel.readyState !== "open") return;
  Party.ctrlChannel.send(JSON.stringify({ type: Party.isPlaying ? "remote-pause-request" : "remote-resume-request" }));
}

const _originalTogglePlay = window.togglePlay;
window.togglePlay = function () {
  if (Party.connected && Party.activeSide === "peer") { requestRemoteToggle(); return; }
  _originalTogglePlay();
};

/* ============================================================
   FECHAR O PLAYER NO "OUVIR JUNTO"
   O X do miniplayer/tela cheia (closePlayer, em app.js) só mexia no MEU
   player local — se a faixa ativa fosse a do amigo (Party.activeSide ===
   "peer"), o áudio dele continuava tocando normalmente do lado dele.
   Agora, com a party conectada, o X manda um aviso pro outro lado
   ("party-stop") e os dois encerram a reprodução compartilhada juntos,
   não importa de qual lado ela estava tocando.
============================================================ */
function handlePartyStopRequest() {
  // Se eu estava ouvindo a faixa do amigo, é o peerAudio que precisa parar
  // (o <audio> principal não tem nada carregado nesse caso).
  if (Party.peerAudio) {
    Party.peerAudio.pause();
    Party.peerAudio.removeAttribute("src");
  }
  Party.activeSide = "me";
  Party.activeTrackMeta = null;
  Party.isPlaying = false;
  Party.loading = null;
  document.getElementById("miniplayer")?.classList.remove("party-active");
  document.getElementById("fullOverlay")?.classList.remove("party-active");
  // closePlayer (app.js) cuida do <audio> principal (se era ele quem
  // estava tocando/transmitindo pro amigo) e some com o miniplayer.
  if (typeof closePlayer === "function") closePlayer();
  updatePartyUI();
}

document.getElementById("closePlayerBtn")?.addEventListener("click", (e) => {
  if (!Party.connected) return; // fora da party, deixa o comportamento normal do app.js
  e.stopImmediatePropagation();
  e.preventDefault();
  if (Party.ctrlChannel && Party.ctrlChannel.readyState === "open") {
    Party.ctrlChannel.send(JSON.stringify({ type: "party-stop" }));
  }
  handlePartyStopRequest();
  showToast("Reprodução encerrada para os dois");
}, true); // fase de captura — roda antes do listener original do app.js

["playBtn", "fpPlayBtn"].forEach((id) => {
  const btn = document.getElementById(id);
  if (!btn) return;
  btn.addEventListener("click", (e) => {
    if (Party.connected && Party.activeSide === "peer") {
      e.stopImmediatePropagation();
      e.preventDefault();
      requestRemoteToggle();
    }
  }, true); // fase de captura — roda ANTES do listener original do app.js
});

/* Intercepta o arrastar da barra de progresso quando a faixa ativa é a
   do amigo, e manda um pedido de "pular pra esse ponto" em vez de mexer
   no MEU currentTime (que não tem efeito nenhum, já que quem realmente
   está com o arquivo é o outro lado). */
function bindRemoteSeekOverride(barId) {
  const bar = document.getElementById(barId);
  if (!bar) return;
  let dragging = false;

  function apply(clientX) {
    const rect = bar.getBoundingClientRect();
    const pct = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width));
    const dur = (Party.peerAudio && Party.peerAudio.duration) || 0;
    if (!dur) return;
    const time = pct * dur;
    mirrorProgressToUI(time, dur); // reflete na hora, sem esperar a resposta
    if (Party.ctrlChannel && Party.ctrlChannel.readyState === "open") {
      Party.ctrlChannel.send(JSON.stringify({ type: "remote-seek-request", time }));
    }
  }

  bar.addEventListener("mousedown", (e) => {
    if (!(Party.connected && Party.activeSide === "peer")) return; // deixa o comportamento normal do app.js
    e.stopImmediatePropagation();
    e.preventDefault();
    dragging = true;
    apply(e.clientX);
  }, true);

  window.addEventListener("mousemove", (e) => { if (dragging) apply(e.clientX); });
  window.addEventListener("mouseup", () => { dragging = false; });
}
bindRemoteSeekOverride("seekBar");
bindRemoteSeekOverride("fpSeekBar");

/* ============================================================
   ENCERRAR
============================================================ */
function leaveParty() {
  if (Party.ws) {
    try { Party.ws.send(JSON.stringify({ type: "leave" })); } catch (e) {}
    Party.ws.close();
  }
  teardownConnection(true);
}

function teardownConnection(fullReset) {
  if (Party.pc) { Party.pc.close(); Party.pc = null; }
  Party.ctrlChannel = null;
  Party.fileChannel = null;
  Party.connected = false;
  Party.activeTrackMeta = null;
  Party.isPlaying = false;
  Party.loading = null;
  Party.transferProgress = null;
  Party.activeSide = "me";
  Party.sentTrackIds.clear();
  Party.sentCoverTrackIds.clear();
  for (const url of Party.receivedFiles.values()) URL.revokeObjectURL(url);
  Party.receivedFiles.clear();
  for (const url of Party.receivedCovers.values()) URL.revokeObjectURL(url);
  Party.receivedCovers.clear();
  if (Party.peerAudio) { Party.peerAudio.pause(); Party.peerAudio.removeAttribute("src"); }
  if (fullReset) { Party.code = null; Party.role = null; Party.ws = null; }

  document.getElementById("miniplayer")?.classList.remove("party-active");
  document.getElementById("fullOverlay")?.classList.remove("party-active");

  // Volta o player a refletir a MINHA música local (se tiver alguma),
  // já que o mostrado até agora podia ser o do amigo.
  const t = typeof currentTrack === "function" ? currentTrack() : null;
  if (t && typeof showMiniplayerForTrack === "function") showMiniplayerForTrack(t);
  else if (!t) { const mp = document.getElementById("miniplayer"); if (mp) mp.style.display = "none"; }

  updatePartyUI();
}

/* ============================================================
   UI — modal de criar/entrar + botão de status no topbar
============================================================ */
function openPartyModal() {
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="partyModalBackdrop">
      <div class="modal">
        <h3>Ouvir Junto</h3>
        <p style="color:var(--text-dim);font-size:13px;margin:-8px 0 18px;">Ouçam a mesma música ao mesmo tempo, mesmo em PCs diferentes.</p>
        <div class="modal-actions" style="justify-content:center;gap:10px;margin-bottom:16px;">
          <button class="btn btn-primary" id="partyCreateBtn">Criar party</button>
          <button class="btn btn-ghost" id="partyJoinToggleBtn">Entrar com código</button>
        </div>
        <div id="partyJoinRow" class="party-join-row">
          <input type="text" id="partyCodeInput" class="party-join-input" placeholder="Código da party" maxlength="6" />
          <button class="btn btn-primary party-join-btn" id="partyJoinBtn">Entrar</button>
        </div>
        <div id="partyStatusArea" style="font-size:13.5px;line-height:1.6;"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="partyModalCloseBtn">Fechar</button>
        </div>
      </div>
    </div>`;

  document.getElementById("partyModalCloseBtn").addEventListener("click", () => { root.innerHTML = ""; });
  document.getElementById("partyModalBackdrop").addEventListener("click", (e) => { if (e.target.id === "partyModalBackdrop") root.innerHTML = ""; });

  document.getElementById("partyCreateBtn").addEventListener("click", async () => {
    document.getElementById("partyStatusArea").textContent = "Criando party...";
    try { await createParty(); }
    catch (e) { document.getElementById("partyStatusArea").textContent = "Não foi possível conectar ao servidor. Confira o SIGNALING_URL em sync.js e se a VPS está no ar."; }
  });

  document.getElementById("partyJoinToggleBtn").addEventListener("click", () => {
    document.getElementById("partyJoinRow").style.display = "flex";
    document.getElementById("partyCodeInput").focus();
  });

  document.getElementById("partyJoinBtn").addEventListener("click", async () => {
    const code = document.getElementById("partyCodeInput").value.trim();
    if (!code) return;
    document.getElementById("partyStatusArea").textContent = "Entrando...";
    try { await joinParty(code); }
    catch (e) { document.getElementById("partyStatusArea").textContent = "Não foi possível conectar ao servidor. Confira o SIGNALING_URL em sync.js e se a VPS está no ar."; }
  });

  updatePartyUI();
}

/* Um único botão no topbar (não dois!) que muda de cara conforme o
   estado: "Ouvir Junto" (desconectado) -> "● Conectado" (na party). */
function updatePartyButton() {
  const btn = document.getElementById("partyBtn");
  if (!btn) return;
  btn.classList.toggle("connected", Party.connected);
  if (Party.connected) {
    btn.innerHTML = `<span class="party-pulse-dot"></span> Conectado`;
  } else {
    btn.textContent = "Ouvir Junto";
  }
}

function updatePartyUI() {
  updatePartyButton();

  // O Discord Rich Presence (app.js) depende do estado da party pra saber
  // se mostra "Ouvindo Junto" e pra pegar a faixa certa quando ela é a do
  // amigo — então toda mudança relevante de estado (conectar/desconectar,
  // trocar de faixa, o amigo dar play/pause etc.) já passa por aqui, então
  // é o lugar certo pra reenviar a atividade também.
  if (typeof updateDiscordPresence === "function") updateDiscordPresence();

  const area = document.getElementById("partyStatusArea");
  if (area) {
    if (Party.connected) {
      area.innerHTML = `
        <div class="party-connected-card">
          <span class="party-pulse-dot"></span>
          <div>
            <div class="party-connected-title">Conectado</div>
            <div class="party-code-tag">código ${escapeHtml(Party.code || "")}</div>
          </div>
        </div>
        <button class="btn btn-ghost" id="partyLeaveBtn" style="margin-top:12px;width:100%;">Sair da party</button>`;
      const leaveBtn = document.getElementById("partyLeaveBtn");
      if (leaveBtn) leaveBtn.addEventListener("click", () => { leaveParty(); document.getElementById("modalRoot").innerHTML = ""; });
    } else if (Party.code && Party.role === "host") {
      area.innerHTML = `
        <div class="party-code-card">
          <div class="party-code-label">Código da party</div>
          <div class="party-code-value">${escapeHtml(Party.code)}</div>
          <div class="party-code-hint">Manda esse código pro seu amigo. Aguardando ele entrar...</div>
        </div>`;
    } else if (Party.code && Party.role === "guest") {
      area.innerHTML = `
        <div class="party-code-card">
          <div class="party-code-hint" style="margin-top:0;">Conectando com o host...</div>
        </div>`;
    } else {
      area.innerHTML = "";
    }
  }
}

document.getElementById("partyBtn")?.addEventListener("click", openPartyModal);

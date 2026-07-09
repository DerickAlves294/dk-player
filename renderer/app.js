/* ============================================================
   UTILITIES
============================================================ */
function uid(){ return Math.random().toString(36).slice(2)+Date.now().toString(36); }
function fmtTime(s){
  if(!isFinite(s) || s<0) s=0;
  const m=Math.floor(s/60), sec=Math.floor(s%60);
  return m+":"+String(sec).padStart(2,"0");
}
function escapeHtml(str){
  return String(str||"").replace(/[&<>"']/g, c=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"}[c]));
}
/* Normalizes text for search: strips accents AND "fancy" unicode fonts
   (script/bold/italic letters, fullwidth characters, etc). Those special
   fonts are different unicode code points than normal letters, so a plain
   .toLowerCase() search never matches them — NFKD decomposition maps them
   back to plain Latin letters, which is what fixes it. */
function normalizeForSearch(str){
  return String(str||"")
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase();
}
function placeholderDiscSVG(size){
  return `<svg class="placeholder-disc" viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
    <rect width="100" height="100" fill="#1C2027"/>
    <circle cx="50" cy="50" r="38" fill="none" stroke="#2A2F38" stroke-width="1.5"/>
    <circle cx="50" cy="50" r="30" fill="none" stroke="#2A2F38" stroke-width="1"/>
    <circle cx="50" cy="50" r="22" fill="none" stroke="#2A2F38" stroke-width="1"/>
    <circle cx="50" cy="50" r="13" fill="#E8B04B"/>
    <circle cx="50" cy="50" r="4" fill="#0B0D10"/>
  </svg>`;
}
function artHtml(track, cls){
  cls = cls||"";
  if(track && track.coverUrl){
    return `<img src="${track.coverUrl}" alt="" class="${cls}"/>`;
  }
  return placeholderDiscSVG();
}
function playlistArtHtml(p, tracks){
  if(p.image) return `<img src="${p.image}"/>`;
  if(tracks.length < 4) return artHtml(tracks[0]);
  return `<div class="playlist-mosaic">` + tracks.slice(0,4).map(t=>`<div class="mosaic-cell">${artHtml(t)}</div>`).join("") + `</div>`;
}

/* ============================================================
   STORAGE — uses the browser's own localStorage since this app
   runs as a standalone local file/tab, not inside claude.ai
============================================================ */
const STORAGE_PREFIX = "tonica:";
const Store = {
  async get(key){
    try{
      const raw = localStorage.getItem(STORAGE_PREFIX+key);
      return raw ? JSON.parse(raw) : null;
    }catch(e){ console.warn("storage get failed", e); return null; }
  },
  async set(key, value){
    try{ localStorage.setItem(STORAGE_PREFIX+key, JSON.stringify(value)); }
    catch(e){ console.warn("storage set failed", e); }
  }
};

/* ============================================================
   TOAST — small feedback message for actions like "adicionado à playlist"
============================================================ */
function showToast(msg){
  const root = document.getElementById("toastRoot");
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = msg;
  root.appendChild(el);
  setTimeout(()=> el.remove(), 2500);
}

/* ============================================================
   ID3 TAG PARSING (basic v2, enough for TIT2/TPE1/TALB/APIC)
   Reads bytes through window.dkAPI (backed by Node's fs in the main
   process) instead of a browser File object.
============================================================ */
function readSynchsafe(bytes, offset){
  return ((bytes[offset]&0x7f)<<21)|((bytes[offset+1]&0x7f)<<14)|((bytes[offset+2]&0x7f)<<7)|(bytes[offset+3]&0x7f);
}
function decodeText(bytes, encoding){
  // encoding: 0 latin1, 1 utf16 (BOM), 2 utf16BE, 3 utf8
  try{
    if(encoding===0 || encoding===3){
      return new TextDecoder(encoding===0?"iso-8859-1":"utf-8").decode(bytes).replace(/\0+$/,"");
    } else {
      return new TextDecoder("utf-16").decode(bytes).replace(/\0+$/,"");
    }
  }catch(e){ return ""; }
}
async function parseID3(filePath){
  const meta = {title:null, artist:null, album:null, coverUrl:null};
  try{
    const head = await window.dkAPI.readFileRange(filePath, 0, 10);
    if(head.length<10 || String.fromCharCode(head[0],head[1],head[2]) !== "ID3") return meta;
    const size = readSynchsafe(head,6);
    const buf = await window.dkAPI.readFileRange(filePath, 10, size);
    let off=0;
    while(off < buf.length-10){
      const id = String.fromCharCode(buf[off],buf[off+1],buf[off+2],buf[off+3]);
      if(id==="\0\0\0\0") break;
      const frameSize = (buf[off+4]<<24)|(buf[off+5]<<16)|(buf[off+6]<<8)|buf[off+7];
      if(frameSize<=0 || off+10+frameSize>buf.length) break;
      const frameData = buf.slice(off+10, off+10+frameSize);
      if(id==="TIT2") meta.title = decodeText(frameData.slice(1), frameData[0]);
      else if(id==="TPE1") meta.artist = decodeText(frameData.slice(1), frameData[0]);
      else if(id==="TALB") meta.album = decodeText(frameData.slice(1), frameData[0]);
      else if(id==="APIC"){
        try{
          const enc = frameData[0];
          let p=1;
          let mimeEnd=p;
          while(frameData[mimeEnd]!==0 && mimeEnd<frameData.length) mimeEnd++;
          const mime = decodeText(frameData.slice(p,mimeEnd),0) || "image/jpeg";
          p = mimeEnd+1;
          p += 1; // picture type byte
          let descEnd=p;
          if(enc===0||enc===3){ while(frameData[descEnd]!==0 && descEnd<frameData.length) descEnd++; descEnd+=1; }
          else { while(!(frameData[descEnd]===0 && frameData[descEnd+1]===0) && descEnd<frameData.length) descEnd++; descEnd+=2; }
          const imgBytes = frameData.slice(descEnd);
          const blob = new Blob([imgBytes], {type:mime});
          meta.coverUrl = URL.createObjectURL(blob);
        }catch(e){ /* ignore cover parse errors */ }
      }
      off += 10+frameSize;
    }
  }catch(e){ /* not a valid/parsable id3 tag, fall back to filename */ }
  return meta;
}
function parseFromFilename(name){
  const base = name.replace(/\.[^.]+$/,"");
  const parts = base.split(" - ");
  if(parts.length>=2){
    return {title:parts.slice(1).join(" - ").trim(), artist:parts[0].trim()};
  }
  return {title:base.trim(), artist:null};
}

/* ============================================================
   APP STATE
============================================================ */
const S = {
  libraryPath:null,   // absolute path to the music folder, persisted via window.dkAPI
  tracks:[],          // {id,name,path,title,artist,album,coverUrl}
  view:"all",         // all | artists | albums | playlists | artist-detail | album-detail | playlist-detail
  detailKey:null,      // artist name / album name / playlist id currently open
  search:"",
  playlists:[],        // {id,name,image,trackIds:[]}
  artistOrder:{},       // {artistName: [trackId, ...]} — ordem custom definida pelo usuário na tela do artista
  queue:[],             // array of track ids (ordem que está tocando de fato)
  unshuffledQueue:[],   // mesma fila, mas na ordem "natural" (pré-embaralho) — guardada
                         // pra poder restaurar quando o modo aleatório é desligado
  queueIndex:-1,
  shuffle:false,
  repeat:"off",        // off | all | one
  volume:0.9,
  isPlaying:false,
  appVersion:null,
};

const audio = document.getElementById("audio");
audio.volume = S.volume;

function trackById(id){ return S.tracks.find(t=>t.id===id); }
function currentTrack(){ return trackById(S.queue[S.queueIndex]); }

/* ============================================================
   PERSISTENCE
============================================================ */
let saveTimer=null;
function schedulePlaybackSave(){
  clearTimeout(saveTimer);
  saveTimer = setTimeout(savePlaybackState, 900);
}
async function savePlaybackState(){
  await Store.set("playback-state", {
    volume:S.volume, shuffle:S.shuffle, repeat:S.repeat,
    queueIds:S.queue, queueIndex:S.queueIndex, unshuffledQueueIds:S.unshuffledQueue,
    lastTrackId: currentTrack() ? currentTrack().id : null,
    lastPosition: audio.currentTime||0,
  });
}
async function loadPlaybackState(){
  const st = await Store.get("playback-state");
  if(!st) return;
  S.volume = typeof st.volume==="number"? st.volume : 0.9;
  S.shuffle = !!st.shuffle;
  S.repeat = st.repeat || "off";
  audio.volume = S.volume;
  return st;
}
async function savePlaylists(){
  await Store.set("playlists", S.playlists);
}
async function loadPlaylists(){
  const pl = await Store.get("playlists");
  S.playlists = Array.isArray(pl) ? pl : [];
}

/* ============================================================
   ORDEM CUSTOM DAS MÚSICAS NA TELA DE CADA ARTISTA
   (mesma ideia da ordem de faixas em playlists, mas guardada por nome
   de artista em vez de por playlist)
============================================================ */
async function saveArtistOrder(){
  await Store.set("artistOrder", S.artistOrder);
}
async function loadArtistOrder(){
  const o = await Store.get("artistOrder");
  S.artistOrder = (o && typeof o==="object" && !Array.isArray(o)) ? o : {};
}
/* Retorna as faixas do artista na ordem custom salva (se existir); faixas
   novas que ainda não têm posição salva aparecem no final, na ordem em
   que vieram. */
function orderedArtistTracks(artist, tracks){
  const order = S.artistOrder[artist];
  if(!order || !order.length) return tracks;
  const map = new Map(tracks.map(t=>[t.id,t]));
  const ordered = order.map(id=>map.get(id)).filter(Boolean);
  const knownIds = new Set(order);
  const newOnes = tracks.filter(t=>!knownIds.has(t.id));
  return [...ordered, ...newOnes];
}
function ensureArtistOrder(artist, tracksInCurrentOrder){
  if(!S.artistOrder[artist]) S.artistOrder[artist] = tracksInCurrentOrder.map(t=>t.id);
  return S.artistOrder[artist];
}
async function moveArtistTrack(artist, index, dir){
  const tracks = orderedArtistTracks(artist, S.tracks.filter(t=>t.artist===artist));
  const order = ensureArtistOrder(artist, tracks);
  const newIndex = index+dir;
  if(newIndex<0 || newIndex>=order.length) return;
  [order[index], order[newIndex]] = [order[newIndex], order[index]];
  await saveArtistOrder();
  render();
}
async function reorderArtistTrack(artist, from, to){
  const tracks = orderedArtistTracks(artist, S.tracks.filter(t=>t.artist===artist));
  const order = ensureArtistOrder(artist, tracks);
  if(from===to || isNaN(from) || isNaN(to)) return;
  const [moved] = order.splice(from,1);
  order.splice(to,0,moved);
  await saveArtistOrder();
  render();
}

/* ============================================================
   FOLDER SCAN — folder contents are listed by the main process
   (window.dkAPI.scanFolder), which has direct Node fs access.
   No browser permission prompts exist in this world at all.
============================================================ */
let scanInFlight = null;
function scanDirectory(){
  // guard against overlapping scans (e.g. the folder picker closing fires a
  // window "focus" event almost simultaneously with our own explicit scan,
  // which previously caused every track to be added twice)
  if(scanInFlight) return scanInFlight;
  scanInFlight = scanDirectoryImpl().finally(()=>{ scanInFlight = null; });
  return scanInFlight;
}
async function scanDirectoryImpl(){
  if(!S.libraryPath) return;
  let found = [];
  try{
    found = await window.dkAPI.scanFolder(S.libraryPath); // [{name, path}]
  }catch(e){ console.warn("scan failed", e); }

  const existingIds = new Set(S.tracks.map(t=>t.id));
  const newIds = new Set(found.map(f=>f.name));

  // remove tracks whose file no longer exists
  S.tracks = S.tracks.filter(t=>newIds.has(t.id));

  // add newly discovered files
  for(const f of found){
    if(existingIds.has(f.name)) continue;
    const id3 = await parseID3(f.path);
    const fromName = parseFromFilename(f.name);
    S.tracks.push({
      id: f.name,
      name: f.name,
      path: f.path,
      title: id3.title || fromName.title || f.name,
      artist: id3.artist || fromName.artist || "Artista desconhecido",
      album: id3.album || "Álbum desconhecido",
      coverUrl: id3.coverUrl || null,
    });
  }
  S.tracks.sort((a,b)=>a.title.localeCompare(b.title,"pt-BR"));

  // clean dangling queue / playlist references
  const validIds = new Set(S.tracks.map(t=>t.id));
  S.queue = S.queue.filter(id=>validIds.has(id));
  if(S.queueIndex>=S.queue.length) S.queueIndex = S.queue.length-1;
  S.playlists.forEach(p=> p.trackIds = p.trackIds.filter(id=>validIds.has(id)));
  Object.keys(S.artistOrder).forEach(artist=>{
    S.artistOrder[artist] = S.artistOrder[artist].filter(id=>validIds.has(id));
  });

  updateStatusPill();
  render();
  renderQueue();
}

function updateStatusPill(){
  const dot = document.querySelector("#statusPill .status-dot");
  const txt = document.getElementById("statusText");
  const changeBtn = document.getElementById("changeFolderBtn");
  if(S.libraryPath){
    dot.classList.add("ok");
    txt.textContent = `${window.dkAPI.basename(S.libraryPath)} · ${S.tracks.length} ${S.tracks.length===1?"música":"músicas"}`;
    changeBtn.style.display = "inline-block";
  } else {
    dot.classList.remove("ok");
    txt.textContent = "Nenhuma pasta selecionada";
    changeBtn.style.display = "none";
  }
}

/* Lets the user point the app at a different folder at any time */
async function changeFolder(){
  const folderPath = await window.dkAPI.pickFolder();
  if(!folderPath) return; // user cancelled
  S.libraryPath = folderPath;
  S.tracks = [];
  await window.dkAPI.setLastFolder(folderPath);
  await scanDirectory();
  showToast(`Pasta "${window.dkAPI.basename(folderPath)}" conectada`);
}
document.getElementById("changeFolderBtn").addEventListener("click", changeFolder);

/* Re-scan whenever the user returns to the app, to reflect files added/removed externally */
document.addEventListener("visibilitychange", ()=>{
  if(document.visibilityState==="visible" && S.libraryPath) scanDirectory();
});
window.addEventListener("focus", ()=>{ if(S.libraryPath) scanDirectory(); });

/* ============================================================
   ADD MUSIC — folder picker (first time) / copy files in (after)
============================================================ */
document.getElementById("addMusicBtn").addEventListener("click", async ()=>{
  if(!S.libraryPath){
    await changeFolder();
    return;
  }
  // folder already chosen: let the user pick audio files, then copy them into the library folder
  const files = await window.dkAPI.pickAudioFiles();
  if(!files || !files.length) return; // user cancelled
  const copied = await window.dkAPI.copyFilesIntoFolder(files, S.libraryPath);
  await scanDirectory();
  if(copied.length){
    showToast(copied.length===1 ? "1 música adicionada" : `${copied.length} músicas adicionadas`);
  } else {
    showToast("Não foi possível copiar os arquivos para a pasta.");
  }
});

/* ============================================================
   INITIAL LOAD
============================================================ */
async function init(){
  await loadPlaylists();
  await loadArtistOrder();
  const st = await loadPlaybackState();
  updateShuffleRepeatUI();
  setVolumeUI(S.volume);

  window.dkAPI.getAppVersion().then(v=>{
    S.appVersion = v;
    const tag = document.getElementById("sidebarVersionTag");
    if(tag) tag.textContent = "v"+v;
  }).catch(()=>{});

  // Electron apps get direct filesystem access — no permission dance,
  // no "click to reconnect" screen. We just verify the remembered folder
  // still exists (it may have been moved/deleted) and pick right back up.
  const lastFolder = await window.dkAPI.getLastFolder();
  if(lastFolder){
    S.libraryPath = lastFolder;
    await scanDirectory();
  }
  updateStatusPill();
  render();

  if(st && st.queueIds && st.queueIds.length){
    S.queue = st.queueIds;
    S.unshuffledQueue = (st.unshuffledQueueIds && st.unshuffledQueueIds.length) ? st.unshuffledQueueIds : st.queueIds.slice();
    S.queueIndex = st.queueIndex ?? -1;
    renderQueue();
    // don't auto-play on load; just prep so the mini player can show last track info
    const t = trackById(st.lastTrackId);
    if(t){ showMiniplayerForTrack(t); }
  }
}

/* ============================================================
   RENDERING — sidebar
============================================================ */
function renderSidebar(){
  document.querySelectorAll(".nav-item").forEach(el=>{
    el.classList.toggle("active", el.dataset.view===S.view);
  });
  const list = document.getElementById("playlistNavList");
  list.innerHTML = S.playlists.map(p=>`
    <button class="playlist-nav-item ${S.view==="playlist-detail"&&S.detailKey===p.id?"active":""}" data-playlist-id="${p.id}">${escapeHtml(p.name)}</button>
  `).join("");
  list.querySelectorAll(".playlist-nav-item").forEach(el=>{
    el.addEventListener("click", ()=>{
      S.view="playlist-detail"; S.detailKey=el.dataset.playlistId; render();
    });
  });
}

document.querySelectorAll(".nav-item[data-view]").forEach(el=>{
  el.addEventListener("click", ()=>{ S.view = el.dataset.view; S.detailKey=null; render(); });
});
document.getElementById("newPlaylistBtn").addEventListener("click", ()=> openPlaylistModal(null));

/* ============================================================
   RENDERING — main content
============================================================ */
function filteredTracks(list){
  const q = normalizeForSearch(S.search.trim());
  if(!q) return list;
  return list.filter(t=>
    normalizeForSearch(t.title).includes(q) ||
    normalizeForSearch(t.artist).includes(q) ||
    normalizeForSearch(t.album).includes(q)
  );
}

function trackCardHtml(t){
  const isPlaying = currentTrack() && currentTrack().id===t.id;
  return `
  <div class="card ${isPlaying?"playing":""}" data-track-id="${t.id}">
    <div class="card-art">
      ${artHtml(t)}
      <button class="card-menu-btn" data-menu-track="${t.id}">
        <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg>
      </button>
      <div class="art-overlay">
        <button class="card-play-btn" data-play-track="${t.id}">
          <svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg>
        </button>
      </div>
    </div>
    <div class="card-title">${escapeHtml(t.title)}</div>
    <div class="card-sub">${escapeHtml(t.artist)}</div>
  </div>`;
}

function groupBy(tracks, key){
  const map = new Map();
  tracks.forEach(t=>{
    const k = t[key];
    if(!map.has(k)) map.set(k, []);
    map.get(k).push(t);
  });
  return map;
}

function emptyStateHtml(kind){
  const msgs = {
    all: ["Sua biblioteca está vazia","Clique em “Adicionar músicas” para escolher a pasta onde ficam seus arquivos de áudio. Tudo o que estiver lá aparece aqui automaticamente."],
    search: ["Nada encontrado","Tente buscar por outro nome de música, artista ou álbum."],
    playlist: ["Playlist vazia","Adicione músicas a partir do menu (⋯) de qualquer card."],
  };
  const [h,p] = msgs[kind]||msgs.all;
  return `<div class="empty-state">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg>
    <h3>${h}</h3><p>${p}</p>
  </div>`;
}

function render(){
  renderSidebar();
  const content = document.getElementById("content");
  let html = "";

  if(S.view==="all"){
    const list = filteredTracks(S.tracks);
    html += `<div class="content-header"><div><div class="content-title">Todas as músicas</div><div class="content-sub">${S.tracks.length} faixas</div></div></div>`;
    html += list.length ? `<div class="grid">${list.map(trackCardHtml).join("")}</div>` : emptyStateHtml(S.tracks.length?"search":"all");
  }
  else if(S.view==="artists"){
    const groups = groupBy(filteredTracks(S.tracks), "artist");
    html += `<div class="content-header"><div class="content-title">Artistas</div></div>`;
    if(groups.size){
      html += `<div class="grid">`+ [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0],"pt-BR")).map(([artist,tracks])=>`
        <div class="group-card" data-artist="${escapeHtml(artist)}">
          <div class="group-art">${artHtml(tracks.find(t=>t.coverUrl))}</div>
          <div class="group-name">${escapeHtml(artist)}</div>
          <div class="group-count">${tracks.length} ${tracks.length===1?"música":"músicas"}</div>
        </div>`).join("") + `</div>`;
    } else html += emptyStateHtml("all");
  }
  else if(S.view==="albums"){
    const groups = groupBy(filteredTracks(S.tracks), "album");
    html += `<div class="content-header"><div class="content-title">Álbuns</div></div>`;
    if(groups.size){
      html += `<div class="grid">`+ [...groups.entries()].sort((a,b)=>a[0].localeCompare(b[0],"pt-BR")).map(([album,tracks])=>`
        <div class="group-card" data-album="${escapeHtml(album)}">
          <div class="group-art square">${artHtml(tracks.find(t=>t.coverUrl))}</div>
          <div class="group-name">${escapeHtml(album)}</div>
          <div class="group-count">${tracks.length} ${tracks.length===1?"música":"músicas"}</div>
        </div>`).join("") + `</div>`;
    } else html += emptyStateHtml("all");
  }
  else if(S.view==="artist-detail"){
    const rawTracks = S.tracks.filter(t=>t.artist===S.detailKey);
    const tracks = filteredTracks(orderedArtistTracks(S.detailKey, rawTracks));
    html += `<button class="back-link" id="backBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>Artistas</button>`;
    html += `<div class="content-header"><div><div class="content-title">${escapeHtml(S.detailKey)}</div><div class="content-sub">${tracks.length} faixas</div></div></div>`;
    html += tracks.length ? trackRowsHtml(tracks, {artistKey:S.detailKey, reorderable: !S.search.trim()}) : emptyStateHtml("all");
  }
  else if(S.view==="album-detail"){
    const tracks = filteredTracks(S.tracks.filter(t=>t.album===S.detailKey));
    html += `<button class="back-link" id="backBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>Álbuns</button>`;
    html += `<div class="content-header"><div><div class="content-title">${escapeHtml(S.detailKey)}</div><div class="content-sub">${tracks.length} faixas</div></div></div>`;
    html += tracks.length ? trackRowsHtml(tracks) : emptyStateHtml("all");
  }
  else if(S.view==="playlists"){
    html += `<div class="content-header"><div class="content-title">Playlists</div></div>`;
    if(S.playlists.length){
      html += `<div class="grid">`+ S.playlists.map(p=>{
        const tracks = p.trackIds.map(id=>trackById(id)).filter(Boolean);
        return `<div class="group-card" data-open-playlist="${p.id}">
          <div class="group-art square">${playlistArtHtml(p, tracks)}</div>
          <div class="group-name">${escapeHtml(p.name)}</div>
          <div class="group-count">${tracks.length} ${tracks.length===1?"música":"músicas"}</div>
        </div>`;
      }).join("") + `</div>`;
    } else {
      html += `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><h3>Nenhuma playlist ainda</h3><p>Crie uma playlist na barra lateral para organizar suas músicas.</p></div>`;
    }
  }
  else if(S.view==="playlist-detail"){
    const p = S.playlists.find(pl=>pl.id===S.detailKey);
    if(!p){ S.view="playlists"; return render(); }
    const tracks = filteredTracks(p.trackIds.map(id=>trackById(id)).filter(Boolean));
    html += `<button class="back-link" id="backBtn"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="m15 18-6-6 6-6"/></svg>Playlists</button>`;
    html += `<div class="content-header">
      <div><div class="content-title">${escapeHtml(p.name)}</div><div class="content-sub">${tracks.length} faixas</div></div>
      <div style="display:flex;gap:8px;">
        <button class="btn btn-ghost" id="renamePlaylistBtn">Renomear</button>
        <button class="btn btn-ghost" id="deletePlaylistBtn" style="color:var(--danger)">Excluir</button>
      </div>
    </div>`;
    html += tracks.length ? trackRowsHtml(tracks, {playlistId:p.id, reorderable: !S.search.trim()}) : emptyStateHtml("playlist");
  }

  content.innerHTML = html;
  attachContentEvents();
}

/* opts: {playlistId, artistKey, reorderable}
   playlistId -> reordenação persiste em S.playlists (e habilita "remover da
   playlist" no clique direito); artistKey -> persiste em S.artistOrder. */
function trackRowsHtml(tracks, opts){
  opts = opts || {};
  const reorderable = !!opts.reorderable;
  const reorderType = opts.playlistId ? "playlist" : (opts.artistKey ? "artist" : "");
  const reorderKey = opts.playlistId || opts.artistKey || "";
  return `<div class="track-rows">` + tracks.map((t,i)=>{
    const isPlaying = currentTrack() && currentTrack().id===t.id;
    return `
    <div class="track-row ${isPlaying?"playing":""} ${reorderable?"reorderable":""}" data-track-id="${t.id}" data-playlist-context="${opts.playlistId||""}" ${reorderable?`draggable="true" data-row-index="${i}" data-reorder-type="${reorderType}" data-reorder-key="${escapeHtml(reorderKey)}"`:""}>
      <div class="idx"><span class="row-num">${i+1}</span><span class="row-play-icon"><svg viewBox="0 0 24 24" fill="currentColor"><path d="M8 5v14l11-7z"/></svg></span></div>
      <div class="row-art">${artHtml(t)}</div>
      <div class="row-title">${escapeHtml(t.title)}</div>
      <div class="row-meta">${escapeHtml(t.artist)} · ${escapeHtml(t.album)}</div>
      <div class="row-dur"></div>
      ${reorderable ? `
      <div class="row-actions" draggable="false">
        <button class="row-up" data-move-row="${i}" data-dir="-1" ${i===0?"disabled":""} title="Mover para cima"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 15 6-6 6 6"/></svg></button>
        <button class="row-down" data-move-row="${i}" data-dir="1" ${i===tracks.length-1?"disabled":""} title="Mover para baixo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></button>
        <button class="row-menu" data-menu-track="${t.id}"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>
      </div>` : `
      <button class="row-menu" data-menu-track="${t.id}"><svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="12" cy="19" r="1.6"/></svg></button>`}
    </div>`;
  }).join("") + `</div>`;
}
async function movePlaylistTrack(playlistId, index, dir){
  const p = S.playlists.find(pl=>pl.id===playlistId);
  if(!p) return;
  const newIndex = index+dir;
  if(newIndex<0 || newIndex>=p.trackIds.length) return;
  [p.trackIds[index], p.trackIds[newIndex]] = [p.trackIds[newIndex], p.trackIds[index]];
  await savePlaylists();
  render();
}
async function reorderPlaylistTrack(playlistId, from, to){
  const p = S.playlists.find(pl=>pl.id===playlistId);
  if(!p || from===to || isNaN(from) || isNaN(to)) return;
  const [moved] = p.trackIds.splice(from,1);
  let insertAt = to;
  if(from<to) insertAt = to;
  p.trackIds.splice(insertAt,0,moved);
  await savePlaylists();
  render();
}
/* Roteia pro tipo certo de reordenação (playlist ou artista) com base no
   contexto salvo em data-reorder-type/data-reorder-key na linha clicada. */
function moveOrderedTrack(type, key, index, dir){
  if(type==="playlist") return movePlaylistTrack(key, index, dir);
  if(type==="artist") return moveArtistTrack(key, index, dir);
}
function reorderOrderedTrack(type, key, from, to){
  if(type==="playlist") return reorderPlaylistTrack(key, from, to);
  if(type==="artist") return reorderArtistTrack(key, from, to);
}

function attachContentEvents(){
  const content = document.getElementById("content");

  content.querySelectorAll("[data-play-track]").forEach(el=>{
    el.addEventListener("click", e=>{ e.stopPropagation(); playTrackFromContext(el.dataset.playTrack); });
  });
  content.querySelectorAll(".card[data-track-id]").forEach(el=>{
    el.addEventListener("click", ()=> playTrackFromContext(el.dataset.trackId));
  });
  content.querySelectorAll(".track-row[data-track-id]").forEach(el=>{
    el.addEventListener("click", (e)=>{
      if(e.target.closest(".row-actions") || e.target.closest(".row-menu")) return;
      playTrackFromContext(el.dataset.trackId);
    });
  });
  content.querySelectorAll("[data-menu-track]").forEach(el=>{
    el.addEventListener("click", e=>{ e.stopPropagation(); openTrackMenu(e, el.dataset.menuTrack); });
  });
  content.querySelectorAll("[data-move-row]").forEach(el=>{
    el.addEventListener("click", e=>{
      e.stopPropagation();
      const row = el.closest(".track-row");
      moveOrderedTrack(row.dataset.reorderType, row.dataset.reorderKey, parseInt(el.dataset.moveRow,10), parseInt(el.dataset.dir,10));
    });
  });
  content.querySelectorAll(".track-row.reorderable").forEach(el=>{
    el.addEventListener("dragstart", e=>{ e.dataTransfer.setData("text/plain", el.dataset.rowIndex); });
    el.addEventListener("dragover", e=>{ e.preventDefault(); el.classList.add("drag-over"); });
    el.addEventListener("dragleave", ()=> el.classList.remove("drag-over"));
    el.addEventListener("drop", e=>{
      e.preventDefault(); el.classList.remove("drag-over");
      const from = parseInt(e.dataTransfer.getData("text/plain"),10);
      const to = parseInt(el.dataset.rowIndex,10);
      reorderOrderedTrack(el.dataset.reorderType, el.dataset.reorderKey, from, to);
    });
  });
  content.querySelectorAll("[data-artist]").forEach(el=>{
    el.addEventListener("click", ()=>{ S.view="artist-detail"; S.detailKey=el.dataset.artist; render(); });
  });
  content.querySelectorAll("[data-album]").forEach(el=>{
    el.addEventListener("click", ()=>{ S.view="album-detail"; S.detailKey=el.dataset.album; render(); });
  });
  content.querySelectorAll("[data-open-playlist]").forEach(el=>{
    el.addEventListener("click", ()=>{ S.view="playlist-detail"; S.detailKey=el.dataset.openPlaylist; render(); });
  });
  const back = content.querySelector("#backBtn");
  if(back) back.addEventListener("click", ()=>{
    if(S.view==="artist-detail") S.view="artists";
    else if(S.view==="album-detail") S.view="albums";
    else if(S.view==="playlist-detail") S.view="playlists";
    S.detailKey=null; render();
  });
  const renameBtn = content.querySelector("#renamePlaylistBtn");
  if(renameBtn) renameBtn.addEventListener("click", ()=> openPlaylistModal(S.detailKey));
  const deleteBtn = content.querySelector("#deletePlaylistBtn");
  if(deleteBtn) deleteBtn.addEventListener("click", async ()=>{
    const removed = S.playlists.find(p=>p.id===S.detailKey);
    S.playlists = S.playlists.filter(p=>p.id!==S.detailKey);
    await savePlaylists();
    S.view="playlists"; S.detailKey=null; render();
    if(removed) showToast(`Playlist "${removed.name}" excluída`);
  });
}

/* Playing a track: builds a queue from the current visible context (all songs / artist / album / playlist) */
function playTrackFromContext(trackId){
  let contextTracks;
  if(S.view==="all") contextTracks = filteredTracks(S.tracks);
  else if(S.view==="artist-detail") contextTracks = orderedArtistTracks(S.detailKey, S.tracks.filter(t=>t.artist===S.detailKey));
  else if(S.view==="album-detail") contextTracks = S.tracks.filter(t=>t.album===S.detailKey);
  else if(S.view==="playlist-detail"){
    const p = S.playlists.find(pl=>pl.id===S.detailKey);
    contextTracks = p.trackIds.map(id=>trackById(id)).filter(Boolean);
  } else contextTracks = S.tracks;

  S.queue = contextTracks.map(t=>t.id);
  S.unshuffledQueue = S.queue.slice();
  S.queueIndex = S.queue.indexOf(trackId);
  if(S.shuffle) shuffleQueueKeepingCurrent();
  loadAndPlay(S.queueIndex);
  renderQueue();
}

function shuffleQueueKeepingCurrent(){
  // Se nada estiver tocando (fila vazia ou nenhum índice atual), não há
  // "atual" pra manter na frente — embaralhar aqui geraria uma fila com um
  // item "undefined" na primeira posição. Nesse caso só marcamos o modo
  // aleatório; a fila real é montada (já embaralhada) quando o usuário
  // tocar uma música, em playTrackFromContext().
  if(S.queueIndex<0 || S.queueIndex>=S.queue.length) return;
  const current = S.queue[S.queueIndex];
  const rest = S.queue.filter((_,i)=>i!==S.queueIndex);
  for(let i=rest.length-1;i>0;i--){
    const j = Math.floor(Math.random()*(i+1));
    [rest[i],rest[j]]=[rest[j],rest[i]];
  }
  S.queue = [current, ...rest];
  S.queueIndex = 0;
}

/* ============================================================
   PLAYBACK
============================================================ */
async function loadAndPlay(index){
  if(index<0 || index>=S.queue.length) return;
  S.queueIndex = index;
  const t = currentTrack();
  if(!t) return;
  // Streamed straight from disk by the main process through the custom
  // dkmedia:// protocol — no Blob URL / File object needed on this side.
  audio.src = window.dkAPI.mediaUrl(t.path);
  try{ await audio.play(); S.isPlaying = true; }catch(e){ S.isPlaying=false; }
  showMiniplayerForTrack(t);
  updatePlayButtons();
  render();
  renderQueue();
  schedulePlaybackSave();
}

function showMiniplayerForTrack(t){
  document.getElementById("miniplayer").style.display = "grid";
  document.getElementById("mpArt").innerHTML = artHtml(t);
  document.getElementById("mpArt").classList.toggle("spin", S.isPlaying);
  document.getElementById("mpTitle").textContent = t.title;
  document.getElementById("mpArtist").textContent = t.artist;
  document.getElementById("fpArt").innerHTML = artHtml(t);
  document.getElementById("fpTitle").textContent = t.title;
  document.getElementById("fpArtist").textContent = t.artist;
}

function togglePlay(){
  if(!currentTrack()) return;
  if(audio.paused){ audio.play(); S.isPlaying=true; }
  else { audio.pause(); S.isPlaying=false; }
  updatePlayButtons();
}
function updatePlayButtons(){
  const playSvg = '<path d="M8 5v14l11-7z"/>';
  const pauseSvg = '<rect x="6" y="5" width="4" height="14"/><rect x="14" y="5" width="4" height="14"/>';
  document.getElementById("playIcon").innerHTML = S.isPlaying?pauseSvg:playSvg;
  document.getElementById("fpPlayIcon").innerHTML = S.isPlaying?pauseSvg:playSvg;
  document.getElementById("mpArt").classList.toggle("spin", S.isPlaying);
}

function playNext(auto){
  if(S.repeat==="one" && auto){ audio.currentTime=0; audio.play(); return; }
  let next = S.queueIndex+1;
  if(next>=S.queue.length){
    if(S.repeat==="all") next=0;
    else { S.isPlaying=false; updatePlayButtons(); return; }
  }
  loadAndPlay(next);
}
function playPrev(){
  if(audio.currentTime>3){ audio.currentTime=0; return; }
  let prev = S.queueIndex-1;
  if(prev<0){ if(S.repeat==="all") prev=S.queue.length-1; else prev=0; }
  loadAndPlay(prev);
}

audio.addEventListener("ended", ()=> playNext(true));
audio.addEventListener("timeupdate", ()=>{
  const cur=audio.currentTime, dur=audio.duration||0;
  const pct = dur? (cur/dur*100):0;
  document.getElementById("seekFill").style.width=pct+"%";
  document.getElementById("seekHandle").style.left=pct+"%";
  document.getElementById("fpSeekFill").style.width=pct+"%";
  document.getElementById("fpSeekHandle").style.left=pct+"%";
  document.getElementById("curTime").textContent = fmtTime(cur);
  document.getElementById("durTime").textContent = fmtTime(dur);
  document.getElementById("fpCurTime").textContent = fmtTime(cur);
  document.getElementById("fpDurTime").textContent = fmtTime(dur);
});
audio.addEventListener("loadedmetadata", ()=>{
  document.getElementById("durTime").textContent = fmtTime(audio.duration);
  document.getElementById("fpDurTime").textContent = fmtTime(audio.duration);
});
audio.addEventListener("timeupdate", schedulePlaybackSave);
audio.addEventListener("pause", ()=>{ S.isPlaying=false; updatePlayButtons(); });
audio.addEventListener("play", ()=>{ S.isPlaying=true; updatePlayButtons(); });

function seekFromClientX(bar, clientX){
  const rect = bar.getBoundingClientRect();
  const pct = Math.min(1,Math.max(0,(clientX-rect.left)/rect.width));
  return pct;
}
function bindSeekBar(barId){
  const bar = document.getElementById(barId);
  let dragging=false;
  function apply(clientX){
    const pct = seekFromClientX(bar, clientX);
    if(audio.duration) audio.currentTime = pct*audio.duration;
  }
  bar.addEventListener("mousedown", e=>{ dragging=true; apply(e.clientX); });
  window.addEventListener("mousemove", e=>{ if(dragging) apply(e.clientX); });
  window.addEventListener("mouseup", ()=> dragging=false);
}
bindSeekBar("seekBar"); bindSeekBar("fpSeekBar");

function setVolumeUI(v){
  document.getElementById("volFill").style.width=(v*100)+"%";
  document.getElementById("volHandle").style.left=(v*100)+"%";
  document.getElementById("fpVolFill").style.width=(v*100)+"%";
  document.getElementById("fpVolHandle").style.left=(v*100)+"%";
}
function bindVolBar(barId){
  const bar = document.getElementById(barId);
  let dragging=false;
  function apply(clientX){
    const pct = seekFromClientX(bar, clientX);
    S.volume = pct; audio.volume = pct; setVolumeUI(pct); schedulePlaybackSave();
  }
  bar.addEventListener("mousedown", e=>{ dragging=true; apply(e.clientX); });
  window.addEventListener("mousemove", e=>{ if(dragging) apply(e.clientX); });
  window.addEventListener("mouseup", ()=> dragging=false);
}
bindVolBar("volBar"); bindVolBar("fpVolBar");

// Dois ícones diferentes pro botão de repetir: o mesmo loop de setas nos
// dois casos, mas "repetir a música atual" ganha um "1" no meio — assim dá
// pra diferenciar visualmente os dois estados (não só pela cor "ativo").
const REPEAT_ALL_ICON = `<path d="m17 2 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/>`;
const REPEAT_ONE_ICON = `<path d="m17 2 4 4-4 4M3 11V9a4 4 0 0 1 4-4h14M7 22l-4-4 4-4M21 13v2a4 4 0 0 1-4 4H3"/><text x="12" y="15.2" text-anchor="middle" font-size="8.5" font-weight="800" fill="currentColor" stroke="none" font-family="'Manrope',sans-serif">1</text>`;
function updateShuffleRepeatUI(){
  document.getElementById("shuffleBtn").classList.toggle("on", S.shuffle);
  document.getElementById("fpShuffleBtn").classList.toggle("on", S.shuffle);
  const icon = S.repeat==="one" ? REPEAT_ONE_ICON : REPEAT_ALL_ICON;
  [document.getElementById("repeatBtn"), document.getElementById("fpRepeatBtn")].forEach(btn=>{
    btn.classList.toggle("on", S.repeat!=="off");
    btn.title = S.repeat==="off"?"Repetir":S.repeat==="all"?"Repetir todas":"Repetir música atual";
    btn.querySelector("svg").innerHTML = icon;
  });
}
function toggleShuffle(){
  S.shuffle=!S.shuffle;
  if(S.shuffle){
    // guarda a ordem "natural" atual antes de embaralhar, pra poder
    // restaurar depois quando o usuário desligar o aleatório
    S.unshuffledQueue = S.queue.slice();
    shuffleQueueKeepingCurrent();
  } else {
    // desligar tem que voltar a fila pra ordem normal — antes isso não
    // acontecia, então a fila continuava embaralhada mesmo com o botão
    // apagado. A música que já está tocando não é mexida, só a ordem
    // das próximas músicas na fila.
    restoreUnshuffledQueue();
  }
  // Aplica e confirma imediatamente, sem depender de nenhuma outra ação
  // (como clicar numa música) pra "atualizar" — o clique sozinho já basta.
  updateShuffleRepeatUI();
  renderQueue();
  savePlaybackState();
  showToast(S.shuffle ? "Modo aleatório ativado" : "Modo aleatório desativado");
}
function restoreUnshuffledQueue(){
  const current = currentTrack();
  if(S.unshuffledQueue && S.unshuffledQueue.length){
    S.queue = S.unshuffledQueue.slice();
  }
  if(current){
    const idx = S.queue.indexOf(current.id);
    if(idx>=0) S.queueIndex = idx;
  }
}
function cycleRepeat(){
  S.repeat = S.repeat==="off"?"all":S.repeat==="all"?"one":"off";
  updateShuffleRepeatUI();
  savePlaybackState();
  const labels = {off:"Repetição desativada", all:"Repetindo todas as músicas", one:"Repetindo a música atual"};
  showToast(labels[S.repeat]);
}

document.getElementById("playBtn").addEventListener("click", togglePlay);
document.getElementById("fpPlayBtn").addEventListener("click", togglePlay);
document.getElementById("nextBtn").addEventListener("click", ()=>playNext(false));
document.getElementById("fpNextBtn").addEventListener("click", ()=>playNext(false));
document.getElementById("prevBtn").addEventListener("click", playPrev);
document.getElementById("fpPrevBtn").addEventListener("click", playPrev);
document.getElementById("shuffleBtn").addEventListener("click", toggleShuffle);
document.getElementById("fpShuffleBtn").addEventListener("click", toggleShuffle);
document.getElementById("repeatBtn").addEventListener("click", cycleRepeat);
document.getElementById("fpRepeatBtn").addEventListener("click", cycleRepeat);

/* Expand to full player */
document.getElementById("mpTrackInfo").addEventListener("click", ()=>{
  if(!currentTrack()) return;
  document.getElementById("fullOverlay").classList.add("show");
});
document.getElementById("fpClose").addEventListener("click", ()=> document.getElementById("fullOverlay").classList.remove("show"));
document.getElementById("fullOverlay").addEventListener("click", e=>{
  if(e.target.id==="fullOverlay") e.currentTarget.classList.remove("show");
});

/* ============================================================
   QUEUE PANEL
============================================================ */
function openQueuePanel(){ document.getElementById("queuePanel").classList.add("show"); }
function closeQueuePanel(){ document.getElementById("queuePanel").classList.remove("show"); }
document.getElementById("queueBtn").addEventListener("click", openQueuePanel);
document.getElementById("fpQueueBtn").addEventListener("click", openQueuePanel);
document.getElementById("queueCloseBtn").addEventListener("click", closeQueuePanel);

function renderQueue(){
  const list = document.getElementById("queueList");
  if(!S.queue.length){ list.innerHTML = `<div class="queue-empty">Sua fila está vazia.<br>Toque uma música para começar.</div>`; return; }
  list.innerHTML = S.queue.map((id,i)=>{
    const t = trackById(id);
    if(!t) return "";
    return `<div class="queue-item ${i===S.queueIndex?"current":""}" draggable="true" data-qindex="${i}">
      <svg class="qi-drag" viewBox="0 0 24 24" fill="currentColor"><circle cx="8" cy="6" r="1.4"/><circle cx="8" cy="12" r="1.4"/><circle cx="8" cy="18" r="1.4"/><circle cx="16" cy="6" r="1.4"/><circle cx="16" cy="12" r="1.4"/><circle cx="16" cy="18" r="1.4"/></svg>
      <div class="qi-art">${artHtml(t)}</div>
      <div class="qi-meta"><div class="qi-title">${escapeHtml(t.title)}</div><div class="qi-artist">${escapeHtml(t.artist)}</div></div>
      <div class="qi-actions">
        <button class="qi-up" data-move-qindex="${i}" data-dir="-1" ${i===0?"disabled":""} title="Mover para cima"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 15 6-6 6 6"/></svg></button>
        <button class="qi-down" data-move-qindex="${i}" data-dir="1" ${i===S.queue.length-1?"disabled":""} title="Mover para baixo"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.4"><path d="m6 9 6 6 6-6"/></svg></button>
        <button class="qi-remove" data-remove-qindex="${i}" title="Remover da fila"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg></button>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".queue-item").forEach(el=>{
    el.addEventListener("click", e=>{
      if(e.target.closest(".qi-actions")) return;
      loadAndPlay(parseInt(el.dataset.qindex,10));
    });
    el.addEventListener("dragstart", e=>{ e.dataTransfer.setData("text/plain", el.dataset.qindex); });
    el.addEventListener("dragover", e=>{ e.preventDefault(); el.classList.add("drag-over"); });
    el.addEventListener("dragleave", ()=> el.classList.remove("drag-over"));
    el.addEventListener("drop", e=>{
      e.preventDefault(); el.classList.remove("drag-over");
      const from = parseInt(e.dataTransfer.getData("text/plain"),10);
      const to = parseInt(el.dataset.qindex,10);
      if(from===to || isNaN(from)) return;
      const [moved] = S.queue.splice(from,1);
      let insertAt = to;
      if(from<to) insertAt = to; // after removal, indices shift
      S.queue.splice(insertAt,0,moved);
      if(S.queueIndex===from) S.queueIndex = insertAt;
      else {
        if(from<S.queueIndex && insertAt>=S.queueIndex) S.queueIndex--;
        else if(from>S.queueIndex && insertAt<=S.queueIndex) S.queueIndex++;
      }
      renderQueue(); schedulePlaybackSave();
    });
  });
  list.querySelectorAll("[data-move-qindex]").forEach(el=>{
    el.addEventListener("click", e=>{
      e.stopPropagation();
      moveQueueItem(parseInt(el.dataset.moveQindex,10), parseInt(el.dataset.dir,10));
    });
  });
  list.querySelectorAll("[data-remove-qindex]").forEach(el=>{
    el.addEventListener("click", e=>{
      e.stopPropagation();
      removeFromQueue(parseInt(el.dataset.removeQindex,10));
    });
  });
}
function moveQueueItem(index, dir){
  const newIndex = index+dir;
  if(newIndex<0 || newIndex>=S.queue.length) return;
  [S.queue[index], S.queue[newIndex]] = [S.queue[newIndex], S.queue[index]];
  if(S.queueIndex===index) S.queueIndex=newIndex;
  else if(S.queueIndex===newIndex) S.queueIndex=index;
  renderQueue(); schedulePlaybackSave();
}
function removeFromQueue(idx){
  const wasCurrent = idx===S.queueIndex;
  S.queue.splice(idx,1);
  if(idx<S.queueIndex) S.queueIndex--;
  if(wasCurrent){
    if(!S.queue.length){
      S.queueIndex=-1;
      audio.pause();
      audio.removeAttribute("src");
      audio.load();
      S.isPlaying=false;
      document.getElementById("miniplayer").style.display="none";
      updatePlayButtons();
    } else {
      if(S.queueIndex>=S.queue.length) S.queueIndex = S.queue.length-1;
      loadAndPlay(S.queueIndex);
      return; // loadAndPlay already re-renders queue + saves state
    }
  }
  renderQueue(); schedulePlaybackSave();
}
function clearQueueKeepingCurrent(){
  if(!S.queue.length) return;
  if(S.queueIndex>-1){
    const currentId = S.queue[S.queueIndex];
    S.queue = [currentId];
    S.queueIndex = 0;
  } else {
    S.queue = []; S.queueIndex = -1;
  }
  renderQueue(); schedulePlaybackSave();
  showToast("Fila limpa");
}
document.getElementById("queueClearBtn").addEventListener("click", clearQueueKeepingCurrent);

function addToQueue(trackId, playNext){
  if(playNext && S.queueIndex>-1){
    S.queue.splice(S.queueIndex+1, 0, trackId);
  } else {
    S.queue.push(trackId);
  }
  if(S.queueIndex===-1){
    S.queueIndex = S.queue.indexOf(trackId);
    loadAndPlay(S.queueIndex);
  } else {
    renderQueue(); schedulePlaybackSave();
  }
  showToast(playNext ? "Tocará a seguir" : "Adicionada à fila");
}

/* ============================================================
   TRACK CONTEXT MENU (add to queue / add to playlist)
============================================================ */
function closeCtxMenu(){ document.getElementById("ctxRoot").innerHTML=""; document.removeEventListener("click", closeCtxMenuOnOutside); }
function closeCtxMenuOnOutside(e){ if(!e.target.closest(".ctx-menu")) closeCtxMenu(); }

function openTrackMenu(e, trackId){
  closeCtxMenu();
  const rect = e.currentTarget.getBoundingClientRect();
  const root = document.getElementById("ctxRoot");
  const playlistItems = S.playlists.map(p=>`<button class="ctx-item" data-add-to-playlist="${p.id}">${escapeHtml(p.name)}</button>`).join("");
  root.innerHTML = `
    <div class="ctx-menu" style="top:${Math.min(rect.bottom+6, window.innerHeight-300)}px; left:${Math.min(rect.left, window.innerWidth-220)}px;">
      <button class="ctx-item" data-action="play-next">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M13 5l7 7-7 7M4 12h15"/></svg>
        Tocar a seguir
      </button>
      <button class="ctx-item" data-action="queue">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        Adicionar à fila
      </button>
      <div class="ctx-submenu-label">Adicionar à playlist</div>
      ${playlistItems}
      <button class="ctx-item" data-action="new-playlist">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 5v14M5 12h14"/></svg>
        Nova playlist com esta música
      </button>
    </div>`;
  root.querySelector('[data-action="play-next"]').addEventListener("click", ()=>{ addToQueue(trackId, true); closeCtxMenu(); });
  root.querySelector('[data-action="queue"]').addEventListener("click", ()=>{ addToQueue(trackId, false); closeCtxMenu(); });
  root.querySelector('[data-action="new-playlist"]').addEventListener("click", ()=>{ closeCtxMenu(); openPlaylistModal(null, trackId); });
  root.querySelectorAll("[data-add-to-playlist]").forEach(el=>{
    el.addEventListener("click", async ()=>{
      const p = S.playlists.find(pl=>pl.id===el.dataset.addToPlaylist);
      closeCtxMenu();
      if(!p) return;
      if(p.trackIds.includes(trackId)){ showToast(`Já está em "${p.name}"`); return; }
      p.trackIds.push(trackId);
      await savePlaylists();
      if(S.view==="playlist-detail") render();
      showToast(`Adicionada à playlist "${p.name}"`);
    });
  });
  setTimeout(()=> document.addEventListener("click", closeCtxMenuOnOutside), 0);
}

/* Right-click on a track row/card also removes from current playlist if in that context */
document.addEventListener("contextmenu", (e)=>{
  const row = e.target.closest(".track-row[data-playlist-context]");
  if(row && row.dataset.playlistContext){
    e.preventDefault();
    const trackId = row.dataset.trackId;
    const playlistId = row.dataset.playlistContext;
    closeCtxMenu();
    const root = document.getElementById("ctxRoot");
    root.innerHTML = `<div class="ctx-menu" style="top:${e.clientY}px; left:${e.clientX}px;">
      <button class="ctx-item danger" id="removeFromPlaylistCtx">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        Remover da playlist
      </button>
    </div>`;
    document.getElementById("removeFromPlaylistCtx").addEventListener("click", async ()=>{
      const p = S.playlists.find(pl=>pl.id===playlistId);
      if(p){ p.trackIds = p.trackIds.filter(id=>id!==trackId); await savePlaylists(); render(); }
      closeCtxMenu();
    });
    setTimeout(()=> document.addEventListener("click", closeCtxMenuOnOutside), 0);
  }
});

/* ============================================================
   PLAYLIST MODAL (create / rename)
============================================================ */
function openPlaylistModal(playlistId, addTrackIdAfterCreate){
  const existing = playlistId ? S.playlists.find(p=>p.id===playlistId) : null;
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>${existing?"Renomear playlist":"Nova playlist"}</h3>
        <input type="text" id="playlistNameInput" placeholder="Nome da playlist" value="${existing?escapeHtml(existing.name):""}" />
        <div class="modal-actions">
          <button class="btn btn-ghost" id="modalCancel">Cancelar</button>
          <button class="btn btn-primary" id="modalConfirm">${existing?"Salvar":"Criar"}</button>
        </div>
      </div>
    </div>`;
  const input = document.getElementById("playlistNameInput");
  input.focus(); input.select();
  document.getElementById("modalCancel").addEventListener("click", ()=> root.innerHTML="");
  document.getElementById("modalBackdrop").addEventListener("click", e=>{ if(e.target.id==="modalBackdrop") root.innerHTML=""; });
  async function confirm(){
    const name = input.value.trim();
    if(!name) return;
    if(existing){ existing.name = name; }
    else {
      const newPlaylist = {id:uid(), name, image:null, trackIds: addTrackIdAfterCreate ? [addTrackIdAfterCreate] : []};
      S.playlists.push(newPlaylist);
    }
    await savePlaylists();
    root.innerHTML="";
    render();
    showToast(existing ? "Playlist renomeada" : `Playlist "${name}" criada`);
  }
  document.getElementById("modalConfirm").addEventListener("click", confirm);
  input.addEventListener("keydown", e=>{ if(e.key==="Enter") confirm(); });
}

/* ============================================================
   SOBRE + HISTÓRICO DE VERSÕES
   Toda vez que uma nova versão for publicada (npm run publish), adicione
   uma entrada NOVA no topo desta lista (mais recente primeiro) descrevendo
   o que mudou — é esse texto que aparece tanto no modal "Sobre" quanto,
   automaticamente, na telinha de "nova versão disponível" caso o campo de
   notas do release do GitHub esteja vazio.
============================================================ */
const CHANGELOG = [
  { version:"1.0.2", date:"2026", notes:"• Corrige o modo aleatório, que continuava tocando músicas fora de ordem mesmo depois de desativado.\n• Ícone de repetição diferente pra 'repetir todas' e 'repetir música atual'.\n• Tela 'Sobre' agora é em tela cheia, com botão de voltar e Esc pra fechar." },
  { version:"1.0.1", date:"2026", notes:"Corrige bug da barra de progresso e adiciona ícone do app." },
  { version:"1.0.0", date:"2026", notes:"Lançamento inicial do DK Player." },
];

// Tela cheia (não é mais um modal/pop-up): sólida, minimalista, com botão
// de voltar no canto superior esquerdo. Fecha também com Esc (ver o
// keydown handler mais abaixo, no bloco de atalhos de teclado).
function openAboutScreen(){
  const version = S.appVersion || CHANGELOG[0]?.version || "";
  document.getElementById("aboutScreenName").innerHTML =
    `DK Player${version?`<span class="about-screen-version">v${escapeHtml(version)}</span>`:""}`;
  document.getElementById("aboutScreenChangelog").innerHTML = `
    <div class="about-screen-changelog-title">Histórico de versões</div>
    ${CHANGELOG.map(c=>`
      <div class="about-screen-changelog-entry">
        <span class="about-screen-changelog-version">v${escapeHtml(c.version)}</span><span class="about-screen-changelog-date">${escapeHtml(c.date)}</span>
        <div class="about-screen-changelog-notes">${escapeHtml(c.notes)}</div>
      </div>`).join("")}`;
  document.getElementById("aboutScreen").classList.add("show");
}
function closeAboutScreen(){
  document.getElementById("aboutScreen").classList.remove("show");
}
document.getElementById("aboutBtn").addEventListener("click", openAboutScreen);
document.getElementById("aboutBackBtn").addEventListener("click", closeAboutScreen);

/* ============================================================
   ATUALIZAÇÕES (auto-updater)
   O main.js manda "update-available" quando encontra uma versão nova no
   GitHub (sem baixar nada sozinho) e "update-downloaded" quando o download
   termina. Aqui a gente só decide o que mostrar em cada etapa.
============================================================ */
function openUpdateAvailableModal(version, notes){
  const root = document.getElementById("modalRoot");
  const fallback = CHANGELOG.find(c=>c.version===version);
  const text = (notes && notes.trim()) || fallback?.notes || "Melhorias e correções de bugs.";
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal modal-lg">
        <h3>Nova versão disponível — v${escapeHtml(version)}</h3>
        <div class="changelog-notes" style="margin-bottom:20px;">${escapeHtml(text)}</div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="updateLaterBtn">Depois</button>
          <button class="btn btn-primary" id="updateNowBtn">Atualizar agora</button>
        </div>
      </div>
    </div>`;
  document.getElementById("updateLaterBtn").addEventListener("click", ()=> root.innerHTML="");
  document.getElementById("updateNowBtn").addEventListener("click", ()=>{
    const btn = document.getElementById("updateNowBtn");
    btn.textContent = "Baixando...";
    btn.disabled = true;
    window.dkAPI.startUpdateDownload();
  });
}
function openUpdateReadyModal(){
  const root = document.getElementById("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>Atualização baixada com sucesso!</h3>
        <p>A nova versão será instalada assim que o DK Player reiniciar.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="restartLaterBtn">Depois</button>
          <button class="btn btn-primary" id="restartNowBtn">Reiniciar agora</button>
        </div>
      </div>
    </div>`;
  document.getElementById("restartLaterBtn").addEventListener("click", ()=> root.innerHTML="");
  document.getElementById("restartNowBtn").addEventListener("click", ()=> window.dkAPI.installUpdateNow());
}
window.dkAPI.onUpdateAvailable(({version, notes})=> openUpdateAvailableModal(version, notes));
window.dkAPI.onUpdateDownloaded(()=> openUpdateReadyModal());

/* ============================================================
   SEARCH
============================================================ */
document.getElementById("searchInput").addEventListener("input", e=>{
  S.search = e.target.value;
  render();
});

/* ============================================================
   KEYBOARD SHORTCUT: space to play/pause (when not typing)
============================================================ */
document.addEventListener("keydown", e=>{
  const typing = document.activeElement && (document.activeElement.tagName==="INPUT" || document.activeElement.tagName==="TEXTAREA");

  if(e.code==="Space" && !typing){
    e.preventDefault(); togglePlay();
    return;
  }

  if(e.key==="Escape"){
    const aboutScreen = document.getElementById("aboutScreen");
    if(aboutScreen.classList.contains("show")){
      closeAboutScreen();
      return;
    }
    const overlay = document.getElementById("fullOverlay");
    if(overlay.classList.contains("show")){
      overlay.classList.remove("show");
      return;
    }
    if(document.getElementById("queuePanel").classList.contains("show")){
      closeQueuePanel();
      return;
    }
    if(typing) document.activeElement.blur();
    return;
  }

  if(e.key==="Enter" && !typing && !document.querySelector(".modal-backdrop")){
    e.preventDefault();
    const input = document.getElementById("searchInput");
    input.focus();
    input.select();
  }
});

init();
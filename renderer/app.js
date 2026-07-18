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
   PERSONALIZAÇÃO — tema (claro/escuro) e cores individuais
   Só existem 4 cores "base" pra mexer (fundo, superfície, texto,
   destaque) — todo o resto (superfície-2/3, bordas, texto
   dim/faint, accent-soft) é derivado delas no próprio CSS via
   color-mix(), então aplicar um tema aqui é só escrever essas 4
   como propriedades customizadas inline no :root.
============================================================ */
const THEME_DEFAULTS = {
  dark:  { bg:"#0B0D10", surface:"#14171C", text:"#EDEFF2", accent:"#E8B04B" },
  light: { bg:"#FAF9F7", surface:"#FFFFFF", text:"#1B1D21", accent:"#E8B04B" },
};
function hexToRgb(hex){
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex||"");
  if(!m) return {r:0,g:0,b:0};
  return {r:parseInt(m[1],16), g:parseInt(m[2],16), b:parseInt(m[3],16)};
}
// Decide se o texto em cima do botão "cheio" de --accent deve ser escuro
// ou claro, pra continuar legível não importa qual cor de destaque a
// pessoa escolher (antes era um #1a1408 fixo, que só funcionava porque o
// laranja padrão era sempre claro o bastante).
function contrastTextFor(hex){
  const {r,g,b} = hexToRgb(hex);
  const luminance = (0.299*r + 0.587*g + 0.114*b)/255;
  return luminance > 0.6 ? "#1a1408" : "#F5F3EF";
}

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
function removeUnsync(bytes){
  // Desfaz o "byte stuffing" da unsynchronisation do ID3v2: todo 0xFF
  // seguido de 0x00 vira só 0xFF. Sem isso, qualquer 0xFF seguido de certos
  // bytes (MUITO comum em JPEG, que começa com FF D8 FF E0) desloca todo o
  // resto da tag, corrompendo os dados da capa mesmo com o tamanho do frame
  // correto.
  const out = new Uint8Array(bytes.length);
  let j=0;
  for(let i=0;i<bytes.length;i++){
    out[j++] = bytes[i];
    if(bytes[i]===0xFF && bytes[i+1]===0x00) i++;
  }
  return out.subarray(0,j);
}
const ID3_DEBUG = false;
async function parseID3(filePath){
  const meta = {title:null, artist:null, album:null, coverUrl:null, coverBytes:null, coverMime:null};
  const dbg = (...a)=>{ if(ID3_DEBUG) console.log("[ID3]", filePath.split(/[\\/]/).pop(), ...a); };
  try{
    const head = await window.dkAPI.readFileRange(filePath, 0, 10);
    if(head.length<10 || String.fromCharCode(head[0],head[1],head[2]) !== "ID3"){
      dbg("sem tag ID3 (ou header curto)", head.length, head.length>=3?String.fromCharCode(head[0],head[1],head[2]):"?");
      return meta;
    }
    const majorVersion = head[3]; // 3 = ID3v2.3, 4 = ID3v2.4
    const tagFlags = head[5];
    const tagUnsync = !!(tagFlags & 0x80);
    const hasExtHeader = !!(tagFlags & 0x40);
    const size = readSynchsafe(head,6);
    dbg("header ok", {majorVersion, tagFlags: tagFlags.toString(2), tagUnsync, hasExtHeader, size});
    let buf = await window.dkAPI.readFileRange(filePath, 10, size);
    dbg("buf lido", buf.length, "de", size, "esperados");
    if(tagUnsync) buf = removeUnsync(buf);
    let off=0;
    if(hasExtHeader){
      // v2.4: tamanho do cabeçalho estendido é synchsafe e já se inclui.
      // v2.3: tamanho é inteiro normal de 32 bits e NÃO se inclui (soma-se
      // os 4 bytes do próprio campo de tamanho).
      off = majorVersion>=4
        ? readSynchsafe(buf,0)
        : 4 + ((buf[0]<<24)|(buf[1]<<16)|(buf[2]<<8)|buf[3]);
    }
    while(off < buf.length-10){
      const id = String.fromCharCode(buf[off],buf[off+1],buf[off+2],buf[off+3]);
      if(id==="\0\0\0\0") break;
      // ID3v2.4 usa tamanho "synchsafe" (7 bits úteis por byte) também pra
      // cada campo individual, não só pro cabeçalho geral — v2.3 usa um
      // inteiro normal de 32 bits. Ferramentas como o spotdl (via mutagen)
      // costumam gravar em v2.4; sem diferenciar isso, o tamanho da CAPA
      // (o campo mais pesado do arquivo) saía errado — títulos/artistas
      // são pequenos o bastante pra os dois cálculos darem o mesmo valor
      // por coincidência, por isso só a capa era afetada.
      const frameSize = majorVersion>=4
        ? readSynchsafe(buf, off+4)
        : (buf[off+4]<<24)|(buf[off+5]<<16)|(buf[off+6]<<8)|buf[off+7];
      if(frameSize<=0 || off+10+frameSize>buf.length){
        dbg("parou no frame", JSON.stringify(id), {frameSize, off, bufLen:buf.length});
        break;
      }
      dbg("frame", JSON.stringify(id), "size", frameSize, "off", off);
      let frameData = buf.slice(off+10, off+10+frameSize);
      if(majorVersion>=4){
        // Segundo byte de flags do frame (formato %0h00kmnp):
        // bit 0x01 = data length indicator presente (4 bytes synchsafe no
        //            início dos dados, com o tamanho "real" pós-unsync);
        // bit 0x02 = unsynchronisation aplicada só a este frame.
        // O mutagen pode ligar essas flags no APIC mesmo sem ligar a flag
        // global do cabeçalho, então sem checar isso aqui a capa continua
        // vindo corrompida mesmo já tratando a unsync do cabeçalho.
        const frameFlags2 = buf[off+9];
        const hasDataLenInd = !!(frameFlags2 & 0x01);
        const frameUnsync = !!(frameFlags2 & 0x02);
        let p2 = 0;
        if(hasDataLenInd) p2 = 4; // tamanho real, não precisamos do valor em si
        if(frameUnsync) frameData = removeUnsync(frameData.slice(p2));
        else if(p2) frameData = frameData.slice(p2);
      }
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
          else {
            // UTF-16: o terminador nulo ocupa 2 bytes e só é válido alinhado
            // de 2 em 2 a partir do início da descrição — varrer byte a byte
            // encontra um par "00 00" falso sempre que o último caractere é
            // ASCII em UTF-16LE (byte alto 0x00 + primeiro byte do
            // terminador real também 0x00), cortando a imagem 1 byte cedo.
            while(descEnd+1<frameData.length && !(frameData[descEnd]===0 && frameData[descEnd+1]===0)) descEnd+=2;
            descEnd+=2;
          }
          const imgBytes = frameData.slice(descEnd);
          dbg("APIC decodificado", {enc, mime, mimeEnd, descEnd, frameDataLen:frameData.length, imgBytesLen:imgBytes.length, first4:Array.from(imgBytes.slice(0,4))});
          const blob = new Blob([imgBytes], {type:mime});
          meta.coverUrl = URL.createObjectURL(blob);
          // Guarda os bytes brutos também (não só o blob: URL) — quem
          // precisar reenviar a imagem pra outro lugar (ex: "Ouvir Junto"
          // mandando a capa pro amigo) pode usar isso direto, sem precisar
          // de fetch() num blob: URL, que a CSP do app bloqueia.
          meta.coverBytes = imgBytes;
          meta.coverMime = mime;
          dbg("coverUrl criado", meta.coverUrl);
        }catch(e){ dbg("ERRO ao decodificar APIC", e && e.message, e && e.stack); }
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
  trackOriginalPaths:{}, // trackId -> caminho de origem, antes de entrar numa pasta de playlist
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
  themeMode:"dark",     // dark | light
  customColors:{},      // só as chaves (bg/surface/text/accent) que o usuário mudou manualmente
};

const audio = document.getElementById("audio");
audio.volume = S.volume;

// Guarda o último volume "não-mudo" pra poder restaurar exatamente onde
// estava quando o usuário clicar de novo no ícone pra desmutar.
let volumeBeforeMute = S.volume>0 ? S.volume : 0.9;

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
  if(S.volume>0) volumeBeforeMute = S.volume;
  return st;
}
async function savePlaylists(){
  await Store.set("playlists", S.playlists);
}
async function loadPlaylists(){
  const pl = await Store.get("playlists");
  S.playlists = Array.isArray(pl) ? pl : [];
}

// Guarda de onde cada música veio ANTES de ser movida pra dentro de uma
// pasta de playlist — é o que permite devolver ela pro lugar de origem
// se a playlist for excluída depois.
async function saveTrackOriginalPaths(){
  await Store.set("trackOriginalPaths", S.trackOriginalPaths);
}
async function loadTrackOriginalPaths(){
  const m = await Store.get("trackOriginalPaths");
  S.trackOriginalPaths = (m && typeof m==="object") ? m : {};
}

function currentThemeColors(){
  const base = THEME_DEFAULTS[S.themeMode] || THEME_DEFAULTS.dark;
  return { ...base, ...S.customColors };
}
// Escreve as 4 cores base como propriedades customizadas inline no :root
// (têm prioridade sobre o :root do CSS) e recalcula o contraste do texto
// em cima do destaque. Tudo que é derivado (superfície-2/3, bordas,
// texto-dim/faint, accent-soft) se ajusta sozinho via color-mix() no CSS.
function applyTheme(){
  const colors = currentThemeColors();
  const root = document.documentElement.style;
  root.setProperty("--bg", colors.bg);
  root.setProperty("--surface", colors.surface);
  root.setProperty("--text", colors.text);
  root.setProperty("--accent", colors.accent);
  root.setProperty("--accent-contrast", contrastTextFor(colors.accent));

  document.querySelectorAll(".theme-toggle-btn").forEach(btn=>{
    btn.classList.toggle("active", btn.dataset.theme===S.themeMode);
  });
  const colorInputs = {colorAccent:"accent", colorBg:"bg", colorSurface:"surface", colorText:"text"};
  Object.entries(colorInputs).forEach(([id,key])=>{
    const el = document.getElementById(id);
    if(el) el.value = colors[key];
  });
}
async function saveThemeSettings(){
  await Store.set("theme", {mode:S.themeMode, colors:S.customColors});
}
async function loadThemeSettings(){
  const saved = await Store.get("theme");
  if(saved){
    S.themeMode = saved.mode==="light" ? "light" : "dark";
    S.customColors = (saved.colors && typeof saved.colors==="object") ? saved.colors : {};
  }
  applyTheme();
}
document.querySelectorAll(".theme-toggle-btn").forEach(btn=>{
  btn.addEventListener("click", ()=>{
    if(S.themeMode===btn.dataset.theme) return;
    S.themeMode = btn.dataset.theme;
    applyTheme();
    saveThemeSettings();
  });
});
document.querySelectorAll("#colorPickerGrid input[type=color]").forEach(input=>{
  input.addEventListener("input", ()=>{
    S.customColors[input.dataset.colorKey] = input.value;
    applyTheme();
    saveThemeSettings();
  });
});
document.getElementById("resetThemeBtn")?.addEventListener("click", ()=>{
  S.customColors = {};
  applyTheme();
  saveThemeSettings();
  showToast("Cores restauradas ao padrão");
});

/* ============================================================
   PASTAS FÍSICAS DE PLAYLIST
   Cada playlist ganha uma subpasta dentro da biblioteca. Quando uma
   música entra numa playlist PELA PRIMEIRA VEZ (ou seja, ainda não
   pertence a nenhuma outra playlist), o arquivo é movido pra essa
   subpasta. Se depois ela for adicionada a uma segunda playlist, o
   arquivo NÃO é movido de novo — só a referência (trackId) é adicionada,
   o arquivo físico continua onde já estava.
============================================================ */
async function ensurePlaylistFolder(playlist){
  if(playlist.folderPath) return playlist.folderPath;
  if(!S.libraryPath) return null;
  try{
    const folder = await window.dkAPI.ensurePlaylistFolder(S.libraryPath, playlist.name);
    playlist.folderPath = folder;
    await savePlaylists();
    return folder;
  }catch(e){ console.warn("não foi possível criar a pasta da playlist", e); return null; }
}

async function addTrackToPlaylist(playlist, trackId){
  if(playlist.trackIds.includes(trackId)){ showToast(`Já está em "${playlist.name}"`); return; }
  const track = trackById(trackId);
  const alreadyInAnotherPlaylist = S.playlists.some(p=>p.id!==playlist.id && p.trackIds.includes(trackId));

  playlist.trackIds.push(trackId);
  await savePlaylists();

  if(track && !alreadyInAnotherPlaylist){
    const folder = await ensurePlaylistFolder(playlist);
    if(folder){
      try{
        // Guarda de onde ela veio ANTES de mover — é o que permite
        // devolver ela pro lugar certo se a playlist for excluída depois.
        S.trackOriginalPaths[track.id] = track.path;
        await saveTrackOriginalPaths();

        const newPath = await window.dkAPI.moveFileToFolder(track.path, folder);
        if(newPath) track.path = newPath;
      }catch(e){ console.warn("falha ao mover arquivo pra pasta da playlist", e); }
    }
  }

  if(S.view==="playlist-detail") render();
  showToast(`Adicionada à playlist "${playlist.name}"`);
}

/* Exclui uma playlist: pra cada música cujo arquivo físico mora na pasta
   DESSA playlist (comparando a pasta atual do arquivo com a pasta da
   playlist), devolve ela pro caminho de origem salvo. Músicas que estão
   em OUTRAS playlists continuam encontráveis normalmente depois (elas só
   guardam o id da faixa, não o caminho, e o escaneamento da biblioteca já
   é recursivo). Só apaga a pasta física se ela ficar vazia no final —
   por segurança, nunca apaga uma pasta com algo dentro. */
async function deletePlaylistAndRestoreFiles(playlistId){
  const playlist = S.playlists.find(p=>p.id===playlistId);
  if(!playlist) return;

  if(playlist.folderPath){
    for(const trackId of playlist.trackIds){
      const track = trackById(trackId);
      if(!track) continue;

      const inThisFolder = (()=>{
        const trackDir = track.path.replace(/[\\/][^\\/]*$/, "");
        return trackDir === playlist.folderPath;
      })();
      if(!inThisFolder) continue; // o arquivo físico não mora aqui, nada a fazer

      const originalPath = S.trackOriginalPaths[trackId];
      if(originalPath){
        const originalFolder = originalPath.replace(/[\\/][^\\/]*$/, "");
        try{
          const restoredPath = await window.dkAPI.moveFileToFolder(track.path, originalFolder);
          if(restoredPath) track.path = restoredPath;
          delete S.trackOriginalPaths[trackId];
        }catch(e){ console.warn("falha ao devolver arquivo pro lugar de origem", e); }
      }
      // se não tiver caminho de origem salvo (ex: playlist criada numa
      // versão antiga do app), o arquivo fica onde está — mais seguro
      // do que arriscar apagar algo sem saber pra onde mandar.
    }
    await saveTrackOriginalPaths();

    try{
      const deleted = await window.dkAPI.deleteFolderIfEmpty(playlist.folderPath);
      if(!deleted) console.warn("pasta da playlist não estava vazia, não apaguei:", playlist.folderPath);
    }catch(e){ console.warn("falha ao apagar a pasta da playlist", e); }
  }

  S.playlists = S.playlists.filter(p=>p.id!==playlistId);
  await savePlaylists();
  showToast(`Playlist "${playlist.name}" excluída`);
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
  const tracks = orderedArtistTracks(artist, S.tracks.filter(t=>primaryArtist(t.artist)===artist));
  const order = ensureArtistOrder(artist, tracks);
  const newIndex = index+dir;
  if(newIndex<0 || newIndex>=order.length) return;
  [order[index], order[newIndex]] = [order[newIndex], order[index]];
  await saveArtistOrder();
  render();
}
async function reorderArtistTrack(artist, from, to){
  const tracks = orderedArtistTracks(artist, S.tracks.filter(t=>primaryArtist(t.artist)===artist));
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
      coverBytes: id3.coverBytes || null,
      coverMime: id3.coverMime || null,
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
  await loadThemeSettings();
  await loadPlaylists();
  await loadTrackOriginalPaths();
  await loadArtistOrder();
  await loadPlaybackState();
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

  // Propositalmente NÃO restauramos mais a música/fila da última sessão
  // aqui — o usuário não quer que o app abra já com a última faixa
  // carregada no miniplayer. Preferências (volume, shuffle, repeat) ainda
  // são restauradas normalmente lá em cima; só a "música atual" não é mais.

  // Manda a atividade pro Discord assim que o app termina de abrir — antes
  // disso, se o usuário não tocasse nada, não aparecia nenhuma atividade.
  updateDiscordPresence();
}

/* ============================================================
   RENDERING — sidebar
============================================================ */
function renderSidebar(){
  document.querySelectorAll(".nav-item").forEach(el=>{
    const active = el.dataset.view===S.view || (el.dataset.view==="playlists" && S.view==="playlist-detail");
    el.classList.toggle("active", active);
  });
}

document.querySelectorAll(".nav-item[data-view]").forEach(el=>{
  el.addEventListener("click", ()=>{
    S.view = el.dataset.view; S.detailKey=null; render();
    collapseSidebarIfNarrow();
  });
});

/* ============================================================
   SIDEBAR — expandir/recolher (botão de menu mora dentro da própria
   sidebar, sempre visível). A sidebar nunca some de verdade: recolhida,
   vira uma trilha estreita só com os ícones clicáveis + o botão de
   menu no topo. Em telas largas isso encolhe/expande a coluna de
   verdade (lembra a preferência entre sessões); em telas estreitas a
   trilha fica fixa por cima do conteúdo e só a versão expandida vira
   um flyout temporário (com fundo escurecido) que começa sempre
   recolhido.
============================================================ */
const NARROW_SIDEBAR_QUERY = window.matchMedia("(max-width:860px)");
function setSidebarExpanded(expanded){
  document.getElementById("app").classList.toggle("sidebar-expanded", expanded);
  document.getElementById("sidebarBackdrop").classList.toggle("show", expanded && NARROW_SIDEBAR_QUERY.matches);
}
function collapseSidebarIfNarrow(){
  // Só recolhe automaticamente (ex: ao navegar) quando está em modo
  // flyout — em telas largas a sidebar é fixa e não deve recolher
  // sozinha a cada clique.
  if(NARROW_SIDEBAR_QUERY.matches) setSidebarExpanded(false);
}
(async function initSidebar(){
  const stored = await Store.get("sidebarOpen");
  const initialExpanded = NARROW_SIDEBAR_QUERY.matches ? false : (stored===null ? true : !!stored);
  setSidebarExpanded(initialExpanded);

  document.getElementById("sidebarToggleBtn").addEventListener("click", async (e)=>{
    const nowExpanded = !document.getElementById("app").classList.contains("sidebar-expanded");
    setSidebarExpanded(nowExpanded);
    if(!NARROW_SIDEBAR_QUERY.matches) await Store.set("sidebarOpen", nowExpanded);
    // Reinicia a animação de girada a cada clique, mesmo em cliques
    // seguidos rápidos (sem isso, remover+adicionar a mesma classe sem
    // forçar reflow no meio não reinicia a animação já em andamento).
    const btn = e.currentTarget;
    btn.classList.remove("spin");
    void btn.offsetWidth;
    btn.classList.add("spin");
  });
  document.getElementById("sidebarBackdrop").addEventListener("click", collapseSidebarIfNarrow);
})();

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

// Pega o "artista principal" de uma faixa a partir do campo de artista
// completo — usado só pra AGRUPAR na tela de Artistas, nunca pra exibir.
// Uma faixa creditada a "Michael Jackson/Akon" deve cair dentro do grupo
// "Michael Jackson" já existente, em vez de virar um artista novo e solto
// só por causa da colaboração.
function primaryArtist(artistString){
  if(!artistString) return "Artista desconhecido";
  const parts = artistString.split(/\s*\/\s*|\s*,\s*|\s+&\s+|\s+[xX]\s+|\s+feat\.?\s+|\s+ft\.?\s+|\s*;\s*/i);
  const first = parts[0] && parts[0].trim();
  return first || artistString.trim();
}

function groupBy(tracks, keyOrFn){
  const map = new Map();
  const getKey = typeof keyOrFn==="function" ? keyOrFn : (t)=>t[keyOrFn];
  tracks.forEach(t=>{
    const k = getKey(t);
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
    const groups = groupBy(filteredTracks(S.tracks), t=>primaryArtist(t.artist));
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
    const rawTracks = S.tracks.filter(t=>primaryArtist(t.artist)===S.detailKey);
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
    html += `<div class="content-header"><div class="content-title">Playlists</div><button class="btn btn-primary" id="newPlaylistBtn">+ Nova playlist</button></div>`;
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
      html += `<div class="empty-state"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4"><path d="M9 18V5l12-2v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="16" r="3"/></svg><h3>Nenhuma playlist ainda</h3><p>Clique em "Nova playlist" acima para organizar suas músicas.</p></div>`;
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
  const newPlaylistBtn = content.querySelector("#newPlaylistBtn");
  if(newPlaylistBtn) newPlaylistBtn.addEventListener("click", ()=> openPlaylistModal(null));
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
    const playlistId = S.detailKey;
    S.view="playlists"; S.detailKey=null; render();
    await deletePlaylistAndRestoreFiles(playlistId);
    render();
  });
}

/* Playing a track: builds a queue from the current visible context (all songs / artist / album / playlist) */
function playTrackFromContext(trackId){
  let contextTracks;
  if(S.view==="all") contextTracks = filteredTracks(S.tracks);
  else if(S.view==="artist-detail") contextTracks = orderedArtistTracks(S.detailKey, S.tracks.filter(t=>primaryArtist(t.artist)===S.detailKey));
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
  updateDiscordPresence();
}

/* ============================================================
   DISCORD RICH PRESENCE
   Só chamamos isso ao trocar de música, dar play/pause — NUNCA a cada
   "timeupdate" do <audio>. O Discord limita a frequência de setActivity()
   (chamadas demais em pouco tempo são ignoradas), e não precisa: mandando
   startTimestamp/endTimestamp uma vez, o próprio Discord desenha e anima a
   barra de progresso e o "X:XX" restante sozinho do lado dele.
============================================================ */
function updateDiscordPresence(){
  if(!window.dkAPI?.setDiscordActivity) return; // preload antigo / API não exposta

  const inParty = typeof Party!=="undefined" && Party.connected;
  // Quando a faixa ativa da party é a do amigo (Party.activeSide==="peer"),
  // currentTrack() fica vazio — a MINHA fila local não tem nada tocando —
  // então antes disso fazia o Discord mostrar "Nenhuma música tocando"
  // mesmo com uma música rolando de verdade (só que vinda do peerAudio).
  const listeningToPeer = inParty && Party.activeSide==="peer" && Party.activeTrackMeta;

  const t = listeningToPeer ? null : currentTrack();
  const title = listeningToPeer ? Party.activeTrackMeta.title : t?.title;
  const artist = listeningToPeer ? Party.activeTrackMeta.artist : t?.artist;
  const playing = listeningToPeer ? !!Party.isPlaying : S.isPlaying;
  const dur = listeningToPeer ? (Party.peerAudio?.duration||0) : (audio.duration||0);
  const elapsed = listeningToPeer ? (Party.peerAudio?.currentTime||0) : (audio.currentTime||0);

  if(!title){
    // Antes, sem nenhuma música tocando, a gente limpava a atividade —
    // por isso só aparecia algo no Discord depois de escolher uma faixa.
    // Agora mandamos um estado "parado" assim que o app abre, pra
    // aparecer de cara mesmo sem nada tocando ainda.
    window.dkAPI.setDiscordActivity({
      type: 2,
      details: "DK Player",
      state: "Nenhuma música tocando",
      largeImageKey: "logo",
      instance: false,
    });
    return;
  }

  const nowMs = Date.now();
  const elapsedMs = elapsed*1000;

  const activity = {
    // type 2 = Listening. Isso é o que faz o Discord mostrar "Ouvindo" em
    // vez de "Jogando" no topo do card, E o que libera a barra de progresso
    // de verdade (com duração total) em vez do simples contador com ícone
    // de controle que aparece por padrão nas atividades tipo "Playing".
    type: 2,
    details: title,
    state: artist || "Artista desconhecido",
    largeImageKey: "logo",
    instance: false,
  };

  // Terceira linha do card: o topo já mostra "Ouvindo DK Player" sozinho,
  // então repetir "DK Player" aqui embaixo era redundante. Em vez disso,
  // mostra que você está no "Ouvir Junto" com alguém (a info que os
  // amigos realmente querem ver), ou o álbum da música quando não está
  // em nenhuma party.
  if(inParty) activity.largeImageText = "Ouvindo Junto com um amigo";
  else if(!listeningToPeer && t?.album) activity.largeImageText = `Álbum: ${t.album}`;

  // Timestamps só fazem sentido enquanto está tocando; pausado, o Discord
  // mostra "Pausado" sem barra de progresso rodando se a gente omitir eles.
  if(playing){
    activity.startTimestamp = Math.floor(nowMs - elapsedMs);
    if(dur > 0) activity.endTimestamp = Math.floor(nowMs - elapsedMs + dur * 1000);
    activity.smallImageKey = "play";
    activity.smallImageText = "Tocando";
  } else {
    activity.smallImageKey = "pause";
    activity.smallImageText = "Pausado";
  }

  window.dkAPI.setDiscordActivity(activity);
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

// Para tudo e esconde o miniplayer por completo — diferente de pause, isso
// zera a fila e a faixa atual, então não sobra nada tocando "escondido" nem
// pra retomar sem querer depois.
function closePlayer(){
  audio.pause();
  audio.removeAttribute("src");
  audio.load();
  S.queue = [];
  S.unshuffledQueue = [];
  S.queueIndex = -1;
  S.isPlaying = false;
  document.getElementById("miniplayer").style.display = "none";
  document.getElementById("fullOverlay").classList.remove("show");
  updatePlayButtons();
  render();
  renderQueue();
  savePlaybackState();
  updateDiscordPresence();
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

// Usada pelo "Ouvir Junto" (sync.js) pra saber qual vai ser a próxima
// música ANTES dela realmente tocar, e assim já ir mandando o arquivo
// dela pro amigo em segundo plano. Só "espia" — não muda nada do estado
// atual de reprodução.
function peekNextTrackId(){
  if(S.repeat==="one") return S.queue[S.queueIndex] || null;
  let next = S.queueIndex+1;
  if(next>=S.queue.length){
    if(S.repeat==="all") next=0;
    else return null;
  }
  return S.queue[next] || null;
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
  // No momento do loadAndPlay(), o áudio às vezes ainda não tinha a duração
  // carregada, então a atividade ia pro Discord sem endTimestamp (barra de
  // progresso incompleta). Reenviar aqui garante a duração certa.
  updateDiscordPresence();
});
audio.addEventListener("timeupdate", schedulePlaybackSave);
audio.addEventListener("pause", ()=>{ S.isPlaying=false; updatePlayButtons(); updateDiscordPresence(); });
audio.addEventListener("play", ()=>{ S.isPlaying=true; updatePlayButtons(); updateDiscordPresence(); });

// "seeked" dispara toda vez que o usuário pula pra outro ponto da música
// (arrastando a barra, clicando nela, ou voltando pro início com "anterior").
// O debounce evita mandar uma atualização pro Discord a cada pixel enquanto
// o usuário ainda está arrastando — só manda a posição final, ~400ms depois
// de parar de mexer.
let seekDiscordDebounce = null;
audio.addEventListener("seeked", ()=>{
  clearTimeout(seekDiscordDebounce);
  seekDiscordDebounce = setTimeout(updateDiscordPresence, 400);
});

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

// Três estados de ícone, pra ele sempre condizer com o volume de verdade:
// mudo (0%) = alto-falante com um "X"; baixo (até 50%) = uma onda só;
// alto (acima de 50%) = duas ondas.
function volumeIconPaths(v){
  const speaker = `<path d="M11 5 6 9H2v6h4l5 4z"/>`;
  if(v<=0) return speaker + `<line x1="16" y1="9" x2="21" y2="14"/><line x1="21" y1="9" x2="16" y2="14"/>`;
  if(v<=0.5) return speaker + `<path d="M15.5 8.5a5 5 0 0 1 0 7"/>`;
  return speaker + `<path d="M15.5 8.5a5 5 0 0 1 0 7"/><path d="M18.5 5.5a9 9 0 0 1 0 13"/>`;
}
function setVolumeUI(v){
  document.getElementById("volFill").style.width=(v*100)+"%";
  document.getElementById("volHandle").style.left=(v*100)+"%";
  document.getElementById("fpVolFill").style.width=(v*100)+"%";
  document.getElementById("fpVolHandle").style.left=(v*100)+"%";
  const iconHtml = volumeIconPaths(v);
  const volIcon = document.getElementById("volIcon");
  const fpVolIcon = document.getElementById("fpVolIcon");
  if(volIcon) volIcon.innerHTML = iconHtml;
  if(fpVolIcon) fpVolIcon.innerHTML = iconHtml;
  const label = v<=0 ? "Ativar som" : "Silenciar";
  if(volIcon) volIcon.setAttribute("title", label);
  if(fpVolIcon) fpVolIcon.setAttribute("title", label);
}
function setVolume(v){
  if(v>0) volumeBeforeMute = v; // só guarda valores "reais", nunca o 0 do mudo
  S.volume = v; audio.volume = v;
  // Quando estou ouvindo a música do amigo (Ouvir Junto), quem realmente
  // toca o som é o elemento <audio> oculto do sync.js (Party.peerAudio),
  // não o <audio> principal — por isso o volume não tinha efeito nenhum.
  if(typeof Party!=="undefined" && Party.peerAudio) Party.peerAudio.volume = v;
  setVolumeUI(v); schedulePlaybackSave();
}
function toggleMute(){
  if(S.volume>0) setVolume(0);
  else setVolume(volumeBeforeMute>0 ? volumeBeforeMute : 0.9);
}
function bindVolBar(barId){
  const bar = document.getElementById(barId);
  let dragging=false;
  function apply(clientX){
    setVolume(seekFromClientX(bar, clientX));
  }
  bar.addEventListener("mousedown", e=>{ dragging=true; apply(e.clientX); });
  window.addEventListener("mousemove", e=>{ if(dragging) apply(e.clientX); });
  window.addEventListener("mouseup", ()=> dragging=false);
}
bindVolBar("volBar"); bindVolBar("fpVolBar");
["volIcon","fpVolIcon"].forEach(id=>{
  const el = document.getElementById(id);
  if(el) el.addEventListener("click", toggleMute);
});

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
document.getElementById("closePlayerBtn").addEventListener("click", closePlayer);

/* Expand to full player */
document.getElementById("mpTrackInfo").addEventListener("click", ()=>{
  // Quando a faixa ativa é a do amigo (Ouvir Junto), currentTrack() (a MINHA
  // fila local) fica vazio — por isso o clique não fazia nada nesse caso.
  // Aqui também aceitamos abrir a tela cheia se existe uma faixa ativa da party.
  const hasPartyTrack = typeof Party!=="undefined" && Party.connected && Party.activeSide==="peer" && Party.activeTrackMeta;
  if(!currentTrack() && !hasPartyTrack) return;
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
      await addTrackToPlaylist(p, trackId);
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
      const newPlaylist = {id:uid(), name, image:null, folderPath:null, trackIds: []};
      S.playlists.push(newPlaylist);
      await savePlaylists();
      if(addTrackIdAfterCreate){
        root.innerHTML="";
        render();
        await addTrackToPlaylist(newPlaylist, addTrackIdAfterCreate);
        return;
      }
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
  {
    version: "1.1.1",
    date: "2026",
    title: "Ouvir Junto + Volume",
    notes: "• Melhora geral na responsividade do aplicativo, com foco principal no mecanismo de busca.\n• Melhorias gerais no miniplayer.\n• Visual das funções do 'Ouvir Junto' aprimorado.\n• DK Player agora é reconhecido pelo Discord assim que é aberto.\n• O X do player agora encerra a música pros dois lados quando está no 'Ouvir Junto', em vez de fechar só pro seu lado.\n• Ícone de volume agora é clicável: muta a música na hora, e ao desmutar volta pro volume exato de antes.\n• Ícones de volume passam a mudar conforme o nível (mudo, baixo, alto), em vez de ficar sempre o mesmo.\n• Rich Presence do Discord não repete mais 'DK Player' na terceira linha do card — agora mostra o álbum da música (quando disponível).\n• Quando conectado no 'Ouvir Junto', o Discord mostra que você está ouvindo junto com um amigo.\n• Corrige o Discord mostrando 'Nenhuma música tocando' enquanto você ouvia a música compartilhada pelo seu amigo."
  },
  {
    version: "1.1.0",
    date: "2026",
    title: "Sync Update",
    notes: "• Novo modo 'Ouvir Junto', permitindo que duas pessoas escutem a mesma música sincronizada em tempo real.\n• Servidor dedicado 24 horas hospedado na Oracle Cloud para sincronização das sessões.\n• Suporte à leitura de metadados de arquivos MP3 (título, artista, álbum, duração e capa, quando disponíveis).\n• Interface modernizada com diversas melhorias visuais e de usabilidade.\n• Melhorias na estabilidade e no desempenho geral do aplicativo.\n• Correção de diversos bugs reportados pelos usuários.\n• Ajustes internos para tornar a reprodução mais confiável e responsiva."
  },
  {
    version: "1.0.2",
    date: "2026",
    notes: "• Corrige o modo aleatório, que continuava tocando músicas fora de ordem mesmo depois de desativado.\n• Ícone de repetição diferente para 'Repetir Todas' e 'Repetir Música Atual'.\n• Tela 'Sobre' agora é exibida em tela cheia, com botão de voltar e suporte à tecla Esc para fechar."
  },
  {
    version: "1.0.1",
    date: "2026",
    notes: "• Corrige um problema na barra de progresso da reprodução.\n• Adiciona o ícone oficial do DK Player."
  },
  {
    version: "1.0.0",
    date: "2026",
    notes: "• Lançamento inicial do DK Player."
  },
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
  const screen = document.getElementById("aboutScreen");
  screen.classList.add("show");
  // Sem isso, reabrir o "Sobre" mantinha a posição de scroll da última
  // vez (o navegador não reresseta scrollTop de um elemento só porque
  // ele volta a ficar visível) — sempre queremos começar do topo.
  screen.scrollTop = 0;
}
function closeAboutScreen(){
  document.getElementById("aboutScreen").classList.remove("show");
}
document.getElementById("aboutBtn").addEventListener("click", openAboutScreen);
document.getElementById("aboutBackBtn").addEventListener("click", closeAboutScreen);

function openSettingsScreen(){
  const screen = document.getElementById("settingsScreen");
  screen.classList.add("show");
  screen.scrollTop = 0;
  collapseSidebarIfNarrow();
}
function closeSettingsScreen(){
  document.getElementById("settingsScreen").classList.remove("show");
}
document.getElementById("settingsBtn").addEventListener("click", openSettingsScreen);
document.getElementById("settingsBackBtn").addEventListener("click", closeSettingsScreen);

// As notas de versão às vezes chegam do GitHub já em HTML (ex: <p>...</p>
// gerado pelo pipeline de release) e às vezes em texto puro (o fallback do
// CHANGELOG local). Isso normaliza os dois casos pra texto simples, e quem
// desenha na tela sempre escapa o resultado — então nunca sobra tag crua
// visível nem abre brecha de HTML injetado vindo de fora.
function htmlNotesToPlainText(input){
  return String(input||"")
    .replace(/<\/(p|div|li)>/gi, "\n")
    .replace(/<li[^>]*>/gi, "• ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0?39;/gi, "'")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/* ============================================================
   ATUALIZAÇÕES (auto-updater)
   O main.js manda "update-available" quando encontra uma versão nova no
   GitHub (sem baixar nada sozinho) e "update-downloaded" quando o download
   termina. Aqui a gente só decide o que mostrar em cada etapa.
============================================================ */
function openUpdateAvailableModal(version, notes){
  const root = document.getElementById("modalRoot");
  const fallback = CHANGELOG.find(c=>c.version===version);
  const rawText = (notes && notes.trim()) || fallback?.notes || "Melhorias e correções de bugs.";
  const text = htmlNotesToPlainText(rawText);
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal modal-lg">
        <h3>Nova versão disponível — v${escapeHtml(version)}</h3>
        <div class="changelog-notes" style="margin-bottom:20px;">${escapeHtml(text)}</div>
        <div class="update-progress-wrap" id="updateProgressWrap" style="display:none;">
          <div class="update-progress-bar"><div class="update-progress-fill" id="updateProgressFill"></div></div>
          <span class="update-progress-pct" id="updateProgressPct">0%</span>
        </div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="updateLaterBtn">Depois</button>
          <button class="btn btn-primary" id="updateNowBtn">Atualizar agora</button>
        </div>
      </div>
    </div>`;
  document.getElementById("updateLaterBtn").addEventListener("click", ()=> root.innerHTML="");
  document.getElementById("updateNowBtn").addEventListener("click", ()=>{
    const btn = document.getElementById("updateNowBtn");
    const laterBtn = document.getElementById("updateLaterBtn");
    btn.textContent = "Baixando...";
    btn.disabled = true;
    laterBtn.disabled = true; // evita abandonar o modal no meio do download
    document.getElementById("updateProgressWrap").style.display = "flex";
    window.dkAPI.startUpdateDownload();
  });
}
// O main.js precisa emitir isso a cada evento "download-progress" do
// electron-updater (ver window.dkAPI.onUpdateProgress no preload). Se esse
// canal ainda não existir, a barra simplesmente fica parada em 0% — o
// download continua funcionando, só sem feedback visual até o main.js
// mandar o progresso.
function updateDownloadProgress(percent){
  const fill = document.getElementById("updateProgressFill");
  const pct = document.getElementById("updateProgressPct");
  if(!fill || !pct) return;
  const clamped = Math.max(0, Math.min(100, Math.round(percent || 0)));
  fill.style.width = `${clamped}%`;
  pct.textContent = `${clamped}%`;
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
window.dkAPI.onUpdateProgress?.(({percent})=> updateDownloadProgress(percent));
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
    if(NARROW_SIDEBAR_QUERY.matches && document.getElementById("app").classList.contains("sidebar-expanded")){
      collapseSidebarIfNarrow();
      return;
    }
    const settingsScreen = document.getElementById("settingsScreen");
    if(settingsScreen.classList.contains("show")){
      closeSettingsScreen();
      return;
    }
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
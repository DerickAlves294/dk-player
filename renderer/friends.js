/* ============================================================
   AMIGOS — perfil "estilo Discord" (nome#tag, sem senha) + lista de
   amigos + pedidos de amizade + convite direto pro Ouvir Junto.
   ------------------------------------------------------------
   Por baixo dos panos usa autenticação ANÔNIMA do Firebase, só pra
   ter um UID estável que libera as regras de segurança do Firestore
   — a pessoa nunca vê tela de login, só escolhe um nome na primeira
   vez e ganha uma tag numérica junto (tipo "DK#4821").

   Depende de funções globais já definidas em app.js (escapeHtml,
   showToast, Store, uid) e em sync.js (Party, createParty, joinParty)
   — por isso este arquivo precisa carregar DEPOIS dos dois.
============================================================ */

// >>> TROQUE AQUI pelas credenciais do SEU projeto Firebase.
// Console do Firebase > Configurações do projeto > Geral > "Seus apps"
// > ícone </> (Web) > "Configuração do SDK". Também é onde você ativa,
// em "Build": Authentication (método "Anônimo") e Firestore Database.
const FIREBASE_CONFIG = {
  apiKey: "COLE_SUA_API_KEY_AQUI",
  authDomain: "SEU-PROJETO.firebaseapp.com",
  projectId: "SEU-PROJETO",
  storageBucket: "SEU-PROJETO.appspot.com",
  messagingSenderId: "COLE_AQUI",
  appId: "COLE_AQUI",
};

// >>> Quando a área de Amigos estiver pronta pra ser lançada pra valer,
// troque pra "false" — o fluxo normal (perfil, pedidos, lista de amigos)
// volta a funcionar e o placeholder "Em breve" some sozinho.
const FRIENDS_COMING_SOON = true;

let db = null;
let fbAuth = null;
const Friends = {
  uid: null,
  profile: null,        // {name, tag}
  list: [],              // [{uid, name, tag, online, activePartyCode}]
  incomingRequests: [],  // [{id, fromUid, fromName, fromTag}]
  unsubFriends: null,
  unsubRequests: null,
  unsubInvites: null,
  heartbeatTimer: null,
  presenceIntervalTimer: null,
};

function friendKey(name, tag){ return `${String(name).toLowerCase()}#${tag}`; }
function randomTag(){ return String(Math.floor(1000 + Math.random()*9000)); }
function initials(name){ return String(name||"?").trim().slice(0,2).toUpperCase(); }

/* ============================================================
   IDENTIDADE — autentica anonimamente e garante que existe um perfil
   (local, via Store, e espelhado no Firestore)
============================================================ */
async function ensureSignedIn(){
  if(fbAuth.currentUser) return fbAuth.currentUser;
  const cred = await fbAuth.signInAnonymously();
  return cred.user;
}

async function pickFreeTag(name){
  const lower = String(name).toLowerCase();
  for(let i=0;i<20;i++){
    const tag = randomTag();
    const snap = await db.collection("users").where("nameTagLower","==",`${lower}#${tag}`).limit(1).get();
    if(snap.empty) return tag;
  }
  return randomTag(); // caso improvável de 20 colisões seguidas — segue mesmo assim
}

function promptForFriendName(){
  return new Promise(resolve=>{
    const root = document.getElementById("modalRoot");
    root.innerHTML = `
      <div class="modal-backdrop" id="friendNameBackdrop">
        <div class="modal">
          <h3>Como podemos te chamar?</h3>
          <p>Esse é o nome que seus amigos vão ver pra te adicionar — você ganha uma tag numérica junto (tipo Discord), então pode repetir nome com outras pessoas sem problema.</p>
          <input type="text" id="friendNameInput" maxlength="24" placeholder="Seu nome" />
          <div class="modal-actions">
            <button class="btn btn-primary" id="friendNameConfirmBtn">Confirmar</button>
          </div>
        </div>
      </div>`;
    const input = document.getElementById("friendNameInput");
    input.focus();
    const confirm = ()=>{
      const name = input.value.trim();
      if(!name) return;
      root.innerHTML = "";
      resolve(name);
    };
    document.getElementById("friendNameConfirmBtn").addEventListener("click", confirm);
    input.addEventListener("keydown", e=>{ if(e.key==="Enter") confirm(); });
  });
}

async function ensureProfile(){
  const user = await ensureSignedIn();
  Friends.uid = user.uid;

  const saved = await Store.get("friendProfile"); // {name, tag}
  if(saved && saved.name && saved.tag){
    Friends.profile = saved;
    // Idempotente: garante que o doc no Firestore existe/está atualizado
    // (cobre o caso de o app ter sido reinstalado com o mesmo perfil local).
    await db.collection("users").doc(Friends.uid).set({
      name: saved.name, tag: saved.tag,
      nameTagLower: friendKey(saved.name, saved.tag),
    }, {merge:true});
    return;
  }

  const name = await promptForFriendName();
  const tag = await pickFreeTag(name);
  Friends.profile = {name, tag};
  await Store.set("friendProfile", Friends.profile);
  await db.collection("users").doc(Friends.uid).set({
    name, tag, nameTagLower: friendKey(name, tag),
    createdAt: firebase.firestore.FieldValue.serverTimestamp(),
  }, {merge:true});
  showToast(`Pronto! Você é ${name}#${tag}`);
}

/* ============================================================
   PRESENÇA — "online" com heartbeat periódico (sem Realtime Database
   não dá pra ter onDisconnect de verdade, então em fechamentos abruptos
   o status pode ficar defasado até expirar por tempo — ver
   isRecentlyOnline). A cada batida também espelha se está numa party
   ativa, pra lista de amigos mostrar "Na sua party" sem precisar mexer
   no sync.js.
============================================================ */
function startPresenceHeartbeat(){
  const beat = ()=> db.collection("users").doc(Friends.uid).set({
    online:true,
    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    activePartyCode: (typeof Party!=="undefined" && Party.connected && Party.code) ? Party.code : null,
  }, {merge:true}).catch(()=>{});
  beat();
  Friends.heartbeatTimer = setInterval(beat, 30000);

  document.addEventListener("visibilitychange", ()=>{
    db.collection("users").doc(Friends.uid).set({
      online: document.visibilityState==="visible",
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    }, {merge:true}).catch(()=>{});
  });
  window.addEventListener("beforeunload", ()=>{
    // Melhor esforço só — não há garantia de que esse write chega a
    // sair antes do processo fechar de vez.
    db.collection("users").doc(Friends.uid).update({online:false}).catch(()=>{});
  });
}
function isRecentlyOnline(userDoc){
  if(!userDoc || !userDoc.online) return false;
  const last = userDoc.lastSeen && userDoc.lastSeen.toDate ? userDoc.lastSeen.toDate() : null;
  if(!last) return true; // acabou de escrever, ainda sem confirmação do servidor
  return (Date.now() - last.getTime()) < 90000; // 90s de tolerância (3x o intervalo do heartbeat)
}

/* ============================================================
   PEDIDOS DE AMIZADE
============================================================ */
function parseNameTag(input){
  const m = /^(.+)#(\d{3,6})$/.exec(String(input).trim());
  if(!m) return null;
  return {name:m[1].trim(), tag:m[2].trim()};
}

async function sendFriendRequest(){
  const status = document.getElementById("friendSearchStatus");
  const input = document.getElementById("friendSearchInput");
  const parsed = parseNameTag(input.value);
  if(!parsed){ status.textContent = "Use o formato nome#0000."; return; }

  const key = friendKey(parsed.name, parsed.tag);
  if(key === friendKey(Friends.profile.name, Friends.profile.tag)){
    status.textContent = "Esse é você :)";
    return;
  }

  status.textContent = "Procurando...";
  try{
    const snap = await db.collection("users").where("nameTagLower","==",key).limit(1).get();
    if(snap.empty){ status.textContent = "Ninguém encontrado com esse nome#tag."; return; }

    const target = snap.docs[0];
    const targetUid = target.id;
    const targetData = target.data();

    if(Friends.list.some(f=>f.uid===targetUid)){ status.textContent = "Vocês já são amigos."; return; }

    const existing = await db.collection("friendRequests")
      .where("fromUid","==",Friends.uid).where("toUid","==",targetUid).where("status","==","pending").limit(1).get();
    if(!existing.empty){ status.textContent = "Pedido já enviado, aguardando resposta."; return; }

    await db.collection("friendRequests").add({
      fromUid: Friends.uid, fromName: Friends.profile.name, fromTag: Friends.profile.tag,
      toUid: targetUid, toName: targetData.name, toTag: targetData.tag,
      status: "pending", createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    status.textContent = `Pedido enviado pra ${targetData.name}#${targetData.tag}!`;
    input.value = "";
  }catch(e){
    console.warn("falha ao enviar pedido de amizade", e);
    status.textContent = "Algo deu errado. Tenta de novo.";
  }
}

function listenIncomingRequests(){
  Friends.unsubRequests = db.collection("friendRequests")
    .where("toUid","==",Friends.uid).where("status","==","pending")
    .onSnapshot(snap=>{
      Friends.incomingRequests = snap.docs.map(d=>({id:d.id, ...d.data()}));
      renderFriendRequests();
    }, e=>console.warn("listener de pedidos falhou", e));
}

async function acceptFriendRequest(reqId, fromUid, fromName, fromTag){
  try{
    const batch = db.batch();
    const myRef = db.collection("users").doc(Friends.uid).collection("friends").doc(fromUid);
    const theirRef = db.collection("users").doc(fromUid).collection("friends").doc(Friends.uid);
    batch.set(myRef, {name:fromName, tag:fromTag, since: firebase.firestore.FieldValue.serverTimestamp()});
    batch.set(theirRef, {name:Friends.profile.name, tag:Friends.profile.tag, since: firebase.firestore.FieldValue.serverTimestamp()});
    batch.update(db.collection("friendRequests").doc(reqId), {status:"accepted"});
    await batch.commit();
    showToast(`Agora você e ${fromName}#${fromTag} são amigos!`);
  }catch(e){
    console.warn("falha ao aceitar pedido", e);
    showToast("Não foi possível aceitar o pedido agora.");
  }
}
async function declineFriendRequest(reqId){
  try{ await db.collection("friendRequests").doc(reqId).update({status:"declined"}); }
  catch(e){ console.warn("falha ao recusar pedido", e); }
}

/* ============================================================
   LISTA DE AMIGOS + STATUS ONLINE
============================================================ */
function listenFriendsList(){
  Friends.unsubFriends = db.collection("users").doc(Friends.uid).collection("friends")
    .onSnapshot(async snap=>{
      Friends.list = snap.docs.map(d=>({uid:d.id, name:d.data().name, tag:d.data().tag}));
      renderFriendsList(); // desenha na hora sem status online, refina abaixo
      await refreshFriendsPresence();
    }, e=>console.warn("listener de amigos falhou", e));

  // Não é um listener em tempo real (evitaria uma leitura por amigo, o
  // tempo todo) — refresca a cada 60s enquanto a lista não estiver vazia.
  Friends.presenceIntervalTimer = setInterval(()=>{
    if(Friends.list.length) refreshFriendsPresence();
  }, 60000);
}

async function refreshFriendsPresence(){
  if(!Friends.list.length) return;
  const chunks = [];
  for(let i=0;i<Friends.list.length;i+=10) chunks.push(Friends.list.slice(i,i+10));

  const statusMap = {};
  try{
    for(const chunk of chunks){
      const uids = chunk.map(f=>f.uid);
      const snap = await db.collection("users").where(firebase.firestore.FieldPath.documentId(),"in",uids).get();
      snap.forEach(doc=>{ statusMap[doc.id] = doc.data(); });
    }
  }catch(e){ console.warn("falha ao atualizar presença dos amigos", e); }

  Friends.list = Friends.list.map(f=>({
    ...f,
    online: isRecentlyOnline(statusMap[f.uid]),
    activePartyCode: statusMap[f.uid] ? (statusMap[f.uid].activePartyCode || null) : null,
  }));
  renderFriendsList();
}

/* ============================================================
   CONVITE PRO OUVIR JUNTO — cria a party (se ainda não tiver uma) e
   manda o código pro amigo via Firestore; ele vê um banner com "Entrar".
============================================================ */
function waitForPartyCode(timeoutMs=8000){
  return new Promise((resolve,reject)=>{
    const start = Date.now();
    (function check(){
      if(typeof Party!=="undefined" && Party.code){ resolve(Party.code); return; }
      if(Date.now()-start > timeoutMs){ reject(new Error("timeout esperando o código da party")); return; }
      setTimeout(check, 200);
    })();
  });
}

async function inviteFriendToParty(friendUid, friendName, friendTag){
  try{
    const hasParty = typeof Party!=="undefined" && Party.code && (Party.connected || Party.role==="host");
    if(!hasParty){
      showToast("Criando a party...");
      await createParty();
    }
    const code = await waitForPartyCode();
    await db.collection("users").doc(friendUid).collection("partyInvites").add({
      fromUid: Friends.uid, fromName: Friends.profile.name, fromTag: Friends.profile.tag,
      partyCode: code, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("users").doc(Friends.uid).set({activePartyCode: code}, {merge:true});
    showToast(`Convite enviado pra ${friendName}#${friendTag}!`);
  }catch(e){
    console.warn("falha ao convidar amigo pra party", e);
    showToast("Não foi possível convidar agora.");
  }
}

function listenPartyInvites(){
  Friends.unsubInvites = db.collection("users").doc(Friends.uid).collection("partyInvites")
    .onSnapshot(snap=>{
      snap.docChanges().forEach(change=>{
        if(change.type==="added") showPartyInviteBanner(change.doc.id, change.doc.data());
      });
    }, e=>console.warn("listener de convites falhou", e));
}

function showPartyInviteBanner(inviteId, data){
  const banner = document.getElementById("partyInviteBanner");
  if(!banner) return;
  banner.innerHTML = `
    <span>${escapeHtml(data.fromName)}<span class="friend-tag">#${escapeHtml(data.fromTag)}</span> te chamou pro Ouvir Junto</span>
    <button class="btn btn-primary" id="partyInviteAcceptBtn" type="button">Entrar</button>
    <button class="btn btn-ghost" id="partyInviteDismissBtn" type="button">Ignorar</button>`;
  banner.style.display = "flex";

  const cleanup = async ()=>{
    banner.style.display = "none";
    try{ await db.collection("users").doc(Friends.uid).collection("partyInvites").doc(inviteId).delete(); }
    catch(e){ /* silencioso — não é crítico se sobrar um convite antigo */ }
  };
  document.getElementById("partyInviteAcceptBtn").addEventListener("click", async ()=>{
    const code = data.partyCode;
    await cleanup();
    if(typeof joinParty === "function") joinParty(code);
  });
  document.getElementById("partyInviteDismissBtn").addEventListener("click", cleanup);
}

/* ============================================================
   RENDERIZAÇÃO — tela de Amigos
============================================================ */
function renderProfileCard(){
  const card = document.getElementById("friendsProfileCard");
  if(!card || !Friends.profile) return;
  card.innerHTML = `Você é <strong>${escapeHtml(Friends.profile.name)}</strong><span class="friend-tag">#${escapeHtml(Friends.profile.tag)}</span>`;
}

function renderFriendRequests(){
  const block = document.getElementById("friendRequestsBlock");
  const list = document.getElementById("friendRequestsList");
  if(!block || !list) return;
  if(!Friends.incomingRequests.length){ block.style.display = "none"; list.innerHTML = ""; return; }

  block.style.display = "flex";
  list.innerHTML = Friends.incomingRequests.map(r => `
    <div class="friend-item">
      <div class="friend-avatar">${escapeHtml(initials(r.fromName))}</div>
      <div class="friend-meta">
        <div class="friend-name">${escapeHtml(r.fromName)}<span class="friend-tag">#${escapeHtml(r.fromTag)}</span></div>
        <div class="friend-sub">quer ser seu amigo</div>
      </div>
      <div class="friend-actions">
        <button class="btn btn-primary friend-accept-btn" data-req="${escapeHtml(r.id)}" data-uid="${escapeHtml(r.fromUid)}" data-name="${escapeHtml(r.fromName)}" data-tag="${escapeHtml(r.fromTag)}" type="button">Aceitar</button>
        <button class="btn btn-ghost friend-decline-btn" data-req="${escapeHtml(r.id)}" type="button">Recusar</button>
      </div>
    </div>`).join("");

  list.querySelectorAll(".friend-accept-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> acceptFriendRequest(btn.dataset.req, btn.dataset.uid, btn.dataset.name, btn.dataset.tag));
  });
  list.querySelectorAll(".friend-decline-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> declineFriendRequest(btn.dataset.req));
  });
}

function renderFriendsList(){
  const list = document.getElementById("friendsList");
  if(!list) return;
  if(!Friends.list.length){
    list.innerHTML = `<div class="queue-empty">Você ainda não tem amigos adicionados.</div>`;
    return;
  }

  const sorted = [...Friends.list].sort((a,b)=> (b.online - a.online) || a.name.localeCompare(b.name));
  list.innerHTML = sorted.map(f=>{
    const inSameParty = typeof Party!=="undefined" && Party.connected && Party.code && f.activePartyCode===Party.code;
    let actionHtml = "";
    if(inSameParty){
      actionHtml = `<span class="friend-sub" style="color:var(--accent);">Na sua party</span>`;
    } else if(f.online){
      actionHtml = `<button class="btn btn-ghost friend-invite-btn" data-uid="${escapeHtml(f.uid)}" data-name="${escapeHtml(f.name)}" data-tag="${escapeHtml(f.tag)}" type="button">Convidar</button>`;
    }
    return `
    <div class="friend-item">
      <div class="friend-avatar">${escapeHtml(initials(f.name))}</div>
      <div class="friend-meta">
        <div class="friend-name">${escapeHtml(f.name)}<span class="friend-tag">#${escapeHtml(f.tag)}</span></div>
        <div class="friend-sub"><span class="status-dot ${f.online?"ok":""}"></span>${f.online?"Online":"Offline"}</div>
      </div>
      <div class="friend-actions">${actionHtml}</div>
    </div>`;
  }).join("");

  list.querySelectorAll(".friend-invite-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> inviteFriendToParty(btn.dataset.uid, btn.dataset.name, btn.dataset.tag));
  });
}

/* ============================================================
   TELA — abrir/fechar (segue o mesmo padrão de Configurações/Sobre)
============================================================ */
function openFriendsScreen(){
  const screen = document.getElementById("friendsScreen");
  if(!screen) return;
  screen.classList.add("show");
  screen.classList.toggle("coming-soon", FRIENDS_COMING_SOON);
  screen.scrollTop = 0;
  if(typeof collapseSidebarIfNarrow === "function") collapseSidebarIfNarrow();
  if(FRIENDS_COMING_SOON) return; // tela "Em breve": nada pra carregar ainda
  renderProfileCard();
  renderFriendRequests();
  renderFriendsList();
}
function closeFriendsScreen(){
  document.getElementById("friendsScreen")?.classList.remove("show");
}
document.getElementById("friendsBtn")?.addEventListener("click", openFriendsScreen);
document.getElementById("friendsBackBtn")?.addEventListener("click", closeFriendsScreen);
document.getElementById("friendSearchBtn")?.addEventListener("click", sendFriendRequest);
document.getElementById("friendSearchInput")?.addEventListener("keydown", e=>{ if(e.key==="Enter") sendFriendRequest(); });
// Listener de Esc próprio (independente do de app.js) só pra essa tela —
// não conflita porque o handler de app.js não conhece o friendsScreen e
// simplesmente não faz nada quando só ele está aberto.
document.addEventListener("keydown", e=>{
  if(e.key!=="Escape") return;
  const screen = document.getElementById("friendsScreen");
  if(screen && screen.classList.contains("show")) closeFriendsScreen();
});

/* ============================================================
   INICIALIZAÇÃO
============================================================ */
async function initFriends(){
  // Enquanto a área de Amigos está marcada como "Em breve", nem tenta
  // conectar no Firebase — evita esforço à toa e o aviso no console
  // (o FIREBASE_CONFIG nem precisa estar preenchido ainda).
  if(FRIENDS_COMING_SOON) return;
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    db = firebase.firestore();

    await ensureProfile();
    startPresenceHeartbeat();
    listenFriendsList();
    listenIncomingRequests();
    listenPartyInvites();
  }catch(e){
    console.warn("Não foi possível iniciar o sistema de Amigos — confira o FIREBASE_CONFIG em friends.js", e);
  }
}
initFriends();

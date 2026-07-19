/* ============================================================
   AMIGOS — conta com e-mail/senha, nome editável + código único
   imutável, lista de amigos com presença (online/offline, "visto por
   último", música tocando agora), pedidos de amizade, convite direto
   pro Ouvir Junto, remover amigo e excluir conta.
   ------------------------------------------------------------
   Depende de funções globais já definidas em app.js (escapeHtml,
   showToast, Store, currentTrack, closeCtxMenu, closeCtxMenuOnOutside)
   e em sync.js (Party, createParty, joinParty) — por isso este arquivo
   precisa carregar DEPOIS dos dois.
============================================================ */

// >>> TROQUE AQUI pelas credenciais do SEU projeto Firebase.
// Console do Firebase > Configurações do projeto > Geral > "Seus apps"
// > ícone </> (Web) > "Configuração do SDK". Também é onde você ativa,
// em "Build": Authentication (método "E-mail/senha") e Firestore Database.
const FIREBASE_CONFIG = {
  apiKey: "AIzaSyBM5UjSO3LmWBjaPKUTj3bRaYu16u-OU58",
  authDomain: "dk-player-d0385.firebaseapp.com",
  projectId: "dk-player-d0385",
  storageBucket: "dk-player-d0385.firebasestorage.app",
  messagingSenderId: "346431104504",
  appId: "1:346431104504:web:c08de9e036e51f9269220d",
};

// >>> Quando a área de Amigos estiver pronta pra ser lançada pra valer,
// troque pra "false" — o fluxo normal (login, perfil, pedidos, lista de
// amigos) volta a funcionar e o placeholder "Em breve" some sozinho.
const FRIENDS_COMING_SOON = false;

let db = null;
let fbAuth = null;
let friendsAuthMode = "login"; // "login" | "signup"
let signupInFlight = false; // suprime o onAuthStateChanged automático durante o cadastro (ver handleSignup)

const Friends = {
  uid: null,
  profile: null,        // {name, code}
  list: [],              // [{uid, name, code, online, lastSeen, activePartyCode, nowPlaying}]
  incomingRequests: [],  // [{id, fromUid, fromName, fromCode}]
  unsubFriends: null,
  unsubRequests: null,
  unsubInvites: null,
  heartbeatTimer: null,
  presenceIntervalTimer: null,
};

function initials(name){ return String(name||"?").trim().slice(0,2).toUpperCase(); }
function $id(id){ return document.getElementById(id); }

/* ============================================================
   VALIDAÇÃO E MENSAGENS DE ERRO
============================================================ */
function validateCode(code){
  if(!code) return "Escolhe um código único.";
  if(!/^[a-z0-9_]{3,20}$/.test(code)) return "Código: 3 a 20 caracteres, só letras minúsculas, números e _.";
  return null;
}
function friendlyAuthError(e){
  const map = {
    "auth/email-already-in-use": "Esse e-mail já tem uma conta.",
    "auth/invalid-email": "E-mail inválido.",
    "auth/weak-password": "Senha muito fraca (mínimo 6 caracteres).",
    "auth/user-not-found": "E-mail ou senha incorretos.",
    "auth/wrong-password": "E-mail ou senha incorretos.",
    "auth/invalid-credential": "E-mail ou senha incorretos.",
    "auth/too-many-requests": "Muitas tentativas — espera um pouco e tenta de novo.",
  };
  return map[e?.code] || "Algo deu errado. Tenta de novo.";
}

/* ============================================================
   AUTENTICAÇÃO — entrar / criar conta
============================================================ */
function setAuthMode(mode){
  friendsAuthMode = mode;
  const isSignup = mode === "signup";
  $id("friendsSignupNameField").style.display = isSignup ? "block" : "none";
  $id("friendsSignupCodeField").style.display = isSignup ? "block" : "none";
  $id("friendsAuthTitle").textContent = isSignup ? "Criar conta" : "Entrar";
  $id("friendsAuthSub").textContent = isSignup
    ? "Escolhe um nome e um código único — o código não muda depois."
    : "Entre com sua conta pra adicionar amigos e ouvir junto.";
  $id("friendsAuthSubmitBtn").textContent = isSignup ? "Criar conta" : "Entrar";
  $id("friendsAuthToggleText").textContent = isSignup ? "Já tem conta?" : "Não tem conta?";
  $id("friendsAuthToggleBtn").textContent = isSignup ? "Entrar" : "Criar conta";
  $id("friendsAuthError").textContent = "";
}
function setAuthSubmitLoading(loading){
  const btn = $id("friendsAuthSubmitBtn");
  if(!btn) return;
  btn.disabled = loading;
  if(loading){ btn.dataset.origText = btn.textContent; btn.textContent = "Aguarda..."; }
  else if(btn.dataset.origText){ btn.textContent = btn.dataset.origText; }
}

async function handleSignup(){
  const name = $id("friendsAuthName").value.trim();
  const code = $id("friendsAuthCode").value.trim().toLowerCase();
  const email = $id("friendsAuthEmail").value.trim();
  const password = $id("friendsAuthPassword").value;
  const errorEl = $id("friendsAuthError");
  errorEl.textContent = "";

  if(!name){ errorEl.textContent = "Escolhe um nome."; return; }
  const codeError = validateCode(code);
  if(codeError){ errorEl.textContent = codeError; return; }
  if(!email || !password){ errorEl.textContent = "Preenche e-mail e senha."; return; }
  if(password.length < 6){ errorEl.textContent = "A senha precisa ter pelo menos 6 caracteres."; return; }

  setAuthSubmitLoading(true);
  signupInFlight = true; // suprime o onAuthStateChanged automático até a gente terminar de escrever os documentos
  let createdUser = null;
  try{
    // A checagem de disponibilidade do código precisa rolar ANTES do login
    // (ainda não temos uid pra passar nas regras de segurança da coleção
    // "users") — por isso usa a coleção separada "usernames", que só guarda
    // código -> uid e tem leitura pública liberada nas regras.
    const codeDoc = await db.collection("usernames").doc(code).get();
    if(codeDoc.exists){ errorEl.textContent = "Esse código já está em uso."; return; }

    const cred = await fbAuth.createUserWithEmailAndPassword(email, password);
    createdUser = cred.user;

    const batch = db.batch();
    batch.set(db.collection("users").doc(createdUser.uid), {
      name, code, email,
      createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    batch.set(db.collection("usernames").doc(code), {uid: createdUser.uid});
    await batch.commit();

    showToast(`Conta criada! Bem-vindo(a), ${name}.`);
    await startFriendsSession(createdUser); // a gente mesmo inicia a sessão, já que suprimimos o listener automático
  }catch(e){
    console.warn("falha no cadastro", e);
    errorEl.textContent = friendlyAuthError(e);
    if(createdUser) await createdUser.delete().catch(()=>{}); // desfaz a conta se o cadastro não terminou de verdade
  }finally{
    setAuthSubmitLoading(false);
    signupInFlight = false;
  }
}

async function handleLogin(){
  const email = $id("friendsAuthEmail").value.trim();
  const password = $id("friendsAuthPassword").value;
  const errorEl = $id("friendsAuthError");
  errorEl.textContent = "";
  if(!email || !password){ errorEl.textContent = "Preenche e-mail e senha."; return; }

  setAuthSubmitLoading(true);
  try{
    await fbAuth.signInWithEmailAndPassword(email, password);
  }catch(e){
    console.warn("falha no login", e);
    errorEl.textContent = friendlyAuthError(e);
  }finally{
    setAuthSubmitLoading(false);
  }
}

/* ============================================================
   PRESENÇA — heartbeat periódico com status online + o que está
   tocando agora. Sem Realtime Database não dá pra ter onDisconnect de
   verdade, então em fechamentos abruptos o status pode ficar defasado
   até expirar por tempo (ver isRecentlyOnline).
============================================================ */
function currentNowPlaying(){
  const inParty = typeof Party !== "undefined" && Party.connected;
  const listeningToPeer = inParty && Party.activeSide === "peer" && Party.activeTrackMeta;
  const t = listeningToPeer ? null : (typeof currentTrack === "function" ? currentTrack() : null);
  const title = listeningToPeer ? Party.activeTrackMeta.title : t?.title;
  const artist = listeningToPeer ? Party.activeTrackMeta.artist : t?.artist;
  const playing = listeningToPeer ? !!Party.isPlaying : !!(typeof S !== "undefined" && S.isPlaying);
  if(!title || !playing) return null;
  return {title, artist: artist || ""};
}
function startPresenceHeartbeat(){
  const beat = ()=> db.collection("users").doc(Friends.uid).set({
    online:true,
    lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    activePartyCode: (typeof Party!=="undefined" && Party.connected && Party.code) ? Party.code : null,
    nowPlaying: currentNowPlaying(),
  }, {merge:true}).catch(()=>{});
  beat();
  Friends.heartbeatTimer = setInterval(beat, 20000);

  document.addEventListener("visibilitychange", ()=>{
    if(!Friends.uid) return;
    db.collection("users").doc(Friends.uid).set({
      online: document.visibilityState==="visible",
      lastSeen: firebase.firestore.FieldValue.serverTimestamp(),
    }, {merge:true}).catch(()=>{});
  });
  window.addEventListener("beforeunload", ()=>{
    if(!Friends.uid) return;
    // Melhor esforço só — não há garantia de que esse write chega a
    // sair antes do processo fechar de vez.
    db.collection("users").doc(Friends.uid).update({online:false}).catch(()=>{});
  });
}
function isRecentlyOnline(userDoc){
  if(!userDoc || !userDoc.online) return false;
  const last = userDoc.lastSeen && userDoc.lastSeen.toDate ? userDoc.lastSeen.toDate() : null;
  if(!last) return true;
  return (Date.now() - last.getTime()) < 60000; // 3x o intervalo do heartbeat
}
function formatLastSeen(date){
  if(!date) return "offline";
  const diffMs = Date.now() - date.getTime();
  const min = Math.floor(diffMs/60000);
  if(min < 1) return "visto agora mesmo";
  if(min < 60) return `visto há ${min} min`;
  const h = Math.floor(min/60);
  if(h < 24) return `visto há ${h}h`;
  const d = Math.floor(h/24);
  if(d === 1) return "visto ontem";
  if(d < 7) return `visto há ${d} dias`;
  return `visto em ${date.toLocaleDateString("pt-BR")}`;
}
function friendStatusLine(f){
  if(f.online && f.nowPlaying){
    return {text:`Ouvindo: ${f.nowPlaying.title}${f.nowPlaying.artist?` — ${f.nowPlaying.artist}`:""}`, playing:true};
  }
  if(f.online) return {text:"Online", playing:false};
  return {text: formatLastSeen(f.lastSeen), playing:false};
}

/* ============================================================
   PEDIDOS DE AMIZADE
============================================================ */
function openAddFriendModal(){
  const root = $id("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>Adicionar amigo</h3>
        <p>Peça pro seu amigo abrir o perfil dele (botão "Perfil" lá em cima) pra pegar o código.</p>
        <input type="text" id="addFriendCodeInput" placeholder="código do amigo (ex: dk294)" maxlength="20" />
        <div class="friends-auth-error" id="addFriendStatus"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="addFriendCancelBtn" type="button">Cancelar</button>
          <button class="btn btn-primary" id="addFriendSendBtn" type="button">Enviar pedido</button>
        </div>
      </div>
    </div>`;
  const input = $id("addFriendCodeInput");
  input.focus();
  $id("addFriendCancelBtn").addEventListener("click", ()=> root.innerHTML="");
  $id("addFriendSendBtn").addEventListener("click", sendFriendRequestFromModal);
  input.addEventListener("keydown", e=>{ if(e.key==="Enter") sendFriendRequestFromModal(); });
}

async function sendFriendRequestFromModal(){
  const input = $id("addFriendCodeInput");
  const status = $id("addFriendStatus");
  const code = input.value.trim().toLowerCase();
  if(!code){ status.textContent = "Digita um código."; return; }
  if(code === Friends.profile.code){ status.textContent = "Esse é você :)"; return; }

  status.textContent = "Procurando...";
  try{
    const snap = await db.collection("users").where("code","==",code).limit(1).get();
    if(snap.empty){ status.textContent = "Ninguém encontrado com esse código."; return; }

    const target = snap.docs[0];
    const targetUid = target.id;
    const targetData = target.data();

    if(Friends.list.some(f=>f.uid===targetUid)){ status.textContent = "Vocês já são amigos."; return; }

    const existing = await db.collection("friendRequests")
      .where("fromUid","==",Friends.uid).where("toUid","==",targetUid).where("status","==","pending").limit(1).get();
    if(!existing.empty){ status.textContent = "Pedido já enviado, aguardando resposta."; return; }

    await db.collection("friendRequests").add({
      fromUid: Friends.uid, fromName: Friends.profile.name, fromCode: Friends.profile.code,
      toUid: targetUid, toName: targetData.name, toCode: targetData.code,
      status: "pending", createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    status.textContent = `Pedido enviado pra ${targetData.name}!`;
    setTimeout(()=>{ const r = $id("modalRoot"); if(r) r.innerHTML=""; }, 900);
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

async function acceptFriendRequest(reqId, fromUid, fromName, fromCode){
  try{
    const batch = db.batch();
    const myRef = db.collection("users").doc(Friends.uid).collection("friends").doc(fromUid);
    const theirRef = db.collection("users").doc(fromUid).collection("friends").doc(Friends.uid);
    batch.set(myRef, {name:fromName, code:fromCode, since: firebase.firestore.FieldValue.serverTimestamp()});
    batch.set(theirRef, {name:Friends.profile.name, code:Friends.profile.code, since: firebase.firestore.FieldValue.serverTimestamp()});
    batch.update(db.collection("friendRequests").doc(reqId), {status:"accepted"});
    await batch.commit();
    showToast(`Agora você e ${fromName} são amigos!`);
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
   REMOVER AMIGO
============================================================ */
function openFriendMenu(e, friendUid, friendName){
  if(typeof closeCtxMenu === "function") closeCtxMenu();
  const rect = e.currentTarget.getBoundingClientRect();
  const root = $id("ctxRoot");
  if(!root) return;
  root.innerHTML = `
    <div class="ctx-menu" style="top:${Math.min(rect.bottom+6, window.innerHeight-120)}px; left:${Math.min(rect.left-160, window.innerWidth-220)}px;">
      <button class="ctx-item" data-action="remove-friend" style="color:var(--danger);">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6 6 18M6 6l12 12"/></svg>
        Remover amigo
      </button>
    </div>`;
  root.querySelector('[data-action="remove-friend"]').addEventListener("click", ()=>{
    if(typeof closeCtxMenu === "function") closeCtxMenu();
    confirmRemoveFriend(friendUid, friendName);
  });
  setTimeout(()=> document.addEventListener("click", closeCtxMenuOnOutside), 0);
}
function confirmRemoveFriend(friendUid, friendName){
  const root = $id("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>Remover ${escapeHtml(friendName)}?</h3>
        <p>Vocês deixam de ser amigos. Se mudar de ideia, precisa mandar um novo pedido.</p>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="removeFriendCancelBtn" type="button">Cancelar</button>
          <button class="btn btn-danger" id="removeFriendConfirmBtn" type="button">Remover</button>
        </div>
      </div>
    </div>`;
  $id("removeFriendCancelBtn").addEventListener("click", ()=> root.innerHTML="");
  $id("removeFriendConfirmBtn").addEventListener("click", async ()=>{
    root.innerHTML = "";
    await removeFriend(friendUid);
  });
}
async function removeFriend(friendUid){
  try{
    await db.collection("users").doc(Friends.uid).collection("friends").doc(friendUid).delete();
    await db.collection("users").doc(friendUid).collection("friends").doc(Friends.uid).delete();
    showToast("Amigo removido.");
  }catch(e){
    console.warn("falha ao remover amigo", e);
    showToast("Não foi possível remover agora.");
  }
}

/* ============================================================
   LISTA DE AMIGOS + PRESENÇA
============================================================ */
function listenFriendsList(){
  Friends.unsubFriends = db.collection("users").doc(Friends.uid).collection("friends")
    .onSnapshot(async snap=>{
      Friends.list = snap.docs.map(d=>({uid:d.id, name:d.data().name, code:d.data().code}));
      renderFriendsList();
      await refreshFriendsPresence();
    }, e=>console.warn("listener de amigos falhou", e));

  Friends.presenceIntervalTimer = setInterval(()=>{
    if(Friends.list.length) refreshFriendsPresence();
  }, 45000);
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

  Friends.list = Friends.list.map(f=>{
    const data = statusMap[f.uid];
    return {
      ...f,
      online: isRecentlyOnline(data),
      lastSeen: data?.lastSeen?.toDate ? data.lastSeen.toDate() : null,
      activePartyCode: data?.activePartyCode || null,
      nowPlaying: data?.nowPlaying || null,
    };
  });
  renderFriendsList();
}

/* ============================================================
   CONVITE PRO OUVIR JUNTO
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
async function inviteFriendToParty(friendUid, friendName){
  try{
    const hasParty = typeof Party!=="undefined" && Party.code && (Party.connected || Party.role==="host");
    if(!hasParty){
      showToast("Criando a party...");
      await createParty();
    }
    const code = await waitForPartyCode();
    await db.collection("users").doc(friendUid).collection("partyInvites").add({
      fromUid: Friends.uid, fromName: Friends.profile.name, fromCode: Friends.profile.code,
      partyCode: code, createdAt: firebase.firestore.FieldValue.serverTimestamp(),
    });
    await db.collection("users").doc(Friends.uid).set({activePartyCode: code}, {merge:true});
    showToast(`Convite enviado pra ${friendName}!`);
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
  const banner = $id("partyInviteBanner");
  if(!banner) return;
  banner.innerHTML = `
    <span>${escapeHtml(data.fromName)} te chamou pro Ouvir Junto</span>
    <button class="btn btn-primary" id="partyInviteAcceptBtn" type="button">Entrar</button>
    <button class="btn btn-ghost" id="partyInviteDismissBtn" type="button">Ignorar</button>`;
  banner.style.display = "flex";

  const cleanup = async ()=>{
    banner.style.display = "none";
    try{ await db.collection("users").doc(Friends.uid).collection("partyInvites").doc(inviteId).delete(); }
    catch(e){ /* silencioso — não é crítico se sobrar um convite antigo */ }
  };
  $id("partyInviteAcceptBtn").addEventListener("click", async ()=>{
    const code = data.partyCode;
    await cleanup();
    if(typeof joinParty === "function") joinParty(code);
  });
  $id("partyInviteDismissBtn").addEventListener("click", cleanup);
}

/* ============================================================
   PERFIL — visualizar/editar nome, ver código e e-mail, sair, excluir
============================================================ */
function openProfileModal(){
  if(!Friends.profile) return;
  const root = $id("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal modal-lg">
        <h3>Seu perfil</h3>
        <div class="friend-profile-avatar">${escapeHtml(initials(Friends.profile.name))}</div>

        <div class="friend-profile-field">
          <div class="friend-profile-label">Nome</div>
          <input type="text" id="profileNameInput" maxlength="24" value="${escapeHtml(Friends.profile.name)}" />
        </div>
        <div class="friend-profile-field">
          <div class="friend-profile-label">Código (não pode ser alterado)</div>
          <div class="friend-profile-static">@${escapeHtml(Friends.profile.code)}</div>
        </div>
        <div class="friend-profile-field">
          <div class="friend-profile-label">E-mail</div>
          <div class="friend-profile-static">${escapeHtml(fbAuth.currentUser?.email || "")}</div>
        </div>
        <div class="friends-auth-error" id="profileStatus"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="profileCloseBtn" type="button">Fechar</button>
          <button class="btn btn-primary" id="profileSaveBtn" type="button">Salvar</button>
        </div>

        <div class="friend-profile-danger-zone">
          <button class="btn btn-ghost" id="profileLogoutBtn" type="button" style="width:100%;justify-content:center;margin-bottom:8px;">Sair da conta</button>
          <button class="btn btn-danger" id="profileDeleteBtn" type="button" style="width:100%;justify-content:center;">Excluir minha conta</button>
        </div>
      </div>
    </div>`;
  $id("profileCloseBtn").addEventListener("click", ()=> root.innerHTML="");
  $id("profileSaveBtn").addEventListener("click", saveProfileName);
  $id("profileLogoutBtn").addEventListener("click", ()=>{
    root.innerHTML = "";
    fbAuth.signOut();
    showToast("Você saiu da conta.");
  });
  $id("profileDeleteBtn").addEventListener("click", openDeleteAccountModal);
}
async function saveProfileName(){
  const input = $id("profileNameInput");
  const status = $id("profileStatus");
  const name = input.value.trim();
  if(!name){ status.textContent = "O nome não pode ficar em branco."; return; }
  try{
    const batch = db.batch();
    batch.update(db.collection("users").doc(Friends.uid), {name});
    // Mantém o nome espelhado atualizado na lista de cada amigo também.
    Friends.list.forEach(f=>{
      batch.set(db.collection("users").doc(f.uid).collection("friends").doc(Friends.uid), {name}, {merge:true});
    });
    await batch.commit();
    Friends.profile.name = name;
    status.textContent = "Salvo!";
    setTimeout(()=>{ const r = $id("modalRoot"); if(r) r.innerHTML=""; }, 600);
  }catch(e){
    console.warn("falha ao salvar nome", e);
    status.textContent = "Não foi possível salvar agora.";
  }
}

/* ============================================================
   EXCLUIR CONTA
============================================================ */
function openDeleteAccountModal(){
  const root = $id("modalRoot");
  root.innerHTML = `
    <div class="modal-backdrop" id="modalBackdrop">
      <div class="modal">
        <h3>Excluir sua conta?</h3>
        <p>Isso apaga seu perfil, remove você da lista de amigos de todo mundo e não pode ser desfeito. Digita sua senha pra confirmar.</p>
        <input type="password" id="deleteAccountPassword" placeholder="Sua senha" autocomplete="current-password" />
        <div class="friends-auth-error" id="deleteAccountStatus"></div>
        <div class="modal-actions">
          <button class="btn btn-ghost" id="deleteAccountCancelBtn" type="button">Cancelar</button>
          <button class="btn btn-danger" id="deleteAccountConfirmBtn" type="button">Excluir conta</button>
        </div>
      </div>
    </div>`;
  $id("deleteAccountCancelBtn").addEventListener("click", ()=> root.innerHTML="");
  $id("deleteAccountConfirmBtn").addEventListener("click", async ()=>{
    const btn = $id("deleteAccountConfirmBtn");
    const status = $id("deleteAccountStatus");
    const password = $id("deleteAccountPassword").value;
    if(!password){ status.textContent = "Digita sua senha."; return; }
    btn.disabled = true;
    btn.textContent = "Excluindo...";
    try{
      await deleteAccount(password);
      const r = $id("modalRoot");
      if(r) r.innerHTML = "";
    }catch(e){
      console.warn("falha ao excluir conta", e);
      status.textContent = friendlyAuthError(e);
      btn.disabled = false;
      btn.textContent = "Excluir conta";
    }
  });
}
async function deleteAccountData(uid, code){
  // Firestore não apaga subcoleções junto com o documento pai — precisa
  // limpar cada uma na mão.
  const myFriendsSnap = await db.collection("users").doc(uid).collection("friends").get();
  for(const doc of myFriendsSnap.docs){
    await db.collection("users").doc(doc.id).collection("friends").doc(uid).delete().catch(()=>{});
    await doc.ref.delete().catch(()=>{});
  }
  const invitesSnap = await db.collection("users").doc(uid).collection("partyInvites").get();
  for(const doc of invitesSnap.docs) await doc.ref.delete().catch(()=>{});

  const [reqFrom, reqTo] = await Promise.all([
    db.collection("friendRequests").where("fromUid","==",uid).get(),
    db.collection("friendRequests").where("toUid","==",uid).get(),
  ]);
  for(const doc of [...reqFrom.docs, ...reqTo.docs]) await doc.ref.delete().catch(()=>{});

  if(code) await db.collection("usernames").doc(code).delete().catch(()=>{});
  await db.collection("users").doc(uid).delete();
}
async function deleteAccount(password){
  const user = fbAuth.currentUser;
  if(!user) return;
  const cred = firebase.auth.EmailAuthProvider.credential(user.email, password);
  await user.reauthenticateWithCredential(cred); // evita erro "requires-recent-login"
  await deleteAccountData(user.uid, Friends.profile?.code);
  await user.delete();
  showToast("Sua conta foi excluída.");
  // onAuthStateChanged cuida de voltar pra tela de login.
}

/* ============================================================
   RENDERIZAÇÃO — tela de Amigos
============================================================ */
function renderFriendRequests(){
  const block = $id("friendRequestsBlock");
  const list = $id("friendRequestsList");
  if(!block || !list) return;
  if(!Friends.incomingRequests.length){ block.style.display = "none"; list.innerHTML = ""; return; }

  block.style.display = "block";
  list.innerHTML = Friends.incomingRequests.map(r => `
    <div class="friend-item">
      <div class="friend-avatar-wrap"><div class="friend-avatar">${escapeHtml(initials(r.fromName))}</div></div>
      <div class="friend-meta">
        <div class="friend-name-row"><span class="friend-name">${escapeHtml(r.fromName)}</span><span class="friend-code">@${escapeHtml(r.fromCode)}</span></div>
        <div class="friend-status-line">quer ser seu amigo</div>
      </div>
      <div class="friend-actions">
        <button class="btn btn-primary friend-accept-btn" data-req="${escapeHtml(r.id)}" data-uid="${escapeHtml(r.fromUid)}" data-name="${escapeHtml(r.fromName)}" data-code="${escapeHtml(r.fromCode)}" type="button">Aceitar</button>
        <button class="btn btn-ghost friend-decline-btn" data-req="${escapeHtml(r.id)}" type="button">Recusar</button>
      </div>
    </div>`).join("");

  list.querySelectorAll(".friend-accept-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> acceptFriendRequest(btn.dataset.req, btn.dataset.uid, btn.dataset.name, btn.dataset.code));
  });
  list.querySelectorAll(".friend-decline-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> declineFriendRequest(btn.dataset.req));
  });
}
function renderFriendsList(){
  const list = $id("friendsList");
  if(!list) return;
  if(!Friends.list.length){
    list.innerHTML = `<div class="friends-empty">Você ainda não tem amigos adicionados.<br>Toca em "Adicionar" pra procurar alguém pelo código.</div>`;
    return;
  }

  const sorted = [...Friends.list].sort((a,b)=> (b.online - a.online) || a.name.localeCompare(b.name));
  list.innerHTML = sorted.map(f=>{
    const inSameParty = typeof Party!=="undefined" && Party.connected && Party.code && f.activePartyCode===Party.code;
    const status = friendStatusLine(f);
    let inviteBtn = "";
    if(inSameParty){
      inviteBtn = `<span class="friend-status-line playing" style="margin:0;">Na sua party</span>`;
    }else if(f.online){
      inviteBtn = `<button class="btn btn-ghost friend-invite-btn" data-uid="${escapeHtml(f.uid)}" data-name="${escapeHtml(f.name)}" type="button">Convidar</button>`;
    }
    return `
    <div class="friend-item">
      <div class="friend-avatar-wrap">
        <div class="friend-avatar">${escapeHtml(initials(f.name))}</div>
        <div class="friend-avatar-status ${f.online?"online":""}"></div>
      </div>
      <div class="friend-meta">
        <div class="friend-name-row"><span class="friend-name">${escapeHtml(f.name)}</span><span class="friend-code">@${escapeHtml(f.code)}</span></div>
        <div class="friend-status-line ${status.playing?"playing":""}">${escapeHtml(status.text)}</div>
      </div>
      <div class="friend-actions">
        ${inviteBtn}
        <button class="friend-menu-btn" data-menu-friend="${escapeHtml(f.uid)}" data-name="${escapeHtml(f.name)}" type="button" title="Mais opções">
          <svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="5" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="12" cy="19" r="1.8"/></svg>
        </button>
      </div>
    </div>`;
  }).join("");

  list.querySelectorAll(".friend-invite-btn").forEach(btn=>{
    btn.addEventListener("click", ()=> inviteFriendToParty(btn.dataset.uid, btn.dataset.name));
  });
  list.querySelectorAll("[data-menu-friend]").forEach(btn=>{
    btn.addEventListener("click", e=> openFriendMenu(e, btn.dataset.menuFriend, btn.dataset.name));
  });
}

/* ============================================================
   TROCA DE VISÃO — login/cadastro  vs.  lista de amigos
============================================================ */
function showFriendsAuthView(){
  $id("friendsAuthView").style.display = "flex";
  $id("friendsMainView").style.display = "none";
  $id("friendsHeaderActions").style.display = "none";
}
function showFriendsMainView(){
  $id("friendsAuthView").style.display = "none";
  $id("friendsMainView").style.display = "block";
  $id("friendsHeaderActions").style.display = "flex";
  renderFriendRequests();
  renderFriendsList();
}

/* ============================================================
   SESSÃO — reage a login/logout/exclusão de conta
============================================================ */
function teardownFriendsSession(){
  if(Friends.unsubFriends) Friends.unsubFriends();
  if(Friends.unsubRequests) Friends.unsubRequests();
  if(Friends.unsubInvites) Friends.unsubInvites();
  if(Friends.heartbeatTimer) clearInterval(Friends.heartbeatTimer);
  if(Friends.presenceIntervalTimer) clearInterval(Friends.presenceIntervalTimer);
  Friends.uid = null; Friends.profile = null; Friends.list = []; Friends.incomingRequests = [];
}
async function startFriendsSession(user){
  try{
    const snap = await db.collection("users").doc(user.uid).get();
    const data = snap.data();
    if(!data){ await fbAuth.signOut(); return; } // conta órfã (raro) — evita travar numa sessão quebrada
    Friends.uid = user.uid;
    Friends.profile = {name:data.name, code:data.code};
    startPresenceHeartbeat();
    listenFriendsList();
    listenIncomingRequests();
    listenPartyInvites();
    showFriendsMainView();
  }catch(e){
    console.warn("falha ao carregar sessão de amigos", e);
  }
}

/* ============================================================
   TELA — abrir/fechar (segue o mesmo padrão de Configurações/Sobre)
============================================================ */
function openFriendsScreen(){
  const screen = $id("friendsScreen");
  if(!screen) return;
  screen.classList.add("show");
  screen.classList.toggle("coming-soon", FRIENDS_COMING_SOON);
  screen.scrollTop = 0;
  if(typeof collapseSidebarIfNarrow === "function") collapseSidebarIfNarrow();
}
function closeFriendsScreen(){
  $id("friendsScreen")?.classList.remove("show");
}
$id("friendsBtn")?.addEventListener("click", openFriendsScreen);
$id("friendsBackBtn")?.addEventListener("click", closeFriendsScreen);
$id("friendsProfileBtn")?.addEventListener("click", openProfileModal);
$id("friendsAddBtn")?.addEventListener("click", openAddFriendModal);
$id("friendsAuthToggleBtn")?.addEventListener("click", ()=> setAuthMode(friendsAuthMode==="login" ? "signup" : "login"));
$id("friendsAuthSubmitBtn")?.addEventListener("click", ()=> friendsAuthMode==="signup" ? handleSignup() : handleLogin());
document.addEventListener("keydown", e=>{
  if(e.key!=="Escape") return;
  const screen = $id("friendsScreen");
  if(screen && screen.classList.contains("show")) closeFriendsScreen();
});

/* ============================================================
   INICIALIZAÇÃO
============================================================ */
function initFriends(){
  // Enquanto a área de Amigos está marcada como "Em breve", nem tenta
  // conectar no Firebase — evita esforço à toa e o aviso no console
  // (o FIREBASE_CONFIG nem precisa estar preenchido ainda).
  if(FRIENDS_COMING_SOON) return;
  try{
    firebase.initializeApp(FIREBASE_CONFIG);
    fbAuth = firebase.auth();
    db = firebase.firestore();
    fbAuth.onAuthStateChanged(user=>{
      if(signupInFlight) return; // handleSignup termina de escrever os docs e chama startFriendsSession sozinho
      teardownFriendsSession();
      if(user) startFriendsSession(user);
      else showFriendsAuthView();
    });
  }catch(e){
    console.warn("Não foi possível iniciar o sistema de Amigos — confira o FIREBASE_CONFIG em friends.js", e);
  }
}
initFriends();

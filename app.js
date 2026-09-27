const { createClient } = supabase;

const db = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
let currentUser = null;
let selectedUser = null;
let realtimeChannel = null;
let allUsers = [];
let selectedPhoto = null;
const PHOTO_BUCKET = "chat-images";
const E2EE_PREFIX = "E2EE1:";
const IDB_NAME = "mimi-e2ee";
const IDB_STORE = "identity";
let identity = null;

let notificationPermission = (typeof Notification !== "undefined") ? Notification.permission : "unsupported";
let unreadTotal = 0;
let audioContext = null;

function b64(bytes) {
  let s = "";
  const a = new Uint8Array(bytes);
  for (let i = 0; i < a.length; i += 0x8000) s += String.fromCharCode(...a.subarray(i, i + 0x8000));
  return btoa(s);
}

function unb64(s) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8(s) { return new TextEncoder().encode(s); }
function text(bytes) { return new TextDecoder().decode(bytes); }

function openIdentityDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(IDB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(IDB_STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbGet(key) {
  const dbx = await openIdentityDB();
  return new Promise((resolve, reject) => {
    const tx = dbx.transaction(IDB_STORE, "readonly");
    const req = tx.objectStore(IDB_STORE).get(key);
    req.onsuccess = () => resolve(req.result || null);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(key, value) {
  const dbx = await openIdentityDB();
  return new Promise((resolve, reject) => {
    const tx = dbx.transaction(IDB_STORE, "readwrite");
    tx.objectStore(IDB_STORE).put(value, key);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function generateIdentity() {
  const generated = await crypto.subtle.generateKey(
    { name: "ECDH", namedCurve: "P-256" },
    true,
    ["deriveKey"]
  );
  const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey(
    "jwk", privateJwk,
    { name: "ECDH", namedCurve: "P-256" },
    false, ["deriveKey"]
  );
  return { privateKey, publicJwk };
}

async function ensureIdentity() {
  if (identity) return identity;

  let saved = await idbGet("identity");
  if (!saved || !saved.privateKey || !saved.publicJwk) {
    saved = await generateIdentity();
    await idbPut("identity", saved);
  }

  identity = saved;
  const publicKeyText = JSON.stringify(identity.publicJwk);

  const { data: profile, error: profileError } = await db.from("profiles")
    .select("id,e2ee_public_key")
    .eq("id", currentUser.id)
    .maybeSingle();

  if (profileError) throw new Error("Не удалось проверить E2EE-ключ: " + profileError.message);

  if (profile?.e2ee_public_key !== publicKeyText) {
    const { error } = await db.from("profiles")
      .update({ e2ee_public_key: publicKeyText })
      .eq("id", currentUser.id);
    if (error) throw new Error("Не удалось сохранить E2EE-ключ: " + error.message);
  }

  return identity;
}

async function importPublicKey(user) {
  if (!user?.e2ee_public_key) throw new Error("У этого пользователя ещё не создан E2EE-ключ. Пусть он войдёт в MiMi Messenger один раз.");
  const jwk = JSON.parse(user.e2ee_public_key);
  return crypto.subtle.importKey(
    "jwk", jwk,
    { name: "ECDH", namedCurve: "P-256" },
    false, []
  );
}

async function getChatKey(user) {
  await ensureIdentity();
  const publicKey = await importPublicKey(user);
  return crypto.subtle.deriveKey(
    { name: "ECDH", public: publicKey },
    identity.privateKey,
    { name: "AES-GCM", length: 256 },
    false,
    ["encrypt", "decrypt"]
  );
}

async function encryptText(plain, user) {
  const key = await getChatKey(user);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: "AES-GCM", iv }, key, utf8(plain)
  );
  return E2EE_PREFIX + JSON.stringify({ v: 1, iv: b64(iv), ct: b64(cipher) });
}

function isEncryptedBody(body) {
  return typeof body === "string" && body.startsWith(E2EE_PREFIX);
}

async function decryptText(body, user) {
  if (!isEncryptedBody(body)) return body || "";
  const packet = JSON.parse(body.slice(E2EE_PREFIX.length));
  const key = await getChatKey(user);
  const plain = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: unb64(packet.iv) }, key, unb64(packet.ct)
  );
  return text(plain);
}

async function encryptFile(file, user) {
  const key = await getChatKey(user);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const plain = await file.arrayBuffer();
  const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, plain);
  return { blob: new Blob([cipher], { type: "application/octet-stream" }), iv: b64(iv) };
}

async function decryptFile(blob, ivB64, mimeType) {
  const key = await getChatKey(selectedUser);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(ivB64) }, key, await blob.arrayBuffer());
  return new Blob([plain], { type: mimeType || "image/jpeg" });
}

function updateNotifyUI() {
  const btn = $("notifyBtn");
  const status = $("notifyStatus");
  if (!btn || !status) return;

  if (notificationPermission === "granted") {
    btn.textContent = "🔔";
    btn.title = "Уведомления включены";
    status.textContent = "Уведомления включены";
  } else if (notificationPermission === "denied") {
    btn.textContent = "🔕";
    btn.title = "Уведомления заблокированы браузером";
    status.textContent = "Уведомления заблокированы";
  } else if (notificationPermission === "unsupported") {
    btn.textContent = "🔕";
    status.textContent = "Браузер не поддерживает уведомления";
  } else {
    btn.textContent = "🔔";
    btn.title = "Включить уведомления";
    status.textContent = "Нажми 🔔";
  }
}

async function enableNotifications() {
  if (typeof Notification === "undefined") {
    notificationPermission = "unsupported";
    updateNotifyUI();
    return;
  }
  try {
    notificationPermission = await Notification.requestPermission();
    updateNotifyUI();
    if (notificationPermission === "granted") new Notification("MiMi Messenger", { body: "Уведомления включены.", tag: "mimi-ready" });
  } catch (e) { console.error("Notification permission error:", e); }
}

function playMessageSound() {
  try {
    audioContext ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioContext.state === "suspended") audioContext.resume();
    const osc = audioContext.createOscillator();
    const gain = audioContext.createGain();
    osc.frequency.value = 880;
    gain.gain.setValueAtTime(0.0001, audioContext.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.12, audioContext.currentTime + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, audioContext.currentTime + 0.16);
    osc.connect(gain); gain.connect(audioContext.destination);
    osc.start(); osc.stop(audioContext.currentTime + 0.17);
  } catch (_) {}
}

function showIncomingNotification(m) {
  if (m.sender_id === currentUser.id) return;
  const chatIsOpen = selectedUser && selectedUser.id === m.sender_id && !document.hidden;
  if (chatIsOpen) return;
  unreadTotal++; updatePageTitle(); playMessageSound();
  if (notificationPermission === "granted") {
    const senderName = allUsers.find(u => u.id === m.sender_id)?.username || "Новое сообщение";
    try {
      const n = new Notification("MiMi Messenger — " + senderName, {
        body: m.image_path ? "🔐 📷 Зашифрованное фото" : "🔐 Зашифрованное сообщение",
        tag: "mimi-" + m.sender_id, renotify: true
      });
      n.onclick = () => { window.focus(); const sender = allUsers.find(u => u.id === m.sender_id); if (sender) selectUser(sender); n.close(); };
    } catch (e) { console.error(e); }
  }
}

function updatePageTitle() { document.title = unreadTotal ? `(${unreadTotal}) MiMi Messenger` : "MiMi Messenger"; }
function clearUnread() { unreadTotal = 0; updatePageTitle(); }

async function init() {
  updateNotifyUI();
  const { data, error } = await db.auth.getSession();
  if (error) console.error(error);
  if (data.session) await enterApp(data.session.user);
  else showAuth();
  db.auth.onAuthStateChange(async (_event, session) => {
    if (session) await enterApp(session.user); else showAuth();
  });
}

function showAuth() {
  currentUser = null; selectedUser = null; identity = null;
  $("auth").classList.remove("hidden"); $("app").classList.add("hidden");
}

async function enterApp(user) {
  currentUser = user;
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");
  try {
    await ensureIdentity();
  } catch (e) {
    console.error(e);
    alert("Не удалось включить E2EE: " + e.message);
    return;
  }
  const { data: profile } = await db.from("profiles").select("username,e2ee_public_key").eq("id", user.id).maybeSingle();
  $("me").textContent = profile?.username || user.user_metadata?.username || user.email || "";
  await loadUsers();
}

async function loadUsers() {
  const { data, error } = await db.from("profiles")
    .select("id,username,created_at,e2ee_public_key")
    .neq("id", currentUser.id).order("username");
  if (error) { console.error(error); $("users").innerHTML = '<div class="muted">Не удалось загрузить пользователей.</div>'; return; }
  allUsers = data || []; renderUsers(allUsers);
}

function renderUsers(users) {
  $("users").innerHTML = "";
  for (const u of users) {
    const div = document.createElement("div");
    div.className = "user" + (selectedUser?.id === u.id ? " active" : "");
    div.innerHTML = `<div class="userName">${escapeHtml(u.username)} ${u.e2ee_public_key ? "🔐" : "⚠️"}</div>`;
    div.onclick = () => selectUser(u);
    $("users").appendChild(div);
  }
}

$("search").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  renderUsers(allUsers.filter(u => u.username.toLowerCase().includes(q)));
});

async function selectUser(user) {
  selectedUser = user;
  clearUnread(); $("chatHeader").textContent = user.username;
  $("sendForm").classList.remove("hidden"); renderUsers(allUsers);
  await loadMessages(); subscribeToMessages();
}

async function loadMessages() {
  $("messages").innerHTML = '<div class="empty">Загрузка...</div>';
  const { data, error } = await db.from("messages")
    .select("id,sender_id,receiver_id,body,image_path,image_iv,image_mime,created_at")
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedUser.id}),and(sender_id.eq.${selectedUser.id},receiver_id.eq.${currentUser.id})`)
    .order("created_at", { ascending: true });
  if (error) { console.error(error); $("messages").innerHTML = '<div class="empty">Ошибка загрузки сообщений.</div>'; return; }
  await renderMessages(data || []);
}

function escapeAttr(s) { return String(s).replace(/["&<>]/g, c => ({'"':'&quot;','&':'&amp;','<':'&lt;','>':'&gt;'}[c])); }

async function uploadPhoto(file) {
  if (!file || !currentUser) return null;
  if (!file.type.startsWith("image/")) { alert("Можно отправлять только изображения."); return null; }
  if (file.size > 10 * 1024 * 1024) { alert("Фото слишком большое. Максимум 10 МБ."); return null; }
  const { blob, iv } = await encryptFile(file, selectedUser);
  const path = `${currentUser.id}/${crypto.randomUUID()}.mimi`;
  const { error } = await db.storage.from(PHOTO_BUCKET).upload(path, blob, { contentType: "application/octet-stream", upsert: false });
  if (error) { console.error("Encrypted photo upload error:", error); alert("Не удалось загрузить зашифрованное фото: " + error.message); return null; }
  return { path, iv, mime: file.type };
}

function showPhotoPreview(file) {
  removePhotoPreview(); if (!file) return;
  const wrap = document.createElement("div"); wrap.id = "photoPreview"; wrap.className = "photoPreview";
  const img = document.createElement("img"); img.src = URL.createObjectURL(file); img.alt = "Предпросмотр";
  const name = document.createElement("span"); name.textContent = file.name;
  const remove = document.createElement("button"); remove.type = "button"; remove.textContent = "✕";
  remove.onclick = () => { $("photoInput").value = ""; selectedPhoto = null; removePhotoPreview(); };
  wrap.append(img, name, remove); $("sendForm").before(wrap);
}
function removePhotoPreview() { $("photoPreview")?.remove(); }

async function appendImageMessage(m, container, scroll) {
  try {
    if (!m.image_iv) {
      const { data: legacy } = await db.storage.from(PHOTO_BUCKET).createSignedUrl(m.image_path, 60 * 60);
      if (!legacy?.signedUrl) throw new Error("Legacy image URL unavailable");
      const img = document.createElement("img");
      img.className = "messageImage"; img.src = legacy.signedUrl; img.alt = "Фото"; img.loading = "lazy";
      img.onclick = () => window.open(legacy.signedUrl, "_blank", "noopener,noreferrer");
      container.appendChild(img);
      if (m.body) { const caption = document.createElement("div"); caption.className = "imageCaption"; caption.textContent = m.body; container.appendChild(caption); }
      if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
      return;
    }
    const { data, error } = await db.storage.from(PHOTO_BUCKET).download(m.image_path);
    if (error) throw error;
    const blob = await decryptFile(data, m.image_iv, m.image_mime);
    const url = URL.createObjectURL(blob);
    const img = document.createElement("img"); img.className = "messageImage"; img.src = url; img.alt = "Зашифрованное фото"; img.loading = "lazy";
    img.onclick = () => window.open(url, "_blank", "noopener,noreferrer");
    container.appendChild(img);
    if (m.body) {
      const caption = document.createElement("div"); caption.className = "imageCaption";
      caption.textContent = await decryptText(m.body, m.sender_id === currentUser.id ? selectedUser : allUsers.find(u => u.id === m.sender_id));
      container.appendChild(caption);
    }
    if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
  } catch (e) {
    console.error("Decrypt image error:", e);
    const err = document.createElement("div"); err.className = "imageCaption"; err.textContent = "🔒 Не удалось расшифровать фото на этом устройстве."; container.appendChild(err);
  }
}

async function renderMessages(messages) {
  $("messages").innerHTML = "";
  if (!messages.length) { $("messages").innerHTML = '<div class="empty">Сообщений пока нет. Напиши первым.</div>'; return; }
  for (const m of messages) await appendMessage(m, false);
  $("messages").scrollTop = $("messages").scrollHeight;
}

async function appendMessage(m, scroll = true) {
  const empty = $("messages").querySelector(".empty"); if (empty) $("messages").innerHTML = "";
  const div = document.createElement("div"); div.className = "bubble" + (m.sender_id === currentUser.id ? " mine" : "");
  const other = m.sender_id === currentUser.id ? selectedUser : allUsers.find(u => u.id === m.sender_id) || selectedUser;
  if (m.image_path) {
    div.classList.add("imageBubble"); await appendImageMessage(m, div, false);
  } else {
    try { div.appendChild(document.createTextNode(await decryptText(m.body, other))); }
    catch (e) { console.error("Decrypt text error:", e); div.appendChild(document.createTextNode("🔒 Не удалось расшифровать сообщение.")); }
  }
  const time = document.createElement("div"); time.className = "time"; time.textContent = new Date(m.created_at).toLocaleString();
  div.appendChild(time); $("messages").appendChild(div); if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
}

function subscribeToMessages() {
  if (realtimeChannel) db.removeChannel(realtimeChannel);
  realtimeChannel = db.channel("messages-" + selectedUser.id + "-" + currentUser.id)
    .on("postgres_changes", { event: "INSERT", schema: "public", table: "messages" }, async payload => {
      const m = payload.new;
      const isThisChat = (m.sender_id === currentUser.id && m.receiver_id === selectedUser.id) || (m.sender_id === selectedUser.id && m.receiver_id === currentUser.id);
      if (isThisChat && m.sender_id !== currentUser.id) { await appendMessage(m); showIncomingNotification(m); }
      else if (!isThisChat && m.sender_id !== currentUser.id) showIncomingNotification(m);
    }).subscribe();
}

$("sendForm").addEventListener("submit", async e => {
  e.preventDefault(); if (!selectedUser) return;
  const body = $("messageInput").value.trim(); const file = selectedPhoto;
  if (!body && !file) return;
  const submitBtn = $("sendForm").querySelector('button[type="submit"]'); submitBtn.disabled = true;
  let imageInfo = null;
  try {
    const encryptedBody = body ? await encryptText(body, selectedUser) : "";
    if (file) { imageInfo = await uploadPhoto(file); if (!imageInfo) return; }
    $("messageInput").value = ""; selectedPhoto = null; $("photoInput").value = ""; removePhotoPreview();
    const { data, error } = await db.from("messages").insert({
      sender_id: currentUser.id, receiver_id: selectedUser.id, body: encryptedBody,
      image_path: imageInfo?.path || null, image_iv: imageInfo?.iv || null, image_mime: imageInfo?.mime || null
    }).select().single();
    if (error) {
      console.error(error); alert("Не удалось отправить сообщение: " + error.message); $("messageInput").value = body;
      if (imageInfo?.path) await db.storage.from(PHOTO_BUCKET).remove([imageInfo.path]); return;
    }
    await appendMessage(data);
  } catch (e) {
    console.error(e); alert("E2EE ошибка: " + e.message); $("messageInput").value = body;
  } finally { submitBtn.disabled = false; }
});

$("photoBtn").addEventListener("click", () => $("photoInput").click());
$("photoInput").addEventListener("change", e => { const file = e.target.files?.[0] || null; selectedPhoto = file; showPhotoPreview(file); });

$("signup").onclick = async () => {
  const email = $("email").value.trim(), password = $("password").value, username = $("username").value.trim();
  $("authMsg").textContent = "";
  if (!email || !password || !username) { $("authMsg").textContent = "Заполни email, пароль и имя."; return; }
  if (username.length < 3 || username.length > 30) { $("authMsg").textContent = "Имя должно содержать от 3 до 30 символов."; return; }
  if (password.length < 6) { $("authMsg").textContent = "Пароль должен содержать минимум 6 символов."; return; }
  const { data, error } = await db.auth.signUp({ email, password, options: { data: { username } } });
  if (error) { $("authMsg").textContent = translateAuthError(error.message); return; }
  if (data.session) { $("authMsg").textContent = "Регистрация успешна."; return; }
  $("authMsg").textContent = "Аккаунт создан. Если в Supabase включено подтверждение email — проверь почту и подтверди адрес, затем войди.";
};

$("login").onclick = async () => {
  const email = $("email").value.trim(), password = $("password").value;
  if (!email || !password) { $("authMsg").textContent = "Введи email и пароль."; return; }
  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) $("authMsg").textContent = translateAuthError(error.message);
};

$("logout").onclick = async () => { await db.auth.signOut(); };

function translateAuthError(message) {
  const m = String(message).toLowerCase();
  if (m.includes("invalid login credentials")) return "Неверный email или пароль.";
  if (m.includes("user already registered")) return "Этот email уже зарегистрирован. Нажми «Войти».";
  if (m.includes("email not confirmed")) return "Email ещё не подтверждён. Проверь почту.";
  if (m.includes("password")) return "Пароль не подходит. Проверь его и попробуй снова.";
  return message;
}
function escapeHtml(s) { return String(s).replace(/[&<>"']/g, c => ({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"}[c])); }

$("notifyBtn").addEventListener("click", enableNotifications);
init();

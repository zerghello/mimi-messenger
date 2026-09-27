const { createClient } = supabase;

// Capture the recovery link BEFORE Supabase can process/clean the URL hash.
const RECOVERY_LINK_AT_LOAD = (() => {
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return hash.get("type") === "recovery" || query.get("type") === "recovery";
})();

const db = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const APP_VERSION = "5.6.4";
const $ = id => document.getElementById(id);
function setDebugStatus(message) {
  const el = $("debugStatus");
  if (el) el.textContent = `MiMi Messenger v${APP_VERSION} • ${message}`;
}
let currentUser = null;
let selectedUser = null;
let realtimeChannel = null;
let allUsers = [];
let selectedPhoto = null;
let selectedAvatarFile = null;
const PHOTO_BUCKET = "chat-images";
const AVATAR_BUCKET = "profile-avatars";
const E2EE_PREFIX = "E2EE1:";
const E2EE2_PREFIX = "E2EE2:";
const IDB_NAME = "mimi-e2ee";
const IDB_STORE = "identity";
let identity = null;
let passwordRecoveryMode = RECOVERY_LINK_AT_LOAD;
let recoverySessionReady = false;

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
    const req = indexedDB.open(IDB_NAME, 2);
    req.onupgradeneeded = () => {
      const d = req.result;
      if (!d.objectStoreNames.contains(IDB_STORE)) d.createObjectStore(IDB_STORE);
    };
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
  const generated = await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveKey"]);
  const publicJwk = await crypto.subtle.exportKey("jwk", generated.publicKey);
  const privateJwk = await crypto.subtle.exportKey("jwk", generated.privateKey);
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, { name: "ECDH", namedCurve: "P-256" }, false, ["deriveKey"]);
  return { privateKey, publicJwk };
}
async function ensureIdentity() {
  if (!currentUser) throw new Error("Нет авторизованного пользователя.");
  if (identity) return identity;
  const keyName = "identity:" + currentUser.id;
  let saved = await idbGet(keyName);
  if (!saved || !saved.privateKey || !saved.publicJwk) {
    saved = await generateIdentity();
    await idbPut(keyName, saved);
  }
  identity = saved;
  const publicKeyText = JSON.stringify(identity.publicJwk);
  const { data: profile, error: profileError } = await db.from("profiles").select("id,e2ee_public_key").eq("id", currentUser.id).maybeSingle();
  if (profileError) throw new Error("Не удалось проверить E2EE-ключ: " + profileError.message);
  // Legacy profile key is kept stable. Never overwrite it from another browser.
  if (!profile?.e2ee_public_key) {
    const { error } = await db.from("profiles").update({ e2ee_public_key: publicKeyText }).eq("id", currentUser.id);
    if (error) throw new Error("Не удалось сохранить E2EE-ключ: " + error.message);
  }
  return identity;
}
async function importPublicKeyJwk(jwk) {
  return crypto.subtle.importKey("jwk", jwk, { name: "ECDH", namedCurve: "P-256" }, false, []);
}
async function getLegacyChatKey(user) {
  await ensureIdentity();
  if (!user?.e2ee_public_key) throw new Error("У этого пользователя ещё нет старого E2EE-ключа.");
  const publicKey = await importPublicKeyJwk(JSON.parse(user.e2ee_public_key));
  return crypto.subtle.deriveKey({ name: "ECDH", public: publicKey }, identity.privateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function ensureDevice() {
  await ensureIdentity();
  const key = "deviceId:" + currentUser.id;
  let deviceId = await idbGet(key);
  if (!deviceId) {
    deviceId = crypto.randomUUID();
    await idbPut(key, deviceId);
  }
  const publicKey = JSON.stringify(identity.publicJwk);
  const { data: existing, error: readErr } = await db.from("e2ee_devices").select("id,public_key,revoked_at").eq("id", deviceId).maybeSingle();
  if (readErr) throw new Error("Не удалось проверить E2EE-устройство: " + readErr.message);
  if (!existing) {
    const { error } = await db.from("e2ee_devices").insert({ id: deviceId, user_id: currentUser.id, public_key: publicKey });
    if (error) throw new Error("Не удалось зарегистрировать E2EE-устройство: " + error.message);
  } else if (existing.public_key !== publicKey || existing.revoked_at) {
    deviceId = crypto.randomUUID();
    await idbPut(key, deviceId);
    const { error } = await db.from("e2ee_devices").insert({ id: deviceId, user_id: currentUser.id, public_key: publicKey });
    if (error) throw new Error("Не удалось зарегистрировать новое E2EE-устройство: " + error.message);
  }
  return deviceId;
}
async function getActiveDevices(userId) {
  const { data, error } = await db.from("e2ee_devices").select("id,user_id,public_key").eq("user_id", userId).is("revoked_at", null);
  if (error) throw error;
  return data || [];
}
async function deriveWrapKey(myPrivateKey, theirPublicJwk) {
  const pub = await importPublicKeyJwk(JSON.parse(theirPublicJwk));
  return crypto.subtle.deriveKey({ name: "ECDH", public: pub }, myPrivateKey, { name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
}
async function makeMessageKeyPacket(messageKey) {
  const myDeviceId = await ensureDevice();
  const recipientDevices = await getActiveDevices(selectedUser.id);
  const myDevices = await getActiveDevices(currentUser.id);
  const all = [...myDevices, ...recipientDevices].filter((d, i, a) => a.findIndex(x => x.id === d.id) === i);
  if (!all.length) throw new Error("Не найдено E2EE-устройство получателя.");
  const rawMessageKey = await crypto.subtle.exportKey("raw", messageKey);
  const wraps = [];
  for (const device of all) {
    const wrapKey = await deriveWrapKey(identity.privateKey, device.public_key);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const wrapped = await crypto.subtle.encrypt({ name: "AES-GCM", iv }, wrapKey, rawMessageKey);
    wraps.push({ deviceId: device.id, senderDeviceId: myDeviceId, iv: b64(iv), wrapped: b64(wrapped) });
  }
  return { wraps, senderDeviceId: myDeviceId };
}
async function decryptMessageKey(packet) {
  const myDeviceId = await ensureDevice();
  const wrap = packet.wraps?.find(x => x.deviceId === myDeviceId);
  if (!wrap) throw new Error("Для этого устройства нет ключа сообщения.");
  const { data: senderDevice, error } = await db.from("e2ee_devices").select("public_key").eq("id", wrap.senderDeviceId).maybeSingle();
  if (error || !senderDevice) throw new Error("Не найден ключ устройства отправителя.");
  const wrapKey = await deriveWrapKey(identity.privateKey, senderDevice.public_key);
  const raw = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(wrap.iv) }, wrapKey, unb64(wrap.wrapped));
  return crypto.subtle.importKey("raw", raw, { name: "AES-GCM" }, false, ["encrypt", "decrypt"]);
}
async function encryptE2EE2(plainText, file) {
  await ensureIdentity(); await ensureDevice();
  const messageKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, true, ["encrypt", "decrypt"]);
  const packet = await makeMessageKeyPacket(messageKey);
  let textIv = null, ct = null;
  if (plainText) {
    textIv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: textIv }, messageKey, utf8(plainText));
    ct = b64(cipher);
  }
  let image = null;
  if (file) {
    const imageIv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: "AES-GCM", iv: imageIv }, messageKey, await file.arrayBuffer());
    image = { blob: new Blob([cipher], { type: "application/octet-stream" }), iv: b64(imageIv), mime: file.type };
  }
  return { body: E2EE2_PREFIX + JSON.stringify({ v: 2, senderDeviceId: packet.senderDeviceId, wraps: packet.wraps, iv: textIv ? b64(textIv) : null, ct }), image };
}
async function decryptE2EE2Body(body) {
  const packet = JSON.parse(body.slice(E2EE2_PREFIX.length));
  const key = await decryptMessageKey(packet);
  if (!packet.ct) return "";
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(packet.iv) }, key, unb64(packet.ct));
  return text(plain);
}
async function getE2EE2KeyFromBody(body) {
  const packet = JSON.parse(body.slice(E2EE2_PREFIX.length));
  return decryptMessageKey(packet);
}
async function encryptText(plain) { return (await encryptE2EE2(plain, null)).body; }
function isEncryptedBody(body) { return typeof body === "string" && (body.startsWith(E2EE_PREFIX) || body.startsWith(E2EE2_PREFIX)); }
async function decryptText(body, user) {
  if (!body) return "";
  if (body.startsWith(E2EE2_PREFIX)) return decryptE2EE2Body(body);
  if (body.startsWith(E2EE_PREFIX)) {
    const packet = JSON.parse(body.slice(E2EE_PREFIX.length));
    const key = await getLegacyChatKey(user);
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(packet.iv) }, key, unb64(packet.ct));
    return text(plain);
  }
  return body;
}
async function decryptFileForMessage(m) {
  if (!m.image_iv) throw new Error("У фото нет IV.");
  const { data, error } = await db.storage.from(PHOTO_BUCKET).download(m.image_path);
  if (error) throw error;
  if (!m.body?.startsWith(E2EE2_PREFIX)) throw new Error("Старая версия фото использует старый ключ.");
  const key = await getE2EE2KeyFromBody(m.body);
  const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(m.image_iv) }, key, await data.arrayBuffer());
  return new Blob([plain], { type: m.image_mime || "image/jpeg" });
}


function canonicalJwk(jwk) {
  const k = typeof jwk === "string" ? JSON.parse(jwk) : jwk;
  return JSON.stringify({ kty: k.kty, crv: k.crv, x: k.x, y: k.y });
}

async function fingerprintForPublicKey(publicKeyText) {
  const bytes = new TextEncoder().encode(canonicalJwk(publicKeyText));
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
  return hex.match(/.{1,4}/g).join(" ");
}


async function getDeviceFingerprintSet(userId) {
  const devices = await getActiveDevices(userId);
  const result = [];
  for (const device of devices) result.push({ id: device.id, fingerprint: await fingerprintForPublicKey(device.public_key) });
  result.sort((a, b) => a.id.localeCompare(b.id));
  return result;
}
function keySetStorageKey(userId) { return "mimi-keyset:" + userId; }
async function checkKeyChange(user) {
  if (!user?.id) return { changed: false, current: [] };
  const current = await getDeviceFingerprintSet(user.id);
  const key = keySetStorageKey(user.id);
  let previous = null; try { previous = JSON.parse(localStorage.getItem(key) || "null"); } catch (_) {}
  if (!previous) { localStorage.setItem(key, JSON.stringify(current)); return { changed: false, current }; }
  const oldIds = previous.map(x => x.id).sort(), newIds = current.map(x => x.id).sort();
  const changed = oldIds.length !== newIds.length || oldIds.some((id, i) => id !== newIds[i]) || previous.some(old => { const now = current.find(x => x.id === old.id); return now && now.fingerprint !== old.fingerprint; });
  return { changed, current, previous };
}
function rememberCurrentKeySet(userId, current) { localStorage.setItem(keySetStorageKey(userId), JSON.stringify(current)); }
async function updateKeyWarning(user) {
  const result = await checkKeyChange(user); const warning = $("keyWarning"); if (!warning) return result;
  if (result.changed) { warning.classList.remove("hidden"); warning.textContent = "⚠️"; warning.title = "Ключ безопасности изменился. Нажмите для проверки."; warning.onclick = () => showKeyFingerprint(user, result); }
  else warning.classList.add("hidden");
  return result;
}

async function showKeyFingerprint(user, changeResult = null) {
  if (!user) return;
  const old = document.getElementById("fingerprintModal");
  if (old) old.remove();

  const modal = document.createElement("div");
  modal.id = "fingerprintModal";
  modal.className = "fingerprintOverlay";
  modal.innerHTML = `
    <div class="fingerprintCard">
      <h2>🔐 Проверка E2EE</h2>
      <p>Отпечаток ключа пользователя <strong>${escapeHtml(user.username)}</strong></p>
      ${changeResult?.changed ? '<div class="keyChangeAlert">⚠️ Ключ безопасности изменился с момента последней проверки. Новый браузер/устройство может быть нормальной причиной, но перед продолжением переписки проверь отпечаток через доверенный канал.</div>' : ''}
      <p class="muted small">Сравни отпечаток с отпечатком, показанным у этого человека через другой доверенный канал. Совпадение отпечатка помогает обнаружить подмену ключа.</p>
      <div id="fingerprintList" class="fingerprintList"><div class="muted">Загрузка...</div></div>
      <button id="confirmFingerprint" type="button">Подтвердить текущие ключи</button><button id="closeFingerprint" type="button" class="secondary">Закрыть</button>
    </div>`;
  document.body.appendChild(modal);
  $("closeFingerprint").onclick = () => modal.remove();
  $("confirmFingerprint").onclick = async () => { try { const current = await getDeviceFingerprintSet(user.id); rememberCurrentKeySet(user.id, current); const warning = $("keyWarning"); if (warning) warning.classList.add("hidden"); modal.remove(); } catch (e) { alert("Не удалось сохранить проверку ключей: " + (e.message || e)); } };
  modal.onclick = e => { if (e.target === modal) modal.remove(); };

  try {
    const devices = await getActiveDevices(user.id);
    const list = $("fingerprintList");
    if (!devices.length) {
      list.innerHTML = '<div class="muted">У пользователя пока нет активного E2EE-устройства.</div>';
      return;
    }
    list.innerHTML = "";
    for (let i = 0; i < devices.length; i++) {
      const fp = await fingerprintForPublicKey(devices[i].public_key);
      const item = document.createElement("div");
      item.className = "fingerprintItem";
      item.innerHTML = `<div class="small muted">Устройство ${i + 1}</div><code>${escapeHtml(fp)}</code>`;
      list.appendChild(item);
    }
  } catch (e) {
    console.error(e);
    $("fingerprintList").innerHTML = '<div class="muted">Не удалось получить отпечаток ключа.</div>';
  }
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

function isPasswordRecoveryUrl() {
  if (RECOVERY_LINK_AT_LOAD) return true;
  const hash = new URLSearchParams(window.location.hash.replace(/^#/, ""));
  const query = new URLSearchParams(window.location.search);
  return hash.get("type") === "recovery" || query.get("type") === "recovery";
}

function showResetPanel(waitingForSession = false) {
  passwordRecoveryMode = true;
  currentUser = null; selectedUser = null; identity = null;
  $("app").classList.add("hidden");
  $("auth").classList.remove("hidden");
  $("email").classList.add("hidden");
  $("password").classList.add("hidden");
  $("username").classList.add("hidden");
  $("signup").classList.add("hidden");
  $("login").classList.add("hidden");
  $("forgotPassword").classList.add("hidden");
  $("resetPanel").classList.remove("hidden");
  $("savePassword").disabled = waitingForSession || !recoverySessionReady;
  $("authMsg").textContent = waitingForSession
    ? "Подготавливаем восстановление пароля…"
    : "Установи новый пароль для аккаунта.";
}

function showNormalAuth() {
  passwordRecoveryMode = false;
  recoverySessionReady = false;
  $("email").classList.remove("hidden");
  $("password").classList.remove("hidden");
  $("username").classList.remove("hidden");
  $("signup").classList.remove("hidden");
  $("login").classList.remove("hidden");
  $("forgotPassword").classList.remove("hidden");
  $("resetPanel").classList.add("hidden");
}

async function init() {
  updateNotifyUI();

  // Supabase may remove #type=recovery while establishing the recovery session.
  if (RECOVERY_LINK_AT_LOAD) showResetPanel(true);

  db.auth.onAuthStateChange(async (event, session) => {
    if (event === "PASSWORD_RECOVERY") {
      recoverySessionReady = !!session;
      showResetPanel(false);
      return;
    }

    if (RECOVERY_LINK_AT_LOAD || passwordRecoveryMode) {
      if (session) {
        recoverySessionReady = true;
        showResetPanel(false);
      }
      return;
    }

    if (session) await enterApp(session.user);
    else { showNormalAuth(); showAuth(); }
  });

  const { data, error } = await db.auth.getSession();
  if (error) console.error(error);

  if (RECOVERY_LINK_AT_LOAD || isPasswordRecoveryUrl()) {
    if (data.session) {
      recoverySessionReady = true;
      showResetPanel(false);
    } else {
      showResetPanel(true);
    }
    return;
  }

  if (data.session) await enterApp(data.session.user);
  else {
    showNormalAuth();
    showAuth();
  }
}

function showAuth() {
  currentUser = null; selectedUser = null; identity = null;
  $("auth").classList.remove("hidden"); $("app").classList.add("hidden");
}

async function enterApp(user) {
  currentUser = user;
  setDebugStatus("авторизация OK • загружаю пользователей...");
  $("auth").classList.add("hidden"); $("app").classList.remove("hidden");

  // ВАЖНО: E2EE больше НЕ блокирует запуск списка пользователей.
  // Если регистрация/проверка устройства временно не удалась, чат всё равно
  // должен показать остальных пользователей. E2EE будет повторно инициализирован
  // при первой отправке сообщения.
  ensureIdentity().then(() => ensureDevice()).catch(e => {
    console.warn("E2EE init deferred:", e);
  });

  let profile = null;
  try {
    const result = await db.from("profiles")
      .select("username,e2ee_public_key,avatar_path")
      .eq("id", user.id).maybeSingle();
    if (result.error) console.warn("My profile load failed:", result.error);
    profile = result.data || null;
  } catch (e) {
    console.warn("My profile load exception:", e);
  }

  const myName = profile?.username || user.user_metadata?.username || user.email || "";
  $("me").textContent = myName;
  setAvatarElement($("myAvatar"), myName, profile?.avatar_path);
  await loadUsers();
}

async function loadUsers() {
  if (!currentUser?.id) {
    setDebugStatus("нет авторизованного пользователя");
    $("users").innerHTML = '<div class="muted">Пользователь не авторизован.</div>';
    return;
  }

  setDebugStatus("запрос profiles...");

  // Сначала минимальный запрос. Он не зависит от E2EE и аватаров.
  let result = await db.from("profiles")
    .select("id,username,created_at,avatar_path,e2ee_public_key")
    .order("username");

  if (result.error) {
    console.warn("Profiles full query failed, retrying minimal:", result.error);
    result = await db.from("profiles")
      .select("id,username,created_at,avatar_path")
      .order("username");
  }

  if (result.error) {
    console.error("Profiles query failed:", result.error);
    setDebugStatus("ОШИБКА profiles: " + (result.error.message || "Supabase error"));
    $("users").innerHTML = `<div class="muted usersError">Ошибка загрузки пользователей.<br><small>${escapeHtml(result.error.message || "Ошибка Supabase")}</small></div>`;
    return;
  }

  const rows = result.data || [];
  allUsers = rows.filter(u => u.id !== currentUser.id);
  setDebugStatus(`Supabase вернул ${rows.length}; других пользователей: ${allUsers.length}`);
  renderUsers(allUsers);

  if (!allUsers.length) {
    $("users").innerHTML = '<div class="muted">Других пользователей пока нет.</div>';
  }
}

function initials(name) {
  return String(name || "?").trim().split(/\s+/).slice(0,2).map(x => x[0]).join("").toUpperCase() || "?";
}

async function signedAvatarUrl(path) {
  if (!path) return null;
  const { data, error } = await db.storage.from(AVATAR_BUCKET).createSignedUrl(path, 60 * 60);
  return error ? null : data?.signedUrl || null;
}

async function setAvatarElement(el, name, path) {
  if (!el) return;
  el.innerHTML = "";
  el.textContent = initials(name);
  if (!path) return;
  const url = await signedAvatarUrl(path);
  if (!url || !el.isConnected) return;
  const img = document.createElement("img"); img.src = url; img.alt = "";
  img.onload = () => { el.textContent = ""; el.appendChild(img); };
}

function renderUsers(users) {
  $("users").innerHTML = "";
  for (const u of users) {
    const div = document.createElement("div");
    div.className = "user" + (selectedUser?.id === u.id ? " active" : "");
    const av = document.createElement("div"); av.className = "avatar avatarUser";
    const info = document.createElement("div"); info.className = "userInfo";
    info.innerHTML = `<div class="userName">${escapeHtml(u.username)} ${u.e2ee_public_key ? "🔐" : "⚠️"}</div>`;
    div.append(av, info);
    setAvatarElement(av, u.username, u.avatar_path);
    div.onclick = () => selectUser(u);
    $("users").appendChild(div);
  }
}

async function loadMyProfile() {
  selectedAvatarFile = null;
  if ($("avatarInput")) $("avatarInput").value = "";
  const { data } = await db.from("profiles").select("username,avatar_path").eq("id", currentUser.id).maybeSingle();
  const name = data?.username || currentUser.user_metadata?.username || currentUser.email || "";
  $("profileUsername").value = name;
  setAvatarElement($("profileAvatar"), name, data?.avatar_path);
  $("profileMsg").textContent = "";
}

$("profileBtn").addEventListener("click", async () => {
  await loadMyProfile();
  $("profileOverlay").classList.remove("hidden");
});
$("closeProfile").addEventListener("click", () => $("profileOverlay").classList.add("hidden"));
$("profileOverlay").addEventListener("click", e => { if (e.target === $("profileOverlay")) $("profileOverlay").classList.add("hidden"); });
$("avatarPickBtn").addEventListener("click", () => {
  const input = $("avatarInput");
  if (input) input.click();
});

$("avatarInput").addEventListener("change", e => {
  const file = e.target.files?.[0];
  if (!file) return;

  if (!file.type || !file.type.startsWith("image/")) {
    selectedAvatarFile = null;
    e.target.value = "";
    $("profileMsg").textContent = "Выбери изображение JPG, PNG или WebP.";
    return;
  }

  if (file.size > 5 * 1024 * 1024) {
    selectedAvatarFile = null;
    e.target.value = "";
    $("profileMsg").textContent = "Аватар слишком большой. Максимум 5 МБ.";
    return;
  }

  // ВАЖНО: здесь больше НЕ пытаемся открыть/декодировать картинку.
  // Android/Samsung Internet иногда ломает локальный preview через blob URL.
  // Файл сохраняем напрямую и отдаём Supabase при нажатии «Сохранить».
  selectedAvatarFile = file;
  const mb = (file.size / 1024 / 1024).toFixed(2);
  $("profileAvatar").innerHTML = `<div class="avatarSelectedIcon">📷</div>`;
  $("profileMsg").textContent = `Фото выбрано: ${file.name} (${mb} МБ). Нажми «Сохранить».`;
});

$("saveProfile").addEventListener("click", async () => {
  const username = $("profileUsername").value.trim();
  const file = selectedAvatarFile || $("avatarInput").files?.[0] || null;
  if (username.length < 3 || username.length > 30) {
    $("profileMsg").textContent = "Имя должно содержать от 3 до 30 символов.";
    return;
  }
  $("saveProfile").disabled = true;
  $("profileMsg").textContent = file ? "Загружаю фото..." : "Сохраняю...";
  try {
    const { data: old, error: oldErr } = await db.from("profiles").select("avatar_path").eq("id", currentUser.id).maybeSingle();
    if (oldErr) throw oldErr;
    let avatarPath = old?.avatar_path || null;
    if (file) {
      const ext = (file.name.split(".").pop() || "jpg").toLowerCase().replace(/[^a-z0-9]/g, "") || "jpg";
      avatarPath = `${currentUser.id}/${crypto.randomUUID()}.${ext}`;
      const { error: upErr } = await db.storage.from(AVATAR_BUCKET).upload(avatarPath, file, {
        contentType: file.type,
        cacheControl: "3600",
        upsert: false
      });
      if (upErr) throw new Error("Ошибка загрузки аватара: " + upErr.message);
    }
    const { error } = await db.from("profiles").update({ username, avatar_path: avatarPath }).eq("id", currentUser.id);
    if (error) throw error;
    $("me").textContent = username;
    await setAvatarElement($("myAvatar"), username, avatarPath);
    $("profileMsg").textContent = "✅ Профиль сохранён";
    selectedAvatarFile = null;
    $("avatarInput").value = "";
    await loadUsers();
    setTimeout(() => $("profileOverlay").classList.add("hidden"), 700);
  } catch (e) {
    console.error(e);
    $("profileMsg").textContent = "Не удалось сохранить профиль: " + (e.message || e);
  } finally {
    $("saveProfile").disabled = false;
  }
});

$("search").addEventListener("input", e => {
  const q = e.target.value.toLowerCase();
  renderUsers(allUsers.filter(u => u.username.toLowerCase().includes(q)));
});

async function selectUser(user) {
  selectedUser = user;
  clearUnread();
  $("chatHeader").innerHTML = `<div id="chatAvatar" class="avatar avatarUser"></div><span>${escapeHtml(user.username)}</span><button id="keyWarning" type="button" class="keyWarning hidden" title="Ключ безопасности изменился">⚠️</button><button id="fingerprintBtn" type="button" class="fingerprintBtn" title="Проверить отпечаток E2EE">🔐</button>`;
  setAvatarElement($("chatAvatar"), user.username, user.avatar_path);
  $("fingerprintBtn").onclick = () => showKeyFingerprint(user);
  try { await updateKeyWarning(user); } catch (e) { console.warn("E2EE key check failed", e); }
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

async function uploadPhoto(file, imageInfo) {
  if (!file || !currentUser || !imageInfo) return null;
  if (!file.type.startsWith("image/")) { alert("Можно отправлять только изображения."); return null; }
  if (file.size > 10 * 1024 * 1024) { alert("Фото слишком большое. Максимум 10 МБ."); return null; }
  const path = `${currentUser.id}/${crypto.randomUUID()}.mimi`;
  const { error } = await db.storage.from(PHOTO_BUCKET).upload(path, imageInfo.blob, { contentType: "application/octet-stream", upsert: false });
  if (error) { console.error("Encrypted photo upload error:", error); alert("Не удалось загрузить зашифрованное фото: " + error.message); return null; }
  return { path, iv: imageInfo.iv, mime: imageInfo.mime };
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
      const img = document.createElement("img"); img.className = "messageImage"; img.src = legacy.signedUrl; img.alt = "Фото"; img.loading = "lazy";
      img.onclick = () => window.open(legacy.signedUrl, "_blank", "noopener,noreferrer"); container.appendChild(img);
      if (m.body) { const caption = document.createElement("div"); caption.className = "imageCaption"; caption.textContent = m.body; container.appendChild(caption); }
    } else {
      const blob = await decryptFileForMessage(m); const url = URL.createObjectURL(blob);
      const img = document.createElement("img"); img.className = "messageImage"; img.src = url; img.alt = "Зашифрованное фото"; img.loading = "lazy";
      img.onclick = () => window.open(url, "_blank", "noopener,noreferrer"); container.appendChild(img);
      if (m.body?.startsWith(E2EE2_PREFIX)) {
        const captionText = await decryptE2EE2Body(m.body);
        if (captionText) { const caption = document.createElement("div"); caption.className = "imageCaption"; caption.textContent = captionText; container.appendChild(caption); }
      }
    }
    if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
  } catch (e) {
    console.error("Decrypt image error:", e); const err = document.createElement("div"); err.className = "imageCaption"; err.textContent = "🔒 Не удалось расшифровать фото на этом устройстве."; container.appendChild(err);
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
  let imageInfo = null, imageRow = null;
  try {
    const encrypted = await encryptE2EE2(body, file);
    if (file) { imageInfo = encrypted.image; imageRow = await uploadPhoto(file, imageInfo); if (!imageRow) return; }
    $("messageInput").value = ""; selectedPhoto = null; $("photoInput").value = ""; removePhotoPreview();
    const { data, error } = await db.from("messages").insert({
      sender_id: currentUser.id, receiver_id: selectedUser.id, body: encrypted.body,
      image_path: imageRow?.path || null, image_iv: imageRow?.iv || null, image_mime: imageRow?.mime || null,
      sender_device_id: await idbGet("deviceId:" + currentUser.id)
    }).select().single();
    if (error) {
      console.error(error); alert("Не удалось отправить сообщение: " + error.message); $("messageInput").value = body;
      if (imageRow?.path) await db.storage.from(PHOTO_BUCKET).remove([imageRow.path]); return;
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

$("forgotPassword").onclick = async () => {
  const email = $("email").value.trim();
  if (!email) { $("authMsg").textContent = "Сначала введи email."; return; }
  $("authMsg").textContent = "Отправляю ссылку восстановления...";
  const redirectTo = window.location.origin + window.location.pathname;
  const { error } = await db.auth.resetPasswordForEmail(email, { redirectTo });
  if (error) {
    $("authMsg").textContent = "Не удалось отправить письмо: " + error.message;
    return;
  }
  $("authMsg").textContent = "Ссылка восстановления отправлена на почту. Открой её и задай новый пароль.";
};

$("savePassword").onclick = async () => {
  const p1 = $("newPassword").value;
  const p2 = $("newPassword2").value;
  if (!recoverySessionReady) {
    $("authMsg").textContent = "Ссылка восстановления ещё не активировалась. Подожди несколько секунд и попробуй снова.";
    return;
  }
  if (p1.length < 6) { $("authMsg").textContent = "Пароль должен содержать минимум 6 символов."; return; }
  if (p1 !== p2) { $("authMsg").textContent = "Пароли не совпадают."; return; }

  $("savePassword").disabled = true;
  try {
    const { error } = await db.auth.updateUser({ password: p1 });
    if (error) throw error;

    $("newPassword").value = "";
    $("newPassword2").value = "";
    passwordRecoveryMode = false;
    recoverySessionReady = false;
    await db.auth.signOut();
    showNormalAuth();
    showAuth();
    $("authMsg").textContent = "✅ Пароль изменён. Войди с новым паролем.";
  } catch (e) {
    console.error(e);
    $("authMsg").textContent = "Не удалось изменить пароль: " + (e.message || e);
  } finally {
    if (passwordRecoveryMode) $("savePassword").disabled = false;
  }
};

$("cancelReset").onclick = async () => {
  await db.auth.signOut();
  window.location.href = window.location.origin + window.location.pathname;
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

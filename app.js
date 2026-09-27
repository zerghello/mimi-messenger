const { createClient } = supabase;

const db = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
let currentUser = null;
let selectedUser = null;
let realtimeChannel = null;
let allUsers = [];

let notificationPermission = (typeof Notification !== "undefined") ? Notification.permission : "unsupported";
let unreadTotal = 0;
let audioContext = null;

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

    if (notificationPermission === "granted") {
      new Notification("MiMi Messenger", {
        body: "Уведомления включены.",
        tag: "mimi-ready"
      });
    }
  } catch (e) {
    console.error("Notification permission error:", e);
  }
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

    osc.connect(gain);
    gain.connect(audioContext.destination);
    osc.start();
    osc.stop(audioContext.currentTime + 0.17);
  } catch (_) {}
}

function showIncomingNotification(m) {
  if (m.sender_id === currentUser.id) return;

  const chatIsOpen = selectedUser && selectedUser.id === m.sender_id && !document.hidden;
  if (chatIsOpen) return;

  unreadTotal++;
  updatePageTitle();

  playMessageSound();

  if (notificationPermission === "granted") {
    const senderName = allUsers.find(u => u.id === m.sender_id)?.username || "Новое сообщение";
    try {
      const n = new Notification("MiMi Messenger — " + senderName, {
        body: m.body,
        tag: "mimi-" + m.sender_id,
        renotify: true
      });
      n.onclick = () => {
        window.focus();
        const sender = allUsers.find(u => u.id === m.sender_id);
        if (sender) selectUser(sender);
        n.close();
      };
    } catch (e) {
      console.error(e);
    }
  }
}

function updatePageTitle() {
  document.title = unreadTotal ? `(${unreadTotal}) MiMi Messenger` : "MiMi Messenger";
}

function clearUnread() {
  unreadTotal = 0;
  updatePageTitle();
}


async function init() {
  updateNotifyUI();
  const { data, error } = await db.auth.getSession();
  if (error) console.error(error);
  if (data.session) await enterApp(data.session.user);
  else showAuth();

  db.auth.onAuthStateChange(async (_event, session) => {
    if (session) await enterApp(session.user);
    else showAuth();
  });
}

function showAuth() {
  currentUser = null;
  selectedUser = null;
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

async function enterApp(user) {
  currentUser = user;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");

  const { data: profile } = await db.from("profiles")
    .select("username")
    .eq("id", user.id)
    .maybeSingle();

  $("me").textContent = profile?.username || user.user_metadata?.username || user.email || "";
  await loadUsers();
}

async function loadUsers() {
  const { data, error } = await db.from("profiles")
    .select("id,username,created_at")
    .neq("id", currentUser.id)
    .order("username");

  if (error) {
    console.error(error);
    $("users").innerHTML = '<div class="muted">Не удалось загрузить пользователей.</div>';
    return;
  }

  allUsers = data || [];
  renderUsers(allUsers);
}

function renderUsers(users) {
  $("users").innerHTML = "";
  for (const u of users) {
    const div = document.createElement("div");
    div.className = "user" + (selectedUser?.id === u.id ? " active" : "");
    div.innerHTML = `<div class="userName">${escapeHtml(u.username)}</div>`;
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
  clearUnread();
  $("chatHeader").textContent = user.username;
  $("sendForm").classList.remove("hidden");
  renderUsers(allUsers);
  await loadMessages();
  subscribeToMessages();
}

async function loadMessages() {
  $("messages").innerHTML = '<div class="empty">Загрузка...</div>';

  const { data, error } = await db.from("messages")
    .select("id,sender_id,receiver_id,body,created_at")
    .or(`and(sender_id.eq.${currentUser.id},receiver_id.eq.${selectedUser.id}),and(sender_id.eq.${selectedUser.id},receiver_id.eq.${currentUser.id})`)
    .order("created_at", { ascending: true });

  if (error) {
    console.error(error);
    $("messages").innerHTML = '<div class="empty">Ошибка загрузки сообщений.</div>';
    return;
  }

  renderMessages(data || []);
}

function renderMessages(messages) {
  $("messages").innerHTML = "";
  if (!messages.length) {
    $("messages").innerHTML = '<div class="empty">Сообщений пока нет. Напиши первым.</div>';
    return;
  }

  for (const m of messages) appendMessage(m, false);
  $("messages").scrollTop = $("messages").scrollHeight;
}

function appendMessage(m, scroll = true) {
  const empty = $("messages").querySelector(".empty");
  if (empty) $("messages").innerHTML = "";

  const div = document.createElement("div");
  div.className = "bubble" + (m.sender_id === currentUser.id ? " mine" : "");
  div.innerHTML = `${escapeHtml(m.body)}<div class="time">${new Date(m.created_at).toLocaleString()}</div>`;
  $("messages").appendChild(div);

  if (scroll) $("messages").scrollTop = $("messages").scrollHeight;
}

function subscribeToMessages() {
  if (realtimeChannel) db.removeChannel(realtimeChannel);

  realtimeChannel = db.channel("messages-" + selectedUser.id + "-" + currentUser.id)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages"
    }, payload => {
      const m = payload.new;
      const isThisChat =
        (m.sender_id === currentUser.id && m.receiver_id === selectedUser.id) ||
        (m.sender_id === selectedUser.id && m.receiver_id === currentUser.id);

      if (isThisChat && m.sender_id !== currentUser.id) {
        appendMessage(m);
        showIncomingNotification(m);
      } else if (!isThisChat && m.sender_id !== currentUser.id) {
        showIncomingNotification(m);
      }
    })
    .subscribe();
}

$("sendForm").addEventListener("submit", async e => {
  e.preventDefault();

  const body = $("messageInput").value.trim();
  if (!body || !selectedUser) return;

  $("messageInput").value = "";

  const { data, error } = await db.from("messages").insert({
    sender_id: currentUser.id,
    receiver_id: selectedUser.id,
    body
  }).select().single();

  if (error) {
    console.error(error);
    alert("Не удалось отправить сообщение.");
    $("messageInput").value = body;
    return;
  }

  appendMessage(data);
});

$("signup").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  const username = $("username").value.trim();

  $("authMsg").textContent = "";

  if (!email || !password || !username) {
    $("authMsg").textContent = "Заполни email, пароль и имя.";
    return;
  }

  if (username.length < 3 || username.length > 30) {
    $("authMsg").textContent = "Имя должно содержать от 3 до 30 символов.";
    return;
  }

  if (password.length < 6) {
    $("authMsg").textContent = "Пароль должен содержать минимум 6 символов.";
    return;
  }

  const { data, error } = await db.auth.signUp({
    email,
    password,
    options: {
      data: { username }
    }
  });

  if (error) {
    $("authMsg").textContent = translateAuthError(error.message);
    return;
  }

  if (data.session) {
    $("authMsg").textContent = "Регистрация успешна.";
    return;
  }

  $("authMsg").textContent =
    "Аккаунт создан. Если в Supabase включено подтверждение email — проверь почту и подтверди адрес, затем войди.";
};

$("login").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;

  if (!email || !password) {
    $("authMsg").textContent = "Введи email и пароль.";
    return;
  }

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) $("authMsg").textContent = translateAuthError(error.message);
};

$("logout").onclick = async () => {
  await db.auth.signOut();
};

function translateAuthError(message) {
  const m = String(message).toLowerCase();
  if (m.includes("invalid login credentials")) return "Неверный email или пароль.";
  if (m.includes("user already registered")) return "Этот email уже зарегистрирован. Нажми «Войти».";
  if (m.includes("email not confirmed")) return "Email ещё не подтверждён. Проверь почту.";
  if (m.includes("password")) return "Пароль не подходит. Проверь его и попробуй снова.";
  return message;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

$("notifyBtn").addEventListener("click", enableNotifications);
init();

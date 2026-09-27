const { createClient } = supabase;

if (!window.SUPABASE_URL || window.SUPABASE_URL.includes("YOUR_")) {
  alert("Сначала создай config.js по образцу config.example.js");
}

const db = createClient(window.SUPABASE_URL, window.SUPABASE_ANON_KEY);

const $ = id => document.getElementById(id);
let currentUser = null;
let selectedUser = null;
let realtimeChannel = null;
let allUsers = [];

async function init() {
  const { data } = await db.auth.getSession();
  if (data.session) await enterApp(data.session.user);
  else showAuth();

  db.auth.onAuthStateChange(async (event, session) => {
    if (session) await enterApp(session.user);
    else showAuth();
  });
}

function showAuth() {
  $("auth").classList.remove("hidden");
  $("app").classList.add("hidden");
}

async function enterApp(user) {
  currentUser = user;
  $("auth").classList.add("hidden");
  $("app").classList.remove("hidden");

  let { data: profile } = await db.from("profiles")
    .select("username").eq("id", user.id).maybeSingle();

  $("me").textContent = profile?.username || user.email;
  await loadUsers();
}

async function loadUsers() {
  const { data, error } = await db.from("profiles")
    .select("id,username,created_at")
    .neq("id", currentUser.id)
    .order("username");

  if (error) return console.error(error);
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
  for (const m of messages) {
    const div = document.createElement("div");
    div.className = "bubble" + (m.sender_id === currentUser.id ? " mine" : "");
    div.innerHTML = `${escapeHtml(m.body)}<div class="time">${new Date(m.created_at).toLocaleString()}</div>`;
    $("messages").appendChild(div);
  }
  $("messages").scrollTop = $("messages").scrollHeight;
}

function subscribeToMessages() {
  if (realtimeChannel) db.removeChannel(realtimeChannel);

  realtimeChannel = db.channel("messages-" + selectedUser.id)
    .on("postgres_changes", {
      event: "INSERT",
      schema: "public",
      table: "messages",
      filter: `sender_id=eq.${selectedUser.id}`
    }, payload => {
      if (payload.new.receiver_id === currentUser.id) appendMessage(payload.new);
    })
    .subscribe();
}

function appendMessage(m) {
  const empty = $("messages").querySelector(".empty");
  if (empty) $("messages").innerHTML = "";

  const div = document.createElement("div");
  div.className = "bubble" + (m.sender_id === currentUser.id ? " mine" : "");
  div.innerHTML = `${escapeHtml(m.body)}<div class="time">${new Date(m.created_at).toLocaleString()}</div>`;
  $("messages").appendChild(div);
  $("messages").scrollTop = $("messages").scrollHeight;
}

$("sendForm").addEventListener("submit", async e => {
  e.preventDefault();
  const body = $("messageInput").value.trim();
  if (!body || !selectedUser) return;

  $("messageInput").value = "";

  const { error } = await db.from("messages").insert({
    sender_id: currentUser.id,
    receiver_id: selectedUser.id,
    body
  });

  if (error) {
    console.error(error);
    alert("Не удалось отправить сообщение.");
    $("messageInput").value = body;
  } else {
    appendMessage({
      sender_id: currentUser.id,
      receiver_id: selectedUser.id,
      body,
      created_at: new Date().toISOString()
    });
  }
});

$("signup").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;
  const username = $("username").value.trim();

  if (!email || !password || !username) {
    $("authMsg").textContent = "Заполни email, пароль и имя.";
    return;
  }

  if (username.length < 3) {
    $("authMsg").textContent = "Имя должно содержать минимум 3 символа.";
    return;
  }

  const { data, error } = await db.auth.signUp({ email, password });

  if (error) {
    $("authMsg").textContent = error.message;
    return;
  }

  if (data.user) {
    const { error: pError } = await db.from("profiles").insert({
      id: data.user.id,
      username
    });

    if (pError) console.error(pError);
  }

  $("authMsg").textContent = "Регистрация выполнена. Если включено подтверждение email — проверь почту.";
};

$("login").onclick = async () => {
  const email = $("email").value.trim();
  const password = $("password").value;

  const { error } = await db.auth.signInWithPassword({ email, password });
  if (error) $("authMsg").textContent = error.message;
};

$("logout").onclick = async () => {
  await db.auth.signOut();
};

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    "&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#039;"
  }[c]));
}

init();

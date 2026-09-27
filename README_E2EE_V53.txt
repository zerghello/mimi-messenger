MiMi Messenger v5.3 — E2EE device-key fix

1. Run supabase_e2ee_v53.sql once in Supabase SQL Editor.
2. Replace index.html, app.js, style.css on GitHub. Keep your existing config.js.
3. Do not clear browser site data.

New E2EE2 messages use per-device keys and a random message AES key wrapped for the sender and every active recipient device. The old E2EE1 messages remain readable only where the old legacy key is still available. New E2EE2 messages should work across Chrome/Samsung Internet.

Important: if an old E2EE1 key was already overwritten/lost, those old messages cannot be mathematically recovered.

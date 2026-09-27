MiMi Messenger v3 — notifications

This version adds:
- Android/browser notifications while the web app/browser is running;
- notification permission button 🔔;
- incoming message sound;
- unread counter in browser title;
- no notification when the active chat is already open.

Important:
True background push notifications when the browser is completely closed require Web Push/VAPID plus a server-side sender (for example a Supabase Edge Function). This v3 deliberately does not pretend to provide closed-browser push yet.

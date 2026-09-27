MiMi Messenger v5.4 — E2EE key fingerprint verification

No database changes are required.

New feature:
- The chat header has a 🔐 button.
- It shows the SHA-256 fingerprint of every active E2EE device key for the selected user.
- Compare the fingerprint with the same user's trusted copy on another channel/device before treating the key as verified.

Replace app.js, index.html, style.css. Keep config.js unchanged.

MiMi Messenger v5 — E2EE

This version adds browser-side end-to-end encryption for NEW text messages and NEW photos.

What is encrypted:
- New text messages: AES-256-GCM.
- New photos: AES-256-GCM before upload to Supabase Storage.
- Pair keys: ECDH P-256 derived separately for each 1-to-1 chat.

Where the private key is kept:
- Browser IndexedDB on the user's device.
- The private key is not uploaded to Supabase.

Important:
- Existing old text messages remain readable as legacy plaintext.
- Existing old photos remain readable as legacy unencrypted photos.
- New encrypted messages/photos cannot be decrypted after the browser's site data / IndexedDB identity is lost unless a recovery system is added later.
- This first E2EE version does not yet provide human-verifiable key fingerprints / safety numbers. That should be added before treating the messenger as high-security.
- True background push is still separate from E2EE.

Setup:
1. Run supabase_e2ee.sql in Supabase SQL Editor.
2. Replace index.html, app.js, style.css on GitHub Pages.
3. Do NOT replace config.js.
4. Have each test account log in once after deployment so its public E2EE key is registered.
5. Test a new text message and a new photo between two accounts.


MiMi Messenger v5.2: fixed Supabase password-recovery flow. The recovery link is captured before Supabase cleans the URL fragment, and the app stays on the password reset screen until the recovery session is ready.

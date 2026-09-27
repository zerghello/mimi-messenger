MiMi Messenger v4 — photo messages

What changed:
- 📷 Photo button in the composer.
- Mobile gallery/camera file picker via <input type=file accept="image/*">.
- 10 MB maximum per image.
- Private Supabase Storage bucket "chat-images".
- Images are displayed using short-lived signed URLs.
- messages.image_path stores the Storage object path.
- Optional text can be sent together with a photo.
- Existing text messages continue to work.

INSTALL:
1. Replace index.html, style.css and app.js in the GitHub repository with these files.
2. Do NOT replace your existing config.js. Keep your current Supabase URL/key.
3. Open Supabase -> SQL Editor and run supabase_photos.sql.
4. Commit/push the files.
5. Open the site in normal Chrome, select a user, tap 📷 and choose an image.

E2EE:
This version does NOT encrypt photos yet. That is intentional. E2EE will be the next step.

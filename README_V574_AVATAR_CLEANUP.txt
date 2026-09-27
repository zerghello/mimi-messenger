MiMi Messenger v5.7.4 — avatar cleanup

Change:
- When a new avatar is successfully saved, the previous avatar_path is removed from the profile-avatars bucket.
- E2EE, messages, chat photos and user list are unchanged.

Important:
- This fixes cleanup for future avatar changes.
- Existing old/orphan avatar files from previous tests may remain unless cleaned separately.

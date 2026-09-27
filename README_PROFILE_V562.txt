MiMi Messenger v5.6.2 — avatar upload fix

Avatar selection no longer tries to decode/open the local image in the browser.
The selected file is uploaded directly to Supabase Storage when «Сохранить» is pressed.
This avoids the Android/Samsung Internet local preview error «Не удалось открыть это изображение».
E2EE, messages and chat photos are unchanged.

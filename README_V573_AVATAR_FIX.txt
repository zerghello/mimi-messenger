MiMi Messenger v5.7.3 — Android avatar file-permission fix

Причина: Android/Samsung Internet может дать выбранному File временный доступ.
Решение: файл читается СРАЗУ в момент выбора в ArrayBuffer; при сохранении
исходный File больше не используется. Из памяти создаётся JPEG (если браузер
умеет декодировать изображение) и загружается в Supabase Storage.

SQL менять не нужно. Bucket и Storage policies остаются прежними.

Заменить в GitHub: app.js, index.html, style.css.

# MiMi Messenger

Минимальный веб-мессенджер для личных сообщений.

## Возможности

- регистрация;
- вход;
- список пользователей;
- поиск пользователей;
- личные сообщения;
- realtime новые сообщения;
- адаптация под телефон;
- PostgreSQL + Supabase;
- GitHub Pages.

## Запуск

### 1. Создай Supabase project

Создай новый проект в Supabase.

### 2. Создай таблицы

Открой SQL Editor и выполни содержимое `supabase.sql`.

### 3. Получи ключи

В настройках Supabase найди Project URL и anon/public key.

### 4. Создай config.js

Скопируй `config.example.js` в `config.js` и вставь:

```js
window.SUPABASE_URL = "https://....supabase.co";
window.SUPABASE_ANON_KEY = "....";
```

`service_role` сюда НЕ вставляй.

### 5. Проверка

Можно открыть `index.html` локально через простой HTTP-сервер или разместить репозиторий на GitHub Pages.

### 6. GitHub Pages

Загрузи файлы в GitHub repository и включи:

Settings → Pages → Deploy from branch → main → /root

После публикации GitHub выдаст адрес сайта.

## Важно

Файл `config.js` содержит только публичный anon key. Безопасность обеспечивается Row Level Security в Supabase.

Для публичного проекта перед запуском стоит добавить подтверждение email, восстановление пароля, ограничения регистрации и защиту от спама.

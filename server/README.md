# Meridian Backend

Node backend для стабильной авторизации Meridian.

## Переменные окружения

- `VK_APP_SECRET` — защищенный ключ мини-приложения VK. Нужен для проверки `sign`.
- `PORT` — порт сервера, по умолчанию `8787`.
- `CORS_ORIGIN` — разрешенный origin фронта. Для отладки можно `*`.
- `MERIDIAN_DB_PATH` — путь к JSON-хранилищу, по умолчанию `server/data/db.json`.

## Запуск

```bash
npm run backend
```

## Production

Backend можно запускать как обычный Node-сервис:

```bash
npm start
```

Или как Docker-контейнер:

```bash
docker build -t meridian-backend .
docker run -p 8787:8787 \
  -e VK_APP_SECRET=replace_with_vk_protected_key \
  -e CORS_ORIGIN=https://prod-app54520019-*.pages-ac.vk-apps.com \
  meridian-backend
```

Фронт должен получить публичный URL backend через:

```bash
VITE_API_BASE_URL=https://your-backend.example.com
```

Без `VITE_API_BASE_URL` приложение продолжит работать в старом локальном режиме.

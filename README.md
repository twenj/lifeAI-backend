# Life AI Backend

Node.js + Fastify + Prisma + MySQL backend for the Life AI uni-app frontend.

## Local setup

```bash
cp .env.example .env
pnpm install
pnpm prisma generate
pnpm prisma migrate dev --name init
pnpm dev
```

Default API address: `http://127.0.0.1:8787`.

The uni-app frontend now uses this backend for both H5 and the WeChat development simulator. H5 proxies `/backend/*` to this service; the WeChat development simulator uses `http://127.0.0.1:8787` directly. A deployed mini-program needs an HTTPS API domain added to its request whitelist and a production API base URL in `uniapp/src/lib/api.js`.

The model key is read from `.env` and is never sent to the frontend. The initial API provides anonymous login, conversations/messages, chat, notes, weight records, and food records. Images are accepted as data URLs for model requests but should move to object storage before production.

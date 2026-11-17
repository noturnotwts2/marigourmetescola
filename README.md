# Mari Gourmet
Node 18+ · Express · PostgreSQL (Neon) · PIX via Mercado Pago.
1. Neon: crie o projeto e copie a connection string → DATABASE_URL. A tabela é criada sozinha no 1º start.
2. Copie `.env.example` p/ `.env` (local) ou configure as variáveis no host (Render/Railway/Fly — servidor Node contínuo, HTTPS).
3. Mercado Pago > Suas integrações: pegue o Access Token (produção); em Webhooks cadastre `BASE_URL/api/webhooks/mercadopago` (evento "Pagamentos") e copie a chave secreta → MP_WEBHOOK_SECRET.
4. `npm install && npm start` (local: `node --env-file=.env server.js`). Loja: `/admin`.
Teste primeiro com credenciais de teste do Mercado Pago. Ajuste sabores/preços no array MENU de server.js.

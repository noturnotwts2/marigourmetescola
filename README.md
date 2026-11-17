# Mari Gourmet (Vercel)
Express como função serverless (api/index.js) + páginas estáticas em public/ + Neon PostgreSQL + PIX Mercado Pago.
## Deploy
1. Suba esta pasta para um repositório no GitHub e importe em vercel.com/new (Framework: Other, sem build).
2. Em Settings > Environment Variables cadastre as variáveis de `.env.example` (DATABASE_URL = string do Neon com "-pooler").
   BASE_URL = endereço final do site (se usar domínio próprio, o domínio). Faça Redeploy após cadastrar.
3. Mercado Pago > Webhooks: `BASE_URL/api/webhooks/mercadopago`, evento "Pagamentos"; chave secreta => MP_WEBHOOK_SECRET.
4. As tabelas são criadas sozinhas no primeiro acesso. Loja: /admin.
Teste antes com credenciais de teste do Mercado Pago. Sabores/preços: array MENU em api/index.js.

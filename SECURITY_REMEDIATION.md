# Correções de autenticação, pagamentos e validação — 26/10/2026

## Comportamento implementado

- Tokens do Cognito são verificados criptograficamente com JWKS, algoritmo RS256, emissor, cliente, validade e finalidade do token. Não existe autenticação por decodificação do payload.
- Acesso global depende do papel cadastrado no banco. E-mails e participação em `org_master` não concedem esse privilégio.
- O bootstrap de identidade consulta somente o `sub` ou e-mail verificado do Cognito; identidades ambíguas e cadastros inativos são recusados. Esse lookup de identidade precede a resolução do tenant. As operações de negócio usam a organização autorizada.
- Rotas privadas têm autorizador Cognito no API Gateway. Os handlers continuam verificando autenticação, tenant, papéis e titularidade dos recursos alterados.
- Pedidos, ingressos, orações confidenciais, dados de responsáveis e operações de cadastro receberam controles de titularidade. Campos enviados pelo cliente não substituem a identidade autenticada.
- PDV calcula valores pelo catálogo da igreja. Cartão é recusado nos checkouts de loja e eventos enquanto não houver processamento real. Pix pago permanece pendente; apenas ingressos gratuitos são liberados imediatamente.
- Ingressos só são emitidos para eventos publicados e lotes disponíveis do mesmo evento/tenant. O scanner rejeita ingressos não pagos e cancelados.
- Não existem retornos simulados de sucesso após falhas de checkout. Comprovantes de contribuições geram lançamentos pendentes do próprio membro, sem liquidar a receita.
- Faturas SaaS não podem ser quitadas pelo botão do cliente. O webhook Asaas exige segredo configurado; falhas do provedor não criam clientes/assinaturas fictícios. Simulação de provisionamento exige SUPERADMIN e ambiente sandbox.
- Configuração do gateway é isolada por organização, persistida no servidor e retornada com credenciais mascaradas. A interface não armazena a chave secreta no localStorage nem simula uma conexão validada.
- Studio e PWA executam TypeScript antes do build. O PWA executa também os testes de fronteira do checkout; o comando de deploy do backend exige tipagem e testes.

## Preparação obrigatória antes do deploy

1. Fazer backup do banco e executar, no backend: `npm run db:migrate:security`.
2. A migração adiciona `organization_id`, índice único por organização e `config_payload` à tabela `payment_gateway_settings`. É aditiva e pode ser repetida.
3. A migração também cadastra `members.digital_card` e `financial.advanced_reports`, consumidas pelas interfaces. Os relatórios não usam valores demonstrativos quando não existem dados.
4. Configurações legadas sem organização ficam inacessíveis. Atribuir cada configuração à igreja correta mediante revisão, ou recadastrar pela interface; não copiar uma credencial global para todos os tenants.
5. Confirmar `USER_POOL_ID`, `USER_POOL_CLIENT_ID`, `DB_SECRET_ARN` e `ASAAS_SECRET_ARN` no ambiente de destino. A chave da API, o token do webhook e o ambiente do Asaas ficam exclusivamente no JSON do Secrets Manager; não expor valores em variáveis das Lambdas ou logs.
6. Publicar backend, Studio e PWA de forma coordenada: os contratos de identidade, itens do PDV e checkout foram endurecidos. Validar separadamente os consumidores nativos antes de atualizá-los.
7. Validar em homologação duas igrejas, diferentes papéis, login/cadastro, Kids, comprovantes e os webhooks reais do provedor.

## Validação local

```sh
# Backend
npx tsc --noEmit
npm test

# Dentro de faith-hub-web
npm run build

# Dentro de faith-hub-pwa
npm run build
```

Os testes usam identidades/chaves de teste e banco simulado, sem movimentar dados ou pagamentos reais. A validação local não comprova o estado do banco nem a configuração dos serviços em produção. O rate limiter em memória e a infraestrutura de auditoria permanecem sujeitos à revisão operacional posterior.

Antes da liberação, confirmar uma conta SUPERADMIN explícita: o papel ADMIN por si só não concede administração global. A migração mantém configurações bancárias legadas sem organização em quarentena.

Credenciais antigas eventualmente presentes no histórico Git devem ser rotacionadas; removido o fallback literal de senha do script de feature flags.

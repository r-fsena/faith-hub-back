# Faith-Hub — Runbook operacional

## Alertas de cobrança SaaS

- `asaas-webhook-errors`: verificar logs da Lambda `handleAsaasWebhook`, segredo do webhook e disponibilidade do banco.
- `billing-worker-errors`: verificar o registro em `asaas_webhook_events`, o job em `saas_provisioning_jobs` e os logs da Lambda `processSaasBillingQueue`.
- `billing-dlq-not-empty`: não apagar a mensagem. Identificar a causa, corrigir, confirmar idempotência pelo `event_id` e somente então executar o redrive.
- `billing-queue-age`: verificar throttling, concorrência, conectividade com RDS e indisponibilidade do Asaas.

## Regra de segurança para reprocessamento

1. Confirmar o `event_id`, `payment_id`, `subscription_id`, `proposal_id` e o tenant relacionado.
2. Confirmar que a cobrança está `CONFIRMED`, `RECEIVED` ou `RECEIVED_IN_CASH` no Asaas.
3. Verificar se já existe job `COMPLETED` para o evento ou organização provisionada para a proposta.
4. Nunca criar uma nova cobrança para corrigir uma falha de processamento.
5. Reprocessar o mesmo evento, preservando sua chave idempotente.
6. Registrar a intervenção em `security_audit_logs`.

## Recuperação

- RDS: manter point-in-time recovery habilitado e realizar teste de restauração trimestral em ambiente isolado.
- S3: manter versionamento e lifecycle configurados no bucket de mídia.
- Antes de migrations: gerar snapshot manual e registrar o identificador no ticket de mudança.
- RPO alvo: 15 minutos. RTO alvo inicial: 4 horas.

## Implantação

- `dev`: ambiente legado atual; não alterar a estratégia de nested stacks.
- `prod`: usar a divisão por 20 grupos definida em `serverless.yml`.
- Validar o stack `prod`, webhook e smoke tests antes de apontar Studio/PWA para o novo endpoint.
- Em falha, manter o endpoint anterior ativo e reverter os frontends; não remover o stack anterior durante a janela de validação.

# F4 e R2 — custos históricos e relatórios mensais

Implementação local em 17/11/2026, na branch `feat/f4-r2-20261117` do backend e do Studio. **Não publicada. Nenhuma migração, flag ou infraestrutura de produção foi alterada nesta entrega.**

Referências: plano do ecossistema `PLANO_IMPLEMENTACAO_RELATORIOS_ALERTAS_HISTORICO_FINANCEIRO_2026-11-08.md`, itens F4/R2, e [fluxo formal de publicação](FLUXO_IMPLEMENTACAO_E_PUBLICACAO.md). A autorização anterior de H1 não é uma autorização de publicação de F4/R2.

## F4: política de custo e margem

- Custo médio móvel por organização, unidade e produto; quantidades com até três casas decimais e rateio com inteiros em centavos, arredondando ao centavo mais próximo. A última baixa consome o saldo restante, sem criar centavos residuais.
- A entrada recebe o **custo total dos itens**, custos adicionais atribuídos àquela entrada e referência de origem. O total adicional entra no mesmo custo médio; o operador deve distribuir despesas compartilhadas entre entradas antes de registrá-las. Não há rateio automático entre produtos.
- Zero exige informação explícita e referência. Campo vazio significa custo desconhecido. Estoque anterior à cobertura começa desconhecido; uma entrada conhecida não torna comprovado o restante desconhecido. A avaliação pode voltar a ser conhecida quando o saldo chega a zero e ocorre nova entrada comprovada.
- Saldo inicial avaliado exige estoque vazio. Ajustes positivos sem entrada comprovada tornam a avaliação desconhecida; não reescrevem vendas antigas.
- Na confirmação da venda, o custo aplicado e a receita da linha são preservados em `pdv_sale_costs`. Entradas futuras não alteram esse custo. Cancelamento físico total usa o custo original e o estado da reserva impede dupla reposição. Devolução de venda antiga sem custo conhecido mantém a avaliação desconhecida.
- Integração com o fluxo existente de cancelamento total de pedidos. Não implementa reembolso de pagamento nem devolução parcial. Essas operações precisam de domínio próprio quando forem solicitadas.
- Margem e cobertura aparecem em Loja & Operações e no PDF/CSV operacional. A margem é **bruta, somente da parcela coberta**, e nunca lucro líquido. Custo e margem são indisponíveis quando nenhuma linha tem custo conhecido.
- Cobertura é a proporção de linhas produto/pedido com custo conhecido, não unidades físicas. O universo inclui vendas pagas, não canceladas, com `paid_at` dentro do período, em unidades autorizadas com a funcionalidade habilitada. Vendas legadas sem data comprovada não são atribuídas artificialmente ao mês.

Leituras de margem exigem SUPERADMIN, PASTOR, ADMIN ou TREASURER e escopo autorizado. Movimentações usam as permissões existentes `inventory.manage`, autenticação, papel e unidade; custos e movimentações são auditados na mesma transação. Uma falha da auditoria desfaz o movimento. IDs de requisição impedem repetição de entradas.

Desativar a flag oculta a funcionalidade e recusa novos custos informados. Avaliações já iniciadas continuam acompanhando baixas e entradas desconhecidas para preservar a integridade caso sejam reativadas. Não apagar pools ou snapshots para desligar F4.

**Antes da liberação:** homologar esta política e o tratamento de despesas adicionais com a tesouraria, conforme o plano original. Não há reconstrução automática de custos antigos.

## R2: agenda mensal, destinatários e revisões

Inteligência → Relatórios usa o modelo selecionado e o filtro de unidades do portal. Um administrador local autorizado escolhe de 1 a 10 destinatários internos com acesso a todas as fontes/unidades. Não aceita e-mail livre. Tesoureiro agenda somente o modelo financeiro.

A primeira versão executa no dia 1, a partir das **08h em `America/Sao_Paulo`**, sobre o último mês encerrado. A comparação cobre o mês anterior completo. Novos agendamentos começam no próximo mês; reativação também começa no próximo mês. A agenda não segue o período avulso da prévia de R1.

As métricas existentes usam São Paulo e não existe configuração de fuso organizacional homologada neste fluxo. Outros fusos são recusados explicitamente; não alegar suporte a horário local de organizações em outros fusos. Recorrência semanal fica para a etapa posterior de carga/utilidade prevista no plano.

- O escopo e as fontes permitidas são congelados na criação. Acesso do criador e de cada destinatário é recarregado do banco antes da execução, durante a geração, antes do aviso e em cada download. JWT antigo não mantém o acesso de destinatário rebaixado.
- Criador inativo, rebaixado ou sem acesso suspende a agenda. Destinatário sem acesso recebe estado `ACCESS_REVOKED`, sem arquivo. Organização inativa ou flag desligada interrompe novas execuções e bloqueia consultas/downloads agendados.
- Cada destinatário autorizado recebe um pedido R1 próprio e arquivos privados próprios. Escopo e período são comuns; geração/revisão de dados fica registrada por arquivo. Arquivos de destinatários diferentes podem ser gerados em instantes distintos.
- O aviso aparece somente no portal autenticado, com texto fixo sem valores, nomes de membros ou conteúdo pastoral. PDF/CSV passam pela autorização do backend. Não há envio de e-mail ou push nesta versão.
- Chaves únicas e bloqueio da agenda impedem execução duplicada por competência/revisão. A marcação única de aviso impede duplicidade no portal. Falhas de fontes reutilizam as retentativas e estados de R1, sem transformar indisponibilidade em zero.
- Pausa/reativação exige motivo e versão esperada. Reprocessamento exige motivo, competência existente e revisão esperada; cria outra execução ligada à anterior. Histórico, definição e revisão anterior são preservados. PDF, CSV e portal identificam a nova revisão e seu motivo.
- Revogação de medição reutiliza os gatilhos de privacidade de R1: arquivos derivados ficam sem acesso e a prévia deixa de ser retornada. Uma cópia já baixada não pode ser revogada pelo portal.

O histórico consultável retorna as últimas 50 execuções da agenda; os registros anteriores permanecem no banco. A lista retorna até 50 agendas por criador e a caixa de avisos até 30 arquivos disponíveis. Alterar modelo/destinatários/escopo exige pausar a agenda anterior e criar outra, preservando sua história.

O dispatcher horário processa até três agendas vencidas por organização por chamada, com recuperação gradual de competências atrasadas; reutiliza a fila/worker R1. A configuração Serverless adiciona uma função `dispatchScheduledReports` e regra horária, **desativada por padrão** por `reportSchedulesEnabled=false`. A ativação exige publicação de infraestrutura autorizada, além das flags. Não houve teste de carga nem compromisso de SLA de produção nesta entrega.

## Migração e sequência de liberação futura

Migração aditiva `20261117_002_costs_report_schedules`:

| Tabelas | Conteúdo |
|---|---|
| `pdv_cost_pools`, `pdv_cost_events`, `pdv_sale_costs` | Avaliação corrente, movimentos e custo aplicado às vendas. |
| `intelligence_report_schedules`, `intelligence_report_runs`, `intelligence_report_deliveries` | Agenda, revisões mensais e entrega privada por destinatário. |

O runner usa lock global, checksum, pré-requisito da evolução de relatórios e conferência das tabelas de estoque. Não carrega credenciais quando importado por testes. A aplicação cria somente flags globais ausentes, desligadas, e não altera overrides existentes. DDL MySQL não é transacional: uma interrupção pode deixar tabelas criadas antes do marcador, e a repetição completa a migração.

Flags finais: `pdv.historical_costs` e `intelligence.report_schedules`; substituem os nomes apenas propostos `pdv.inventory_costs` e `intelligence.report_scheduling`. Fallback desligado, catálogo/normalização contratual aditivos e UI via `useFeatureFlags()`. Negativas contratuais explícitas continuam prevalecendo. Nenhum preço foi alterado.

Na preparação da publicação, identificar SHAs completos, CI, backup do banco correto, destinos das duas APIs legadas e reversão no manifesto. A sequência necessária é:

1. Homologar a política de custo e o fuso/agenda com os responsáveis; obter autorização específica para banco, componentes e flags.
2. Aplicar a migração aditiva **antes do código**. Os caminhos de estoque e autorização R1 passam a consultar as tabelas novas mesmo com as flags desligadas.
3. Publicar backend compatível, worker, funções de PDV e infraestrutura do dispatcher; revisar o pacote de infraestrutura, sem executar Serverless completo por rotina. Publicar o Studio pelo fluxo com manifesto e checkout limpo.
4. Validar as fontes/limites; ativar flags somente nas organizações/unidades autorizadas e habilitar a regra horária somente com liberação específica. Confirmar uma execução real autorizada antes de ampliar.

Os scripts `db:migrate:costs-report-schedules:status` e `db:migrate:costs-report-schedules` são administrativos e podem apontar para produção: não são testes locais e não foram executados contra infraestrutura real nesta entrega.

Contenção/reversão: desativar a regra horária e as flags para impedir novas agendas/custos informados; preservar tabelas, auditoria, pedidos, arquivos privados e avaliações. Não aplicar `DROP TABLE`, não recriar custos retroativamente e não apagar arquivos por rollback de código. Reverter o backend antigo após começar F4 interrompe o acompanhamento de custo; exige avaliação específica e posterior reconciliação, nunca ativação silenciosa sobre um intervalo sem cobertura. Preferir correção compatível que mantenha o acompanhamento.

## Verificações locais e limites da evidência

- `npm test`: **285 testes passaram** no workspace. Nove pertencem a trabalhos locais anteriores e não devem entrar no commit desta entrega; o conjunto versionado candidato corresponde a 276 testes, oito novos de F4/R2.
- MySQL 8.4 local, porta 33308, schema sintético aleatório removido ao final: **27 verificações passaram**, incluindo migração/retentativa, checksum/status, flags desligadas, média/custo antigo, cancelamento duplicado, desconhecidos, auditoria com rollback, concorrência mensal, revisão, revogação de papel/unidade e privacidade. Nenhum registro de cliente lido ou alterado.
- Navegador isolado com APIs sintéticas: entrada com custos em centavos/referência, cobertura parcial, destinatários internos, criação, revisão, pausa, aviso privado e layout móvel sem overflow. Conferência visual das telas novas; sem login ou APIs de produção.
- Tipagem backend: a execução exigida `npx tsc --noEmit` no diretório original detectou diretórios preexistentes incompletos `node_modules/@types/* 2`. A mesma fonte e o mesmo `tsconfig.json` passaram em cópia temporária com dependências de instalação limpa do mesmo lockfile, sem excluir tipos ou alterar configuração para contornar erros. O workspace original ainda precisa de reinstalação limpa de dependências antes de ser usado como checkout de release.
- `npm run build` do Studio e PWA passaram; o PWA incluiu seus **43 testes**. Permanecem avisos de tamanho de bundle/importação dinâmica já existentes.
- Sintaxe dos scripts e `git diff --check` passaram. Nenhum teste usou os stages legados `dev`/`prod`, AWS, `.env` de produção ou serviços externos.

Logs e capturas sintéticas locais: `/tmp/faith-f4r2-20261117`. Evidência resumida e cópias das capturas: `operations/evidence/f4-r2-20261117/`.

## Preparação da publicação autorizada em 17/11/2026

O proprietário solicitou nesta conversa: “siga com a implementação e publicação em produção”. Esta liberação segue a política de custo e o recorte mensal apresentados acima. A autorização cobre migração aditiva, código afetado nas duas APIs, worker privado, Studio, infraestrutura necessária de R2 e flags por organização elegível. Não foi fornecido parecer independente da tesouraria, e não se afirma que houve essa revisão externa.

A infraestrutura operacional R2 usa o template independente `infrastructure/intelligence-report-schedules.json`, sem deploy completo das stacks legadas. Cria dispatcher com concorrência reservada 1, função horária inicialmente desligada, papel com acesso somente ao secret de runtime, envio à fila privada/à fila de falhas e logs. Inclui DLQ e alarmes de erro/mensagens pendentes no CloudWatch, sem destino de notificação externo. A ativação da regra exige atualização revisada do parâmetro `ScheduleEnabled`; o parâmetro Serverless legado continua desligado para evitar agendamento duplicado.

A avaliação somente leitura atual encontrou quatro organizações ativas elegíveis e quatro inativas. O manifesto privado da liberação registra cada flag por organização, baseline, autorização e contenção. Resultados de produção serão registrados separadamente após execução e verificação; esta seção não certifica publicação concluída.

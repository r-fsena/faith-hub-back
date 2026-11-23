# A2 — alertas avançados: implementação e validação local

Data: 23/11/2026. Estado: implementado e validado localmente; **ainda sem publicação, migração ou ativação em produção**. Branches do backend e Studio: `feat/a2-advanced-alerts-20261123`. A autorização desta entrega é estruturar, implementar e testar com segurança. A autorização anterior de publicação de F4/R2 não foi reutilizada para A2.

## Entrega funcional

A Central de alertas existente recebe cinco regras, com configuração por organização/unidade, versão concorrente, motivo obrigatório, avaliação explícita, cobertura, evidência e composição da fonte na janela original. Os alertas usam o fluxo existente de revisão, adiamento, descarte e ações com responsável/prazo. A rotina de manutenção existente inclui unidades com regras avançadas configuradas, respeita os switches de cada unidade e mantém o limite de três unidades por ciclo. Não foi criada outra agenda ou notificação.

| Regra | Janela e critério inicial | Cobertura exigida |
|---|---|---|
| Participação | Dois períodos fechados de 28 dias, alinhados à segunda-feira; queda mínima de 15 pontos percentuais | História H1 contínua desde o período anterior, séries geradas antecipadamente, encontros com presença confirmada, ao menos 2 encontros e 5 oportunidades elegíveis por período, cobertura mínima de 90%. Configuração aceita 7/28 dias e cobertura de 80–100%. |
| Ativação digital | Coorte do último mês encerrado; uso qualificado em até 7 dias após o primeiro convite solicitado; objetivo de 40% | Adultos ativos com autorização atual e unidade primária coincidente; fontes habilitadas, captura desde o início da coorte e processamento após maturação. Convite solicitado não confirma entrega. |
| Conclusão de conteúdo | Primeiro início retido no mês encerrado e conclusão do mesmo par pessoa/conteúdo em até 7 dias; objetivo de 40% | Devocional, estudo ou capítulo escolhido; somente eventos `PWA_INTELLIGENCE_V1` da população autorizada. Repetições e conclusão anterior ao início não contam. |
| Rotina digital | Mês encerrado; mínimo de 2 dias com uso registrado dos módulos escolhidos | Devocionais, eventos, loja e escalas com fontes habilitadas e uso do PWA observado em amostra suficiente. Indica revisão de implantação, sem afirmar ausência de atividade real. |
| Variação financeira | Dois períodos fechados de 28 dias; queda de receitas ou aumento de despesas; mínimo de 20% e R$ 100 | Livro operacional com cobertura desde o período anterior e registros de base. Liquidações em centavos, líquidas de correções/devoluções; transferências internas excluídas. Despesas com base zero usam o mínimo absoluto. Dados pagos legados sem data/classificação bloqueiam conclusões. |

As três regras digitais só avaliam depois do mês encerrado mais sete dias de observação e um dia de recepção. Amostra mínima configurável, sempre com piso de 10; números pequenos, complementos, diferenças entre estágios e restos de outras unidades são protegidos. Os dados são agregados, sem nomes de pessoas ou conteúdos individuais nos alertas. A retenção digital de 90 dias também é revalidada na leitura.

A rotina digital de células não foi liberada: a instrumentação atual compartilha a área `cells` com eventos de estudos. Usar essa série como prova de rotina de células seria ambíguo. A regra de participação usa o calendário e a presença, de forma independente. Bíblia, oração, contribuição individual e Kids não fazem parte das escolhas de rotina.

**Divergência bancária permanece dependente de F3.** A regra financeira entregue mede variação do livro registrado, sem comprovar conciliação ou saldo bancário. Não há mensagem, convite ou pagamento automático. Dados financeiros não priorizam cuidado pastoral.

## Acesso e integridade

- Handler privado preserva `requireAuth`, `enforceRole`, `enforcePermission`, rate limiting e `intelligenceScope`/`enforceTenant`. Leituras e mutações usam organização e unidade; líderes acessam participação de seus grupos atuais.
- Tesouraria recebe somente alertas financeiros e ações derivadas desses alertas. Opções não retornam células ou metas pastorais; endpoints de acolhimento, histórico de membros, ativação e metas continuam bloqueados. Responsável e acesso à origem são revalidados dentro da transação.
- Configuração usa CAS (`expected_version`), e avaliação bloqueia a configuração por regra/unidade. Deduplicação inclui tenant, unidade/grupo, regra/versão, definição, janela e fonte. Retentativas simultâneas não duplicam alertas nem ações.
- Descartar preserva o mesmo fato silenciado. Adiamento vale até 30 dias, inclusive para o mesmo contexto em uma janela seguinte. Concluir revisão não altera a fonte; recorrência posterior pode abrir nova geração. Uma ação antiga não encerra a geração seguinte.
- Correções de fonte invalidam a evidência anterior até nova avaliação. Período insuficiente, fonte indisponível e amostra protegida não resolvem alertas automaticamente. A composição reconsulta a mesma janela, unidade e entidade.
- Revisão de privacidade por organização muda em inserção/alteração/exclusão de consentimento e em mudanças relevantes da população de membros. Evidência digital de outra revisão fica inacessível, inclusive histórico e ações. Reavaliar uma população diferente gera outra identidade; não ressuscita detalhes da população anterior.
- Configuração e avaliação aplicada têm auditoria estrita na mesma transação. Falha de auditoria reverte as alterações. Erros de fonte retornam `source_error`, preservam os fatos anteriores e são registrados no log operacional; não são apresentados como avaliação bem-sucedida.

## Migração aditiva e flag

`migrate_advanced_alerts.js`, ID `20261123_001_advanced_alerts`, cria três tabelas: configuração avançada, avaliações e revisão de privacidade. Cria seis triggers aditivos em consentimento/membros, sem alterar migrações publicadas ou inventar histórico. Exige a fundação anterior e as fontes H1/H2/financeiras presentes; usa lock, checksum e reaplicação segura.

A única chave nova é `intelligence.alerts_advanced`, registrada **desligada**. O backend também tem fallback falso e o Studio usa `useFeatureFlags()`. Evolução contratual preserva negativas explícitas e preços; a chave sozinha não habilita fontes, regras ou outros módulos. Cada regra começa desativada, com versão zero até configuração autorizada.

```bash
# Consultas/aplicações futuras requerem escolher e autorizar explicitamente o destino.
npm run db:migrate:advanced-alerts:status
npm run db:migrate:advanced-alerts
```

Nenhum desses comandos foi executado contra produção nesta entrega. O teste importa a migração sem `.env`, usa exclusivamente `127.0.0.1:33308`, cria um schema aleatório `faith_a2_qa_*` com dados sintéticos e o elimina ao terminar. A conferência final encontrou zero schemas QA restantes e o servidor temporário foi encerrado. Nenhum teste usa stages legados `dev`/`prod`.

## Validação executada

- Backend: 291 testes passaram no workspace (282 versionados com esta entrega e 9 testes locais preexistentes de outras tarefas).
- MySQL 8.4.7 temporário: 22 verificações de integração; cinco tipos de alerta abertos por fontes SQL reais, replay de migração, flags desligadas, concorrência, CAS, isolamento de tenant/unidade/perfil, ações, retirada de consentimento, bloqueio do histórico antigo, correções, devoluções, transferências, base zero, presença incompleta e reversão por falha de auditoria.
- Chrome headless com APIs sintéticas: 12 verificações, incluindo configuração, avaliação, estado de cobertura/amostra, evidência monetária, fonte na janela correta, ação, adiamento, tesouraria, flag e layout de 390 px. Capturas foram inspecionadas. A suíte existente do Studio completo também passou em 8 cenários de regressão, com A2 desligado e APIs sintéticas.
- Checagem de tipos do backend e builds de Studio/PWA aprovados; o build do PWA inclui 43 testes. No diretório original, `npx tsc --noEmit` encontra pastas antigas incompletas `@types/* 2`. O mesmo código foi copiado para `/tmp/faith-a2-20261123/backend-check`, usando as mesmas dependências e excluindo somente essas entradas duplicadas da descoberta de tipos; o comando obrigatório passou nessa cópia. `npx tsc --noEmit --types node,aws-lambda` também passou no workspace original.
- Builds mantêm os avisos existentes de chunks grandes e importação de QRCode. Não foram executados testes com registros de clientes ou invocações de Lambda.

Reprodução local, com servidor MySQL descartável já iniciado na porta reservada:

```bash
node --test tests/advanced-alerts.test.cjs
npm run test:advanced-alerts:mysql
# No repositório faith-hub-web:
node tests/advanced-alerts.browser.cjs
```

## Próxima publicação e reversão

Publicação continua separada, seguindo `FLUXO_IMPLEMENTACAO_E_PUBLICACAO.md`: checkout limpo, commits/SHA completos, manifesto e gates, autorização específica para backend/worker, migração e switches por tenant/unidade. Antes da migração, confirmar as fundações, snapshot/backup e compatibilidade dos triggers existentes. Os triggers acrescentam uma atualização de contador por organização nas escritas relevantes; importações de membros e consentimentos concorrentes precisam ser acompanhadas no rollout.

Aplicar primeiro a migração com a flag desligada, publicar backend/worker e Studio a partir dos SHAs aprovados, e somente depois habilitar explicitamente a chave e configurar regras nas unidades aprovadas. Não usar deploy Serverless completo ou alterar guards/variáveis de release para contornar o fluxo. Não executar a manutenção manualmente em produção como teste: ela pode gerar alertas reais. Verificação produtiva inicial deve ser passiva.

Reversão: desabilitar `intelligence.alerts_advanced` nos escopos habilitados e restaurar os artefatos anteriores de backend/worker e Studio pelo processo de release. Manter tabelas, configurações, auditoria e triggers aditivos para preservar evidência; eventual remoção exige uma mudança própria. Sem a flag, as regras e fontes avançadas não são acessadas e a Central inicial permanece independente dessas tabelas.

Código pronto não substitui maturação real. Unidades sem dois períodos históricos completos ou sem coorte digital madura permanecem aguardando cobertura. Não se retrodatam flags, consentimento, captura, livro financeiro ou presenças para fazer uma regra passar.

## Autorização de publicação — 23/11/2026

Após revisar esta implementação, o proprietário solicitou: “certo, realize a publicação, migração e ativação das flags por favor.” A preparação desta liberação cobre o Studio, o código das funções existentes afetadas e dos workers que compartilham contratos/flags, a migração `20261123_001_advanced_alerts` e a chave `intelligence.alerts_advanced` nas quatro organizações ativas elegíveis verificadas. As quatro organizações inativas, negativas explícitas, overrides de unidade e a flag global desligada serão preservados. Não se inclui ativação automática de regras, limiares novos para clientes, invocação manual de manutenção, migração destrutiva ou deploy completo Serverless.

Foi confirmada por leitura a conta AWS esperada, RDS MySQL 8.4.8 em us-east-1, nove fontes/fundações presentes e o pré-requisito dos triggers. O snapshot pré-migração é `faith-hub-pre-a2-20261123-001`; a aplicação depende de seu estado disponível e dos demais gates. A confirmação do proprietário sobre avaliação da máquina e rotação de credenciais, registrada em 17/11, continua sendo a condição operacional usada nesta liberação.

A contenção autoriza desativar somente os overrides criados por esta release, preservando schema e evidências. A reversão de código usa ZIPs anteriores verificados e configuração preservada; o Studio anterior é `600015d671e10a26c7ebd9bf40c1624fd7c4785d`, pelo processo controlado. O resultado efetivo será registrado ao encerrar a publicação. Este registro de preparação não afirma que os componentes já foram publicados.

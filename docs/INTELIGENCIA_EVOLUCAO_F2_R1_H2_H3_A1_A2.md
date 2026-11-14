# Inteligência — financeiro, relatórios, calendário, capacidades e alertas

Implementação iniciada em 13/11/2026. Estado: **código no workspace; não publicado em produção**. Este documento complementa o [fluxo formal de implementação e publicação](FLUXO_IMPLEMENTACAO_E_PUBLICACAO.md). Os stages legados `dev` e `prod` continuam sendo produção real.

## Escopo entregue

| Item solicitado | Fluxo no Studio | Resultado |
|---|---|---|
| 2 · F2 | Finanças → Contas e liquidações → Transferências e revisões | Transferência interna com saída/entrada atômicas; correção de liquidação; devolução efetivamente ocorrida. |
| 3 · R1 | Inteligência → Relatórios | Prévia, geração assíncrona, PDF/CSV privados, quatro modelos agregados, revisão e validade. |
| 4 · H2 | Inteligência → Agenda e participação | Recorrência, geração sem duplicação, realização conferida, cancelamento, reagendamento e revisões. |
| 4 · H3 | Inteligência → Capacidades históricas; Kids → salas/check-in | Referências de requisitos de escalas, capacidades de lotes e turnos Kids, sem reescrever o passado. |
| 5 · A1/A2 inicial | Inteligência → Alertas → evidência → ação | Regras por unidade, deduplicação, responsável/prazo, revisão, adiamento, conclusão e descarte. |

A inteligência comercial da área master, a revisão retroativa H1, conciliação F3, custo histórico/margem da loja F4, relatórios agendados R2 e as regras avançadas de A2 não integram este pacote.

## Financeiro

Transferências exigem acesso às duas contas e registram dois movimentos de soma zero. Não entram nas receitas/despesas operacionais e não executam transferência no banco.

A correção desfaz um registro incorreto e reabre a previsão correspondente. A devolução registra dinheiro efetivamente devolvido e não reabre o recebível. Ambas preservam a liquidação original, exigem motivo/evidência, conferem o saldo reversível e atualizam a conta. A interface diferencia as duas naturezas antes da confirmação. Nenhum fluxo executa reembolso no Asaas ou no banco.

Valores em centavos inteiros; controle de versão; bloqueios transacionais e identidade da solicitação; auditoria obrigatória na mesma transação. Uma retentativa recupera o resultado anterior; dados diferentes na mesma solicitação geram conflito.

## Relatórios sob demanda

Modelos: resumo executivo, gestão financeira, operação/unidades e comunidade/acolhimento. PDF e CSV derivam da mesma estrutura de indicadores, definições, período congelado e revisão. São agregados; não exportam listas de membros, crianças ou contribuintes.

Fluxo: conferir prévia → solicitar → fila → conferir direitos atuais do solicitante → coletar/renderizar → conferir direitos novamente → publicar os dois arquivos privados. O download passa pela API autenticada; não é entregue um link público ou URL assinada reutilizável. O relógio UTC do banco decide a expiração, inclusive após a leitura do arquivo.

- Direitos conferidos por organização, unidade, grupo, papel e fonte. Uma ampliação posterior de acesso não amplia um relatório já solicitado.
- Solicitante ativo conferido novamente no worker. Tesoureiro recebe apenas o modelo financeiro; líder não recebe os modelos financeiro/operacional.
- Mudanças na autorização de medição revogam relatórios digitais pendentes/prontos. Arquivos revogados permanecem inacessíveis pela API e expiram pela política privada.
- Outbox transacional para indisponibilidade da fila; lease e token impedem publicação por worker concorrente; até três tentativas; DLQ para falhas de entrega/processamento.
- Validade de 30 dias, até 20 mil linhas, 3 MB por arquivo e 250 páginas PDF. Excesso pede redução do escopo, sem truncamento silencioso.
- Fonte financeira indisponível impede a geração financeira; demais fontes indisponíveis são explicitadas, sem inventar zero.
- CSV UTF-8 com BOM, separador `;`, centavos exatos e proteção contra fórmulas em textos. Célula vazia significa indisponibilidade; não significa zero.
- PDF com Lato incorporada, licença OFL incluída nos ZIPs. Não depende de fonte instalada no Lambda.

`infrastructure/intelligence-reports.yml` define armazenamento privado próprio, fila/DLQ criptografadas, worker Node 22, IAM limitado e retenção. Ele **não foi aplicado**. Não reutilizar o bucket público de mídia. O worker e as funções produtoras precisam receber a mesma configuração de bucket/fila do ambiente correspondente.

## Calendário e participação

A série define célula, dias da semana, horário de Brasília e vigência. Gerar novamente o mesmo intervalo não duplica datas. Alterar/pausar uma série não modifica ocorrências já geradas. Cada ocorrência mantém motivo e revisões; reagendar cria outra ocorrência vinculada à original.

Confirmar realização exige um encontro lançado na mesma célula, unidade e data, além de conferência explícita das presenças. Elegibilidade usa o vínculo observado na data do encontro, somente quando a cobertura histórica é contínua e a ocorrência já estava registrada. Um calendário criado depois do encontro não comprova uma oportunidade passada. Cancelados/reagendados não viram faltas; pendência de lançamento e histórico insuficiente não viram taxa zero.

Limites: série até 366 dias; geração/consulta até 92 dias por vez; lista paginada de 100 ocorrências e até 200 séries no contexto. Líder consulta/opera somente suas células atuais.

## Capacidades por operação

- Escala publicada captura mínimos por função. Alterar mínimos do ministério não altera a referência publicada; uma conferência explícita cria nova revisão. Indicadores usam a referência disponível até a data do serviço e os aceites atuais, cuja natureza é explicitada.
- Capacidade do lote é versionada em cada alteração; nova reserva/ingresso recebe a referência vigente. Alterar capacidade não reescreve ingressos existentes. Vagas já vendidas/reservadas são preservadas no saldo do lote.
- Abrir turno Kids fixa a capacidade da sala. Alterar a sala vale para próximos turnos. Contador atômico impede exceder a capacidade por check-ins concorrentes; checkout/auditoria/capacidade são transacionais. Encerrar exige ausência de crianças ativas. Uma sala com turno/check-in ativo não pode mudar de unidade.
- A aplicação não inventa referências antigas. Quando falta cobertura, os indicadores afetados ficam indisponíveis e mostram a lacuna.
- Ocultar a funcionalidade não apaga referências nem libera excesso de ocupação em turnos já abertos.

## Central de alertas

Regras iniciais, configuradas por administrador/pastor em cada unidade:

| Regra | Evidência | Parâmetro |
|---|---|---|
| Visitante sem contato registrado | Visita datada, baseline conhecido, estágio novo, sem marco de contato | Prazo de 1 a 90 dias |
| Estoque abaixo do mínimo | Produto ativo monitorado, saldo e reservas cadastrados | Mínimo cadastrado no estoque |
| Vaga futura sem aceite | Escala publicada futura e requisitos versionados, aceites registrados | Próximos 1 a 90 dias |

As regras nascem desativadas e sem conclusões. Líder acessa apenas alertas de acolhimento dos seus grupos atuais. O contexto da origem é revalidado também ao consultar/atualizar uma ação vinculada. Tesoureiro não acessa essa central pastoral/operacional inicial.

Avaliação explícita na unidade ou pela manutenção diária existente. A manutenção percorre até três unidades configuradas por organização por execução, priorizando as tentadas há mais tempo. Portanto não há garantia de avaliação diária de todas as unidades em organizações maiores; a evidência informa o instante real. O botão de avaliação permite atualizar a unidade antes de decidir.

Limite de 2.000 fontes por regra/unidade: ao exceder, a avaliação não altera nem encerra alertas e informa o limite. Falha de fonte, fonte desligada, origem removida ou falta de referência não são tratadas como condição corrigida. Uma condição só é encerrada automaticamente quando a mesma fonte foi consultada com sucesso e deixou de satisfazer a regra.

Deduplicação por organização, unidade/grupo, regra/versão e origem. Descartar mantém o fato silenciado nessa versão da regra. Adiar preserva o histórico por até 30 dias. Uma condição resolvida que volta a ocorrer recebe nova geração; a tarefa é deduplicada por geração. Concluir uma revisão sem corrigir a fonte pode gerar nova ocorrência na próxima avaliação.

A ação reutiliza responsáveis/prazos e situações do acompanhamento existente. Concluir/descartar a ação atualiza o alerta vinculado; ações de ocorrências antigas não encerram uma ocorrência nova. Abrir a origem leva unidade, entidade e data para o filtro da tela correspondente, sem ampliar o acesso. Não há notificações externas, disparos de convite ou pagamentos automáticos.

## Migração e flags

Nova migração aditiva: `migrate_intelligence_evolution.js`, ID `20261113_003_intelligence_evolution`. Depende da migração de foundations aplicada. A migração anterior e seu checksum foram preservados.

A nova migração cria as tabelas/triggers, acrescenta referências em ingressos/check-ins e a identificação do tenant nos lotes, atualiza a projeção financeira e adiciona direitos comerciais sem alterar preços. Apenas a identificação do tenant dos lotes é preenchida a partir do evento; não se preenche capacidade histórica. Os direitos contratados não equivalem à liberação operacional.

| Flag | Dependências principais |
|---|---|
| `financial.transfers_reversals` | Contas/livro caixa/financeiro |
| `intelligence.reports` | Visão de inteligência e fontes do modelo |
| `intelligence.calendar` | Histórico, membros e células |
| `intelligence.capacities` | Operação e módulo da fonte |
| `intelligence.alerts` | Ações e fonte de cada regra |

Fallbacks são falsos; migração insere flags globais desligadas; provisionamento mantém as cinco novidades desligadas, inclusive para novas organizações. Negativas explícitas nos contratos são preservadas. A ativação de qualquer piloto é separada e auditada.

Comandos de revisão, sem aplicar:

```bash
node migrate_intelligence_evolution.js --status
npx tsc --noEmit
npm test
node scripts/build-intelligence-report-worker.cjs --output /tmp/report-worker-<identificador-unico>
```

Homologação SQL exige `--isolated-schema --extended` no script `scripts/test-intelligence-foundations-mysql.cjs`: copia apenas estrutura, cria dados sintéticos e remove o schema ao final. Não usar esses comandos como autorização de gravação no schema produtivo.

## Ordem de publicação controlada

1. Fixar commits compatíveis de backend/Studio; checkout limpo; gates e evidências; backup de código/configuração e snapshot do RDS. Registrar autorização e plano de reversão do destino real.
2. Revisar impacto/checksum e executar a nova migração com `--schema-only`. Necessário **antes do backend**, pois os leitores novos consultam tabelas/colunas adicionais, mesmo com alguns módulos ocultos.
3. Revisar e aplicar change-set da stack privada de relatórios no ambiente correto; enviar ZIP verificado do worker para bucket privado de artefatos. Confirmar rede RDS, segredo/região, User Pool, nomes das roles produtoras e capacidade do worker. Não executar deploy Serverless completo sobre stacks legadas.
4. Configurar `INTELLIGENCE_REPORTS_BUCKET` e `INTELLIGENCE_REPORTS_QUEUE_URL` nas funções de inteligência/API e manutenção que efetivamente usam essas integrações. Preservar as demais variáveis. Verificar as permissões explícitas de produtor e consumidor.
5. Publicar os bundles revisados de inteligência, financeiro, eventos e Kids e todos os demais consumidores transitivos identificados pelo inventário de artefatos. Publicar o Studio por manifesto/guard, mantendo autobuild/previews desligados.
6. Aplicar a migração completa com `--apply` para registrar checksum/direitos e flags globais desligadas. Nenhum piloto é ativado automaticamente.
7. Ativar apenas o piloto autorizado, com os pais correspondentes. Conferir cada flag, organização e unidade; configurar regras explicitamente; conferir salas/check-ins existentes antes de abrir turnos. Dados antigos sem referência continuam com cobertura insuficiente.
8. Homologar autenticado: transferência/correção/devolução, quatro relatórios e expiração/revogação, calendário, capacidades e alertas com isolamento. Monitorar erros de fonte, DLQ, jobs presos e tempo de manutenção. Só então ampliar o rollout.

## Reversão e compatibilidade dos dados

Desabilitar novas entradas por flag é a primeira contenção. Manter tabelas, histórico, operações e arquivos privados; não apagar dados nem executar migração reversa destrutiva.

Após movimentos F2, os leitores F2 de saldo/projeção devem permanecer: voltar ao código F1 faria os saldos ignorarem transferências/revisões. Preferir correção adiante, preservando leitores compatíveis. Após abertura de turnos Kids, conservar o fluxo de turnos/checkout até concluir todos os checkouts e encerrar os turnos; ocultar a flag não elimina o controle de capacidade. Não retirar triggers de capacidade para contornar lotação.

Relatórios: pausar novas solicitações/consumo, manter o bucket privado e a política de expiração; não tornar objetos públicos para facilitar acesso. Reverter Studio com novo manifesto aprovado, preservando os guards. Se apenas a UI for revertida, manter o backend leitor compatível com os dados já escritos.

## Validação

Os resultados finais e as limitações da homologação estão no registro de evidências do workspace `evidencias/inteligencia-evolucao-2026-11-13`. Os testes SQL usam RDS descartável; o ciclo de arquivos usa armazenamento/fila simulados. Isso não equivale à homologação do S3/SQS/worker real nem à ativação produtiva.

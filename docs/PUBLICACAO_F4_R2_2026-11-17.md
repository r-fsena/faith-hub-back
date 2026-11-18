# Publicação F4 e R2 — 17/11/2026

**Estado: publicado e ativado em produção.** Esta publicação substitui a marcação anterior de implementação somente local de F4/R2 inicial.

O proprietário solicitou nesta conversa: “siga com a implementação e publicação em produção”. A liberação cobre os componentes necessários de F4/R2, a migração aditiva, o agendador mensal e as flags por organização elegível. A confirmação anterior de avaliação da máquina e rotação de credenciais em dispositivo confiável permanece registrada no incidente de 12/11; não se afirma ter auditado essa avaliação. A política de custo e o recorte mensal são os apresentados ao proprietário; não foi fornecido parecer independente da tesouraria.

## Resultado verificado

- Snapshot RDS `faith-hub-pre-f4r2-20261117` disponível antes da migração, no banco correto em us-east-1.
- Migração `20261117_002_costs_report_schedules` aplicada e checksum conferido. Seis tabelas aditivas, sem reconstruir custos ou criar registros de negócio para teste.
- Código de **95 funções existentes** das duas stacks legadas e do **worker privado de relatórios** atualizado com checksum e configuração preservados. **34 ZIPs distintos de reversão** verificados cobrem as 96 funções. Nenhum deploy completo das stacks Serverless legadas.
- Stack independente `faith-hub-intelligence-schedules-production` criada por change set revisado, somente com dez recursos novos. Papel restrito ao secret de runtime, filas designadas e logs; DLQ criptografada e alarmes no CloudWatch. A conta possui cota de 10 execuções Lambda; não foi reservada concorrência do dispatcher.
- A regra horária foi criada desligada. Um segundo change set alterou diretamente seu estado após os gates e a ativação das flags, com reavaliação dinâmica de duas referências dependentes (permissão de invocação e política da DLQ). Regra **ENABLED**, alvo e código conferidos. A invocação manual adicional de teste não foi realizada: a avaliação automática a recusou por poder processar relatórios e avisos reais fora da autorização de publicação. A primeira execução horária natural ainda não foi observada; a verificação deste pacote cobre configuração, código, APIs e testes isolados. Não foram cadastradas agendas fictícias ou enviados relatórios de teste a clientes.
- Studio Amplify **job 160 — SUCCEED**. Guard confirmou o SHA real aprovado; bundle público contém os recursos F4/R2. Apenas as duas variáveis de release previstas pelo publicador foram alteradas.
- Oito ativações auditadas: **duas flags em quatro organizações ativas elegíveis**, respeitando contratação, módulos e negativas explícitas. **Quatro organizações inativas preservadas**. As flags globais continuam desligadas e overrides por unidade foram preservados.
- Duas APIs verificadas: **32 conferências de flag**, cobrindo as oito organizações e as duas chaves. Consulta e criação anônimas de agendas recusadas com HTTP 401.
- Autobuild, previews e criação automática de branches permanecem desligados nos três apps Amplify. PWA e site não exigiram nova publicação. Os stages legados continuam sendo produção compartilhada; não foram criados ambientes Dev/Homologação isolados.

## Versões e evidências

| Componente | SHA publicado |
|---|---|
| Backend, worker e dispatcher | `4a343a5bd4d169a5a3f2646bd32a0b6f0381b92e` |
| Studio | `600015d671e10a26c7ebd9bf40c1624fd7c4785d` |

PRs: [Backend 9](https://github.com/r-fsena/faith-hub-back/pull/9), [ajuste operacional 10](https://github.com/r-fsena/faith-hub-back/pull/10), [Studio 9](https://github.com/r-fsena/faith-hub-web/pull/9). CI dos SHAs finais: [Backend](https://github.com/r-fsena/faith-hub-back/actions/runs/44220293559), [Studio](https://github.com/r-fsena/faith-hub-web/actions/runs/44219491373).

Gates em checkouts limpos, Node 22 e dependências dos lockfiles: tipagem, **277 testes backend**, builds Studio/PWA e **43 testes PWA**. A implementação passou em **27 verificações MySQL locais isoladas** e testes de interface com APIs sintéticas, incluindo móvel. As contagens antigas de workspace incluíam nove testes de trabalhos locais que foram preservados fora desta versão.

Na ativação da regra, o validador inicialmente esperava somente uma alteração e recusou as duas referências dependentes. O operador de aplicação consultava o arquivo bruto de status, e avançou apesar dessa recusa. A revisão foi completada posteriormente: alteração direta somente de State e duas referências dinâmicas ao mesmo ARN; código e papel IAM sem alterações. O operador foi corrigido para exigir um arquivo separado com aprovação de revisão válida, que só é escrito após todos os critérios passarem. Não se afirma que essa revisão posterior ocorreu antes da execução.

O executor inicialmente interpretou a resposta vazia de `execute-change-set` como erro; a AWS já havia aceitado a criação. O estado foi conferido antes de continuar, sem repetir a execução, e o tratamento de resposta vazia foi corrigido no operador privado.

## Uso e limites

F4 está em **Loja → Estoque**, nas entradas, e em **Loja & Operações**, para margem bruta e cobertura. Custo médio por produto/unidade; despesas adicionais pertencem à entrada registrada. Estoque legado sem comprovação permanece desconhecido. O custo vendido é preservado e cancelamento físico total reutiliza o custo original. Não implementa reembolso financeiro nem devolução parcial.

R2 está em **Inteligência → Relatórios**, com perfil administrativo local autorizado. Selecionar o modelo e as unidades, escolher destinatários internos autorizados e criar a agenda. A primeira execução ocorre no próximo mês, dia 1 a partir das **08h de São Paulo**, sobre o mês encerrado. Não foram criadas agendas automaticamente para as igrejas. Avisos aparecem somente no portal autenticado; arquivos são privados e cada acesso revalida permissões. Histórico/reprocessamento preservam as versões e seus motivos.

Outros fusos, recorrência semanal, carga/SLA de produção e revisão independente da política pela tesouraria não foram certificados nesta publicação. Os alarmes CloudWatch não têm destino externo de notificação. A validação visual autenticada de produção não foi realizada: o host de navegador estava indisponível e a alternativa nativa do Chrome retornou timeout. Não confundir testes com APIs sintéticas com uma jornada autenticada real.

## Contenção e reversão

Desativar a regra horária por atualização revisada do parâmetro `ScheduleEnabled`, e desativar as flags específicas das organizações. Preservar schema, avaliações, custo das vendas, agendas, versões, arquivos privados e auditoria. Após começar o acompanhamento F4, manter leitores e escritores compatíveis; preferir correção que preserve o acompanhamento. Não apagar tabelas nem recalcular custos para desfazer a publicação.

Os ZIPs anteriores, candidatos, manifestos, baselines, autorização e resultados ficam preservados privadamente em `.release-evidence/f4r2-20261117` no workspace operacional. Evidência sanitizada: `operations/evidence/f4-r2-20261117/production.json`. Detalhes funcionais: [F4/R2 — implementação](F4_R2_CUSTOS_E_AGENDAMENTOS_2026-11-17.md).

F3, A2 avançado, inteligência comercial Master e as frentes de ambientes isolados/operação permanecem fora desta publicação.

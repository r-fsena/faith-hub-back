# Publicação A2 — 23/11/2026

**Estado: publicado, migrado e flag ativada em produção.** Release `FH-A2-20261123-001`.

O proprietário autorizou nesta conversa: “certo, realize a publicação, migração e ativação das flags por favor.” A liberação abrange o A2 implementado e revisado, o Studio, o código das funções existentes afetadas, os dois workers que compartilham contratos/flags, a migração aditiva e a ativação somente nas organizações elegíveis. A confirmação anterior do proprietário sobre avaliação da máquina e rotação em dispositivo confiável foi mantida; não se afirma auditoria forense independente.

## Resultado verificado

- Snapshot RDS `faith-hub-pre-a2-20261123-001` disponível antes da migração, no RDS correto de us-east-1, MySQL 8.4.8.
- Migração `20261123_001_advanced_alerts` aplicada, checksum conferido: três tabelas e seis triggers aditivos. Sem retrodatamento de captura, consentimento, vínculos ou movimentações.
- Código de **95 funções legadas e dois workers privados** atualizado. Os 97 checksums e hashes de configuração foram conferidos após publicação. **34 ZIPs de reversão** e 34 candidatos distintos preservados e verificados. Sem deploy Serverless completo ou alteração de rotas, IAM, secrets, memória, timeout ou agendas.
- Studio Amplify **job 161 — SUCCEED**. O log confirmou o SHA real do checkout aprovado e o bundle público contém o A2. Somente as duas variáveis de release previstas pelo publicador foram atualizadas.
- **Quatro ativações auditadas**, uma chave `intelligence.alerts_advanced` por organização ativa elegível. **Quatro organizações inativas preservadas**, flag global desligada, contratos e overrides por unidade preservados. Não foram alterados os critérios/configurações das regras.
- **82 conferências de flag nas duas APIs**, cobrindo organizações e unidades; dois GETs anônimos de alertas recusados com HTTP 401. A credencial real de runtime pôde ler as três tabelas novas e seus privilégios de escrita cobrem a migração, sem realizar gravações para teste. Metadados confirmaram collations compatíveis nas fontes.
- Autobuild, criação automática de branches e previews continuam desligados nos três apps Amplify. PWA e site não exigiram nova publicação.

## Versões e gates

| Componente | SHA publicado |
|---|---|
| Backend e workers | `a1782cd74cab767642b9ad2f0427f60ab3c6e397` |
| Studio | `2a22bb03d6e44581f70e7cbf5b54eb4efcf1c064` |

PRs: [Backend 12](https://github.com/r-fsena/faith-hub-back/pull/12) e [Studio 10](https://github.com/r-fsena/faith-hub-web/pull/10). CI dos SHAs finais: [Backend](https://github.com/r-fsena/faith-hub-back/actions/runs/45198121477) e [Studio](https://github.com/r-fsena/faith-hub-web/actions/runs/45197487547).

Checkouts limpos, Node 22 e `npm ci` pelos lockfiles: tipagem, **282 testes versionados do backend**, builds Studio/PWA e **43 testes PWA**. A implementação passou em **22 verificações MySQL isoladas**, **12 cenários de navegador A2** e **8 cenários de regressão do Studio** com APIs sintéticas. A contagem anterior de 291 no workspace incluía nove testes locais preexistentes, preservados fora da release. Os gates no checkout limpo não dependem do contorno das pastas antigas duplicadas de tipos do workspace.

## Disponibilidade e limites

Acessar **Inteligência → Alertas**, selecionar a unidade e abrir **Regras, cobertura e configuração**. Administradores/pastores podem configurar as regras permitidas; a tesouraria acessa somente a regra financeira e seus acompanhamentos. A revisão da evidência permite conferir a composição na mesma janela e atribuir uma ação com responsável/prazo.

As cinco regras cobrem participação, ativação digital, conclusão de conteúdo, rotina digital e variação do livro financeiro. **A publicação da flag não ativa configurações de regras automaticamente.** Configuração por unidade e evidência suficiente continuam necessárias; ausência de cobertura aparece como espera, sem fabricar alerta ou concluir afastamento. Janelas digitais exigem mês encerrado e maturação, com proteção de amostras e de diferenças. Alteração de população autorizada bloqueia evidência, histórico e ações antigos.

Rotina digital inicial: devocionais, eventos, loja e escalas. A série digital de células compartilha instrumentação com estudos e precisa ser separada antes de ser usada para essa regra; participação usa calendário/presenças. **Divergência bancária continua dependente da F3.** A variação financeira entregue é a do livro registrado, sem comprovar conciliação bancária ou executar pagamentos. Não são enviados convites ou mensagens automaticamente.

A verificação produtiva foi passiva. Não houve invocação manual de Lambda, criação de regras/agendas fictícias, teste com registros de clientes ou jornada autenticada real de produção. Na janela registrada, o CloudWatch mostrou uma invocação e nenhum erro, em três pontos retornados; a janela inclui operação anterior e o rollout e não certifica carga, SLA ou todos os caminhos funcionais. A homologação de escrita e interface foi executada exclusivamente com dados sintéticos. Dev/Homologação isolados e aprovação de release imposta no servidor continuam sendo frentes próprias.

## Contenção, reversão e evidências

Desabilitar apenas os overrides criados por esta release, conferindo ID e proveniência. Preservar tabelas, triggers, consentimento, avaliações, alertas, ações e auditoria. A restauração dos ZIPs anteriores exige comparar o código e a configuração atuais e usar o RevisionId vigente; mudanças de contratos após o baseline exigem nova avaliação de compatibilidade. O Studio anterior é `600015d671e10a26c7ebd9bf40c1624fd7c4785d`, pelo fluxo controlado. Não foi necessário executar reversão.

Manifestos, autorização, snapshot, baselines, arquivos de reversão/candidatos, logs e verificação detalhada ficam preservados privadamente em `.release-evidence/a2-20261123`. Os manifests aprovados foram mantidos; `retained-artifacts.json` relaciona os caminhos temporários dos candidatos às cópias persistentes verificadas. A evidência sanitizada está em [operations/evidence/a2-20261123/production.json](../operations/evidence/a2-20261123/production.json). Critérios e testes: [implementação A2](A2_ALERTAS_AVANCADOS_2026-11-23.md).

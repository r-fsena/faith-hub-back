# Publicação H1 — 17/11/2026

**Estado: publicado e ativado em produção em 17/11/2026.**

Autorização: o proprietário solicitou nesta conversa a publicação, a migração em produção e a ativação da flag. Também confirmou que a avaliação da máquina e a rotação de credenciais foram concluídas em dispositivo confiável; a confirmação e seus limites estão no registro do incidente de 12/11.

## Resultado

- Snapshot RDS `faith-hub-pre-h1-20261117` confirmado disponível antes da migração.
- Migração aditiva `20261117_001_member_history_revisions` aplicada e checksum conferido. Duas tabelas, uma view derivada e cadastro global da flag desligado. Estados originais conferidos nas oito organizações, sem alteração de cadastros, permissões pessoais, finanças ou presenças para testar.
- Código de **95 funções** das stacks legadas e do **worker de relatórios** atualizado, com checksums conferidos e configurações preservadas. Todos os pacotes anteriores foram preservados antes das atualizações: 34 ZIPs distintos cobrem as 96 funções. Nenhum deploy Serverless completo, mudança de rotas, IAM ou secrets.
- Studio Amplify **job 159 — SUCCEED**. O log do guard confirmou o SHA real aprovado, e o bundle público contém o H1. Apenas as duas variáveis de release previstas pelo publicador foram alteradas; regras e demais variáveis foram preservadas.
- `intelligence.history_corrections` ativada por organização nas **cinco organizações ativas elegíveis**, conforme contrato, módulos e cobertura contínua. **Três organizações inativas preservadas sem ativação**. Flag global permanece desligada; negativas explícitas e exceções por unidade não foram sobrescritas. Cinco eventos de auditoria registram a ativação na mesma transação.
- Duas APIs conferidas: **16 verificações de flags**, cobrindo as oito organizações; leitura e gravação anônimas de revisões recusadas com HTTP 401 nas duas APIs.
- Autobuild, previews e criação automática de branches seguem desligados em Studio, PWA e site. PWA/site não exigiram nova publicação neste pacote. Os stages legados continuam sendo produção compartilhada, sem criação de Dev/Homologação isolados.

## Versões e validação

| Componente | SHA publicado |
|---|---|
| Backend e worker | `6563cc32936ee8943478ee004a983aed9d80753f` |
| Studio | `de47d7adaeb7acddd3885f9c91a9fc74e0603d29` |

Revisões: [Backend PR 7](https://github.com/r-fsena/faith-hub-back/pull/7), [Studio PR 8](https://github.com/r-fsena/faith-hub-web/pull/8). CI dos SHAs integrados: [Backend](https://github.com/r-fsena/faith-hub-back/actions/runs/44181004394), [Studio](https://github.com/r-fsena/faith-hub-web/actions/runs/44181008186).

Os gates dos checkouts limpos passaram com Node 22 e dependências dos lockfiles: tipagem, **268 testes backend** e builds Studio/PWA, incluindo **43 testes PWA**. A contagem de 277 da implementação local incluía nove testes de trabalhos locais não relacionados, que ficaram fora da versão. A implementação também passou em 19 verificações de MySQL local descartável e no navegador com APIs sintéticas.

O acesso do Computer Use ao navegador do proprietário estava indisponível. A validação visual autenticada no ambiente real não foi realizada; o guard, o bundle público, o schema, as flags e as recusas de acesso anônimo foram conferidos. Não foram gravadas correções de histórico ou operações de negócio reais para homologar.

## Uso e reversão

Recarregar o Studio, selecionar o consolidado de unidades e abrir **Inteligência → Histórico → Revisar histórico**, com perfil administrativo autorizado. A consulta de versões de coberturas anteriores permanece disponível; novas correções exigem a geração ativa.

Em incidente, pausar novas correções pelas flags das organizações. Manter schema, observações, revisões e leitores compatíveis. Após a primeira correção, não restaurar leitores que ignorem as revisões nem remover registros para desfazer a publicação. O histórico e os arquivos de relatórios anteriores mantêm suas versões. A reversão de código/Studio exige compatibilidade e nova verificação; os ZIPs anteriores e os manifestos estão preservados privadamente em `.release-evidence/h1-20261117` no workspace operacional.

Limites funcionais e detalhes: [H1 — revisão retroativa](H1_REVISAO_RETROATIVA_2026-11-17.md). Este registro substitui as marcações anteriores de “implementado apenas localmente” do H1. F3/F4, R2, A2 avançado e a inteligência comercial Master não integram esta publicação.

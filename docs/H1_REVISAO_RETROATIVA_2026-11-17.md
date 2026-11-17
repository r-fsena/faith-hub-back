# H1 — revisão retroativa do histórico cadastral

Estado em 17/11/2026: implementação e validação locais concluídas. **Não publicado nem ativado em produção.** A migração e a ativação exigem autorização própria pelo [fluxo formal](FLUXO_IMPLEMENTACAO_E_PUBLICACAO.md), após atender à condição operacional de segurança nele registrada.

## Comportamento

No Studio, selecionar o consolidado de unidades e abrir **Inteligência → Histórico → Revisar histórico**. Conferir a observação original, informar vigência em Brasília, situação/unidade/célula históricas e justificativa de 10 a 500 caracteres. Conferir a revisão antes de confirmar. A janela permite consultar as versões preservadas.

Cada correção acrescenta uma linha em `member_history_corrections`. Não modifica `member_state_history`, o cadastro atual, seus papéis ou suas permissões. Registra ator, data do registro, motivo, versão do evento e revisão da organização. A auditoria estrita e o incremento da revisão pertencem à mesma transação; falha na auditoria desfaz ambos. Repetir a mesma solicitação recupera o resultado; reutilizar seu identificador com conteúdo diferente gera conflito.

`member_state_history_effective` aplica a última revisão de cada evento e recompõe o estado anterior de seu sucessor. As consultas de fechamento e de elegibilidade dos encontros resolvem o estado vigente pela data efetiva, preservando o desempate da sequência original. Indicadores recalculam na consulta e identificam a revisão histórica utilizada. Leituras atravessadas por outra correção são recusadas para atualização, sem misturar revisões.

Relatórios novos de Resumo executivo e Comunidade incluem uma seção histórica quando o solicitante tem acesso às fontes. PDF e CSV preservam a mesma revisão e registram a versão histórica nas definições. Uma nova correção exige uma nova geração para obter números revistos; arquivos anteriores permanecem na versão em que foram gerados. Relatórios financeiros não recebem dados cadastrais/pastorais.

## Escopo e limites

- Leitura/edição de revisões exige SUPERADMIN, PASTOR ou ADMIN com acesso a todas as unidades, além dos módulos e flags habilitados nas unidades envolvidas. Líderes conservam somente as leituras históricas já autorizadas, com os lados fora do seu escopo ocultos.
- Flag nova: `intelligence.history_corrections`, fallback desligado, consumida por `useFeatureFlags()` no Studio e conferida no servidor. Depende de `intelligence.overview`, `intelligence.history` e `members.module_enabled`. Direitos comerciais são uma extensão gratuita do histórico contratado, preservando negativas explícitas. A migração não ativa a flag nem altera preços/contratos existentes.
- Linha de base é imutável. Correções só pertencem à geração de cobertura ativa. Períodos anteriores ou lacunas não são reconstruídos.
- A data deve estar entre o início da cobertura e a observação original e preservar a ordem dos fatos vizinhos. Não se inventa um evento anterior à linha de base nem se trocam os lugares de eventos existentes.
- O estado posterior do último evento deve continuar coincidindo com o cadastro atual: é possível corrigir sua data; para corrigir seu estado, primeiro regularizar o cadastro na origem. Eventos intermediários permitem revisar situação, unidade e célula. Papéis históricos continuam os observados originalmente.
- Remoção permite revisar sua data, sem criar um estado posterior. Célula nova precisa pertencer à organização/unidade proposta; uma célula histórica removida pode ser preservada quando não alterada.
- Opções exibem até 200 unidades e 500 células, com indicação de limite; referências históricas existentes são mantidas. Revisões têm paginação de 50 registros.
- Desligar a flag de edição não apaga revisões nem faz indicadores ignorarem correções já registradas.

## Migração e sequência de publicação

Migração aditiva preparada: `20261117_001_member_history_revisions`, em `migrate_member_history_revisions.js`. Requer a fundação `20261108_002_intelligence_foundations`. Cria duas tabelas, a view derivada e o cadastro global **desligado** da flag. Não altera o arquivo/checksum de migrações publicadas, triggers existentes, observações históricas ou cadastros de membros.

Após revisão de impacto, autorização e backup pelo fluxo formal:

1. Aplicar a nova migração e conferir checksum/schema. Os novos leitores exigem essas estruturas mesmo com a flag de edição desligada.
2. Publicar o backend, incluindo os leitores históricos/calendário e o worker de relatórios; depois, o Studio, usando versões e manifestos compatíveis. O PWA não tem alteração de código neste pacote.
3. Autorizar e ativar a flag apenas no tenant/piloto selecionado, conforme contrato e permissões. Homologar com a equipe responsável e registrar evidência.

Comandos preparados (não executados contra produção nesta implementação):

```sh
npm run db:migrate:member-history-revisions:status
npm run db:migrate:member-history-revisions
```

Reversão: pausar novas correções pela flag e manter schema, observações, revisões e leitores compatíveis. Após a primeira correção, não restaurar leitores que consultem apenas `member_state_history` e ignorem as revisões. Uma correção equivocada recebe outra revisão motivada; não excluir a revisão anterior. Arquivos gerados mantêm sua revisão/expiração e autorização próprias.

## Concorrência

A correção usa `READ COMMITTED`, bloqueia o cadastro alvo e toma locks compartilhados `NOWAIT` sobre flag/cobertura antes de validar o histórico. Isso convive com o trigger das gravações normais e recusa uma inicialização de cobertura concorrente sem formar um ciclo de locks. Versões do evento e dos indicadores são conferidas antes do append. Conflito, indisponibilidade temporária de lock e versão desatualizada devolvem HTTP 409, pedindo nova consulta.

## Validação local

- 277 testes backend aprovados, incluindo autenticação/tenant/unidades/papéis/flags, limites temporais, idempotência, preservação do cadastro e rollback de auditoria.
- MySQL Community 8.4.7 exclusivamente em `127.0.0.1:33308`: 19 verificações com schema e dados sintéticos descartáveis. Incluem migration/view reaplicáveis, recálculo dos fechamentos/participação, recomposição do evento sucessor, isolamento de tenants com a mesma referência, PDF/CSV com revisão congelada, correções concorrentes, edição normal simultânea e bloqueio de inicialização/geração antiga. Nenhum acesso à AWS ou a dados de clientes.
- Navegador com APIs/autenticação sintéticas: confirmação antes de gravar, conversão Brasília/UTC, conflito e repetição idempotente, revisão preservada, paginação com rascunho/versão congelados, consulta de gerações anteriores sem edição, foco/Escape e diálogo no celular, flags e escopo administrativo.
- Tipagem backend e builds Studio/PWA aprovados; o build PWA inclui seus 43 testes.
- A execução direta da tipagem no workspace encontrou diretórios duplicados incompletos `node_modules/@types/* 2`. A mesma fonte passou em cópia temporária com `typeRoots` apontando somente para os diretórios de tipos válidos e com as dependências do workspace. Nenhuma dependência/lockfile foi alterado para contornar isso.

Repetir testes de banco somente com MySQL local de QA na porta fixa 33308:

```sh
npm run test:member-history:mysql
```

O runner não carrega `.env`, não lê credenciais AWS e não aceita hostname/porta de produção. Cria/remove somente um schema sintético `faith_h1_qa_*`. A validação de navegador fica no Studio em `npm run test:member-history`.

Evidências sanitizadas do workspace: [resumo de validação](../../evidencias/h1-revisao-retroativa-2026-11-17/RESUMO.md).

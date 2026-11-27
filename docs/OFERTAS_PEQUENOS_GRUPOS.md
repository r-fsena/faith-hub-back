# Ofertas dos pequenos grupos

A flag `cell_groups.offerings` controla o registro e a visualização de ofertas nas reuniões. O padrão é desligado. A chamada continua disponível sem oferta; os valores antigos permanecem armazenados e voltam a aparecer ao reativar a flag.

No Studio, um SUPERADMIN, PASTOR ou ADMIN autorizado acessa Gestão de Feature Flags, seleciona a igreja, **Todas as Unidades** e o ambiente desejado e habilita **Registro de ofertas nas reuniões dos pequenos grupos**. Esse escopo libera todos os grupos da igreja; overrides específicos de unidade continuam seguindo a herança existente. `Todos` aplica a escolha a todos os ambientes do tenant. Esta entrega não acrescenta um controle de ativação entre igrejas diferentes.

A flag é uma opção do módulo de pequenos grupos já contratado. Não altera preços ou contratos e não libera o módulo quando ele estiver desabilitado ou o período de teste estiver expirado. O catálogo inclui a flag mesmo antes do cadastro inicial no banco. Alterações usam os endpoints autenticados e auditados de flags existentes.

O backend avalia a organização autorizada e a unidade real do grupo. O ambiente vem de `APP_STAGE`: `development` e `staging` usam seus próprios escopos; os stages legados `dev`/`prod` e o padrão usam `production`. Headers e query strings não podem liberar uma oferta usando outro ambiente. Com a flag desligada, valores diferentes de zero retornam 403; ausência do campo ou zero mantém compatibilidade com clientes anteriores. Histórico e detalhe omitem `offerings_amount` enquanto desativada.

O registro exige perfil de liderança, isolamento de tenant/unidade e, para LEADER, liderança do grupo. Reunião, participantes e auditoria com o valor da oferta são gravados na mesma transação.

## Publicação e reversão

Código preparado localmente. Seguir `FLUXO_IMPLEMENTACAO_E_PUBLICACAO.md` para revisão e autorização específica dos componentes backend, Studio e PWA. Não executar os comandos abaixo contra infraestrutura real sem a autorização registrada.

Autorização do proprietário em 27/11/2026: “deixe essa célula 100% desativada em todos os ambientes” e “realize a publicação e ativação em produção”. Escopo interpretado conforme a conversa: publicar backend, Studio e PWA desta entrega mantendo **a flag de ofertas desligada** em todos os tenants, unidades e ambientes. O restante do módulo de pequenos grupos permanece disponível. Inclui cadastrar o padrão desligado e desativar overrides desta chave; não autoriza ofertas, chamadas ou outros lançamentos de teste em produção.

A migração `node migrate_cell_group_offerings.js --apply` cadastra somente o padrão global desligado em `tenant_feature_flags` e registra auditoria/checksum. É idempotente, preserva configurações existentes e não ativa tenants. `--status` consulta apenas o registro da migração; a aplicação exige `schema_migrations` e `security_audit_logs` existentes. Não há mudança de schema ou recálculo financeiro.

Para cumprir a desativação em todos os escopos, `node scripts/disable-cell-group-offerings.cjs --release-id RELEASE_ID` mostra o plano sem gravar. Após a migração, acrescentar `--apply --evidence /caminho/privado/novo.json` desativa os overrides habilitados desta única chave, com backup privado anterior, filtros por organização, auditoria por alteração e transação. Escopos já desligados são preservados. A verificação final exige zero overrides habilitados; a ausência de overrides herda o padrão desligado. Não altera ofertas históricas ou outras flags.

Antes da ativação autorizada, registrar tenant, ambiente, unidade e valor anterior para reversão. Para conter uma ativação, restaurar o valor anterior nesse mesmo escopo pelo painel. Não excluir reuniões nem zerar ofertas históricas. Um rollback completo deve coordenar os três componentes, pois a versão anterior do backend não impõe esta flag. O padrão desligado pode permanecer no banco durante rollback; não remover overrides ou registros de auditoria.

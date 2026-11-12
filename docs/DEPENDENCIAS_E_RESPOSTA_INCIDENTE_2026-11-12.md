# Dependências comprometidas identificadas durante a etapa 1

**Data:** 12/11/2026. **Estado:** correção do repositório e bloqueios de instalação implementados; avaliação da máquina e rotação de credenciais continuam necessárias.

## Evidência observada

O CI do backend falhou em `npm ci`: o registro npm respondeu 404 ao tarball `plain-crypto-js@4.2.1`. O lockfile anterior fixava `axios@1.14.1`, que introduzia essa dependência de desenvolvimento. A inspeção, sem executar o pacote, encontrou também essas versões no `node_modules` local do backend e um `setup.js` configurado como `postinstall`.

As outras três aplicações não continham essas dependências nos lockfiles inspecionados. Isso não certifica ausência de comprometimento da máquina, dos artefatos ou de credenciais utilizadas por ela.

A presença dos arquivos **não comprova que o postinstall foi executado**, quando teria sido executado, nem se houve acesso indevido. A orientação do projeto Axios e do GitHub para essas versões é tratar a máquina como potencialmente comprometida e rotacionar credenciais a partir de outro dispositivo confiável.

## Ações executadas no escopo desta entrega

- Registrados metadados e hash do `setup.js` na evidência local, sem publicar o conteúdo do payload.
- Movidos os diretórios afetados para quarentena privada temporária, sem executá-los.
- Fixado `axios@1.21.1` via `overrides`, com lockfile atualizado a partir do registro npm; versão confirmada na release oficial do projeto.
- Adicionado bloqueio para `axios@1.14.1`, `axios@0.30.4` e qualquer `plain-crypto-js` nos lockfiles, inclusive dependências aninhadas. O bloqueio roda antes de `npm ci` no CI dos quatro repositórios e nos builds Amplify, além do caminho de liberação.
- Validações locais da árvore corrigida utilizaram instalação com `--ignore-scripts`. Não buscar o tarball removido em espelhos nem substituir por um pacote com nome parecido.
- Mantido o bloqueio de publicação automática que já havia sido aplicado. Não foram efetuadas novas alterações de produção após a identificação do incidente.

A atualização do pacote e a exclusão dos arquivos afetados não equivalem à limpeza da máquina. A quarentena em diretório temporário não é armazenamento forense permanente.

## Ações pendentes antes de nova liberação de produção

1. Em dispositivo confiável, avaliar e rotacionar/revogar credenciais potencialmente expostas: AWS, GitHub, npm, integrações de cobrança, banco, chaves de assinatura e outros secrets acessíveis à máquina. Inventariar o alcance sem copiar valores para relatórios ou conversas.
2. Planejar a sequência da rotação para não interromper cobrança, webhooks ou autenticação; atualizar os consumidores e testar cada substituição antes de desativar chaves que exigem continuidade. Credenciais suspeitas de uso ativo podem exigir revogação imediata pelo responsável de segurança.
3. Preservar evidências e avaliar a máquina com o responsável de segurança. Se necessário, reinstalar/recriar a estação e os ambientes de execução a partir de fontes confiáveis.
4. Verificar logs de acesso AWS/GitHub/provedores e os artefatos anteriores. O fato de ser dependência de desenvolvimento não elimina risco às credenciais do processo de build/deploy.
5. Só depois retomar liberações de produção usando uma identidade confiável, de escopo mínimo e preferencialmente temporária.

Nenhuma credencial foi rotacionada/revogada nesta entrega. Fazer isso de forma indiscriminada nesta mesma máquina não garantiria contenção e poderia interromper o produto. A etapa 1 bloqueia publicação automática; não representa encerramento de incidente de segurança.

## Fontes primárias

- [Post mortem do projeto Axios](https://github.com/axios/axios/issues/10636).
- [Advisory GitHub: malware em Axios](https://github.com/advisories/GHSA-fw8c-xr5c-95f9).
- [Release oficial Axios 1.21.1](https://github.com/axios/axios/releases/tag/v1.21.1).

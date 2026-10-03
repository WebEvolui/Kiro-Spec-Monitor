# Como testar e publicar a extensao Kiro Spec Monitor

Este guia lista **o que depende de voce**. Tudo que podia ser automatizado ja foi feito:
icone, README, CHANGELOG, LICENSE, config de debug (F5), workspace de exemplo,
limpeza de dependencias e o pacote `.vsix` ja gerado e validado.

---

## PARTE A — Ver a extensao funcionando (local, sem publicar)

### Opcao 1 — Modo debug (F5) [recomendado]
1. Abra a pasta `kiro-spec-monitor` no Kiro/VS Code (File > Open Folder).
   IMPORTANTE: abra a pasta `kiro-spec-monitor`, nao a pasta de cima.
2. Pressione **F5** (ou Run > Start Debugging).
   - Isso compila e abre uma segunda janela: "Extension Development Host".
3. Nessa janela nova, abra uma pasta que tenha `.kiro/specs/`. Para um teste rapido,
   abra a pasta de exemplo que ja deixei pronta:
   `kiro-spec-monitor/sample-workspace`
4. Clique no icone **KIRO SPEC MONITOR** na barra lateral (Activity Bar).
5. Verifique:
   - [ ] As Specs aparecem na lista.
   - [ ] Expandir uma Spec mostra tarefas e subtarefas em arvore.
   - [ ] Tarefas concluidas (check), pendentes (circulo).
   - [ ] Percentual e contagem X/Y por Spec.
   - [ ] Clicar numa tarefa abre o tasks.md na linha certa.
   - [ ] Editar um checkbox [ ] -> [x] no tasks.md atualiza a arvore sozinho.
   - [ ] Criar uma nova pasta de spec faz ela aparecer.

### Opcao 2 — Instalar o pacote .vsix
1. Kiro/VS Code > Extensions > menu "..." > "Install from VSIX..."
   e escolha `kiro-spec-monitor-0.0.1.vsix`.
   (ou no terminal: `code --install-extension kiro-spec-monitor-0.0.1.vsix`)
2. Recarregue a janela e teste como acima.

---

## PARTE B — Personalizar antes de publicar (OBRIGATORIO)

Abra `kiro-spec-monitor/package.json` e troque os 3 placeholders:

1. `"publisher": "SEU-PUBLISHER-ID"`  -> o ID do seu publisher (criado na Parte C, passo 2).
2. Em `repository.url`, `bugs.url`, `homepage`: troque `SEU-USUARIO` pelo seu GitHub.
   (Se nao for publicar o codigo no GitHub, pode remover esses 3 campos.)

Depois rode novamente para regenerar o pacote:
```
cd kiro-spec-monitor
npm run package
```

---

## PARTE C — Publicar no VS Code Marketplace

> O Marketplace da Microsoft usa Azure DevOps para autenticacao.

1. **Conta Azure DevOps + Token (PAT)**
   - Crie/entre em https://dev.azure.com
   - User settings > Personal Access Tokens > New Token
   - Organization: "All accessible organizations"
   - Scopes: marque **Marketplace > Manage**
   - Copie o token (voce so o ve uma vez).

2. **Criar o publisher**
   - Va em https://marketplace.visualstudio.com/manage
   - Create publisher. O "ID" que voce escolher e o que vai no campo `publisher` do package.json.

3. **Login e publicacao** (no terminal, dentro de `kiro-spec-monitor`):
   ```
   npx vsce login SEU-PUBLISHER-ID      # cola o PAT quando pedir
   npx vsce publish                     # publica a versao atual
   ```
   Ou publicar o .vsix ja gerado:
   ```
   npx vsce publish --packagePath kiro-spec-monitor-0.0.1.vsix
   ```

4. **Novas versoes** (depois de mudar o codigo):
   ```
   npx vsce publish patch   # 0.0.1 -> 0.0.2  (ou minor / major)
   ```

---

## PARTE D (opcional) — Open VSX

Editores derivados do VS Code costumam usar o Open VSX em vez do Marketplace da Microsoft.
Para publicar la tambem:
1. Crie conta em https://open-vsx.org e gere um token (namespace = seu publisher).
2. ```
   npx ovsx create-namespace SEU-PUBLISHER-ID -p SEU-TOKEN-OPENVSX
   npx ovsx publish kiro-spec-monitor-0.0.1.vsix -p SEU-TOKEN-OPENVSX
   ```

---

## Checklist final antes de publicar
- [ ] Testei no F5 e esta funcionando.
- [ ] Troquei `publisher` no package.json.
- [ ] (Opcional) Ajustei repository/bugs/homepage ou removi.
- [ ] Rodei `npm run package` e o .vsix foi gerado sem erros.
- [ ] Criei publisher e PAT no Azure DevOps.
- [ ] `npx vsce publish` concluiu.

Pronto: a extensao aparece no Marketplace em alguns minutos.

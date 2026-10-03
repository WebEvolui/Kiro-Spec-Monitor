# Kiro Spec Monitor

Monitor visual, em tempo real e **somente-leitura**, das Kiro Specs e suas tarefas, dentro do Kiro IDE / VS Code.

> Extensao comunitaria e independente. **Nao** e um produto oficial da Kiro ou da AWS.

## Recursos

- Barra lateral dedicada "KIRO SPEC MONITOR" na Activity Bar.
- Deteccao automatica de Specs em .kiro/specs/*/.
- Arvore de tarefas e subtarefas com estados: concluida, em execucao e pendente.
- Progresso por Spec (contagem X/Y e percentual), contando apenas tarefas-folha.
- Clique em uma tarefa para abrir o 	asks.md exatamente na linha correspondente.
- Atualizacao automatica ao editar/concluir tarefas ou criar/remover Specs.
- Deteccao de tarefa em execucao (quando ha fonte confiavel na metadata interna do Kiro) com cronometro ao vivo.
- Interface em Portugues e Ingles, seguindo o idioma do editor.

## Como usar

1. Abra um projeto que contenha a pasta .kiro/specs/.
2. Clique no icone **KIRO SPEC MONITOR** na Activity Bar.
3. Expanda uma Spec para ver suas tarefas; clique em uma tarefa para navegar ate ela.

## Comandos

- Kiro Spec Monitor: Refresh Specs
- Open Tasks File
- Reveal Task
- Collapse All
- Open Spec Folder

## Privacidade

A extensao e estritamente somente-leitura fora do seu proprio estado (workspaceState): nunca escreve no seu 	asks.md nem na metadata interna do Kiro (~/.kiro). Sem rede, sem telemetria.

## Licenca

MIT.

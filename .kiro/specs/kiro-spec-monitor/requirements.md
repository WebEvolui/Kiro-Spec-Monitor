# Requirements Document

## Introduction

O **Kiro Spec Monitor** é uma extensão comunitária e independente (NÃO oficial da Kiro/AWS), compatível com VS Code e Kiro IDE, que oferece um monitor visual, em tempo real e **somente-leitura** das Kiro Specs e de suas tarefas, exibido em uma visão na Activity Bar intitulada "KIRO SPEC MONITOR". A versão V1 é estritamente de monitoramento: nunca executa tarefas, nunca escreve em `tasks.md` e nunca escreve em metadados internos da Kiro sob `~/.kiro`.

A extensão observa duas fontes: os arquivos `.kiro/specs/**/tasks.md` do workspace (fonte autoritativa da estrutura e da conclusão das tarefas) e os metadados internos e não oficiais de execução da Kiro sob o diretório home do usuário (`~/.kiro/spec-sessions` e `~/.kiro/tasks`). Como a Kiro não expõe nenhuma API oficial de estado de execução, a detecção de "em execução" só ocorre quando há um sinal confiável nessa fonte interna; na ausência dele, a visão de concluído/pendente permanece totalmente funcional.

Este documento deriva os requisitos a partir do design técnico aprovado (`design.md`) e os mantém consistentes com a abordagem arquitetural descrita nele (fontes → serviços → modelos de domínio → `TreeDataProvider` → comandos).

## Glossary

- **Extensao**: a extensão Kiro Spec Monitor como um todo (identificador/pasta `kiro-spec-monitor`).
- **Spec**: uma Kiro Spec, representada por uma pasta sob `.kiro/specs/` que contém um arquivo `tasks.md`.
- **Tarefa (Task)**: um item de trabalho representado por uma linha de checkbox (`- [ ]` ou `- [x]`) em `tasks.md`.
- **Tarefa_Folha (Leaf Task)**: uma tarefa sem tarefas filhas; única unidade contada no progresso.
- **Tarefa_Pai**: uma tarefa que agrupa tarefas filhas; nó organizacional não contado no progresso.
- **SpecScanner**: serviço que localiza as Specs encontrando arquivos `tasks.md`.
- **TaskParser**: serviço puro e determinístico que converte o texto de `tasks.md` em uma árvore de tarefas.
- **TaskStateProvider**: abstração que fornece o estado da tarefa (`completed`/`running`/`pending`) desacoplado da fonte.
- **KiroMetadataStateProvider**: implementação do TaskStateProvider que lê os metadados internos da Kiro.
- **FallbackStateProvider**: implementação do TaskStateProvider que deriva o estado apenas do checkbox de `tasks.md` e nunca emite `running`.
- **TaskRuntimeService**: serviço que mantém o `startedAt` por tarefa, calcula o tempo decorrido e agenda o tick do cronômetro.
- **WorkspaceIdResolver**: serviço que resolve o `workspaceId` opaco que correlaciona os metadados internos ao workspace aberto.
- **SpecAggregator**: serviço que compõe scanner, parser e provedor de estado em uma lista ordenada de Specs e calcula o progresso.
- **SpecTreeProvider**: `TreeDataProvider` que renderiza a árvore e executa atualizações direcionadas (targeted refresh).
- **TreeView**: a visão nativa de árvore do VS Code (não WebView) usada para renderização.
- **Metadados_Internos**: arquivos não oficiais da Kiro sob `~/.kiro/spec-sessions` e `~/.kiro/tasks`, tratados como fonte não confiável e somente-leitura.
- **startedAt**: timestamp (epoch em ms) do início da execução mais recente de uma tarefa.
- **workspaceState**: armazenamento de estado próprio da extensão fornecido pela API do VS Code.

## Requirements

### Requisito 1: Descoberta de Specs

**História de Usuário:** Como desenvolvedor, quero que a extensão detecte automaticamente minhas Specs, para que eu veja todas elas sem configuração manual.

#### Critérios de Aceitação

1. WHEN a Extensao realiza a descoberta de Specs, THE SpecScanner SHALL localizar cada Spec identificando os arquivos `tasks.md` sob `.kiro/specs/*/`.
2. THE SpecScanner SHALL retornar uma entrada por pasta de Spec que contenha um arquivo `tasks.md`.
3. IF o workspace não possui um diretório `.kiro`, THEN THE SpecScanner SHALL retornar uma lista vazia sem gerar erro.
4. WHILE o workspace não possui Specs, THE Extensao SHALL exibir uma visão vazia sem gerar erro.

### Requisito 2: Análise do arquivo tasks.md
**História de Usuário:** Como desenvolvedor, quero que a extensão interprete corretamente o conteúdo de `tasks.md`, para que a árvore reflita fielmente minhas tarefas.
#### Critérios de Aceitação
1. WHEN o TaskParser recebe o mesmo texto de `tasks.md` como entrada, THE TaskParser SHALL produzir uma árvore de tarefas idêntica em estrutura (mesma hierarquia pai-filho, mesma ordem de irmãos, mesmos identificadores, mesmos estados e mesmos índices de linha), sem depender de estado externo, horário, acesso a disco ou ordem de execução.
2. THE TaskParser SHALL reconhecer tarefas de nível superior e subtarefas aninhadas em no mínimo 5 níveis de profundidade.
3. THE TaskParser SHALL determinar o nível de aninhamento de uma tarefa a partir da indentação da linha de checkbox, onde cada tabulação equivale a um nível e cada grupo de 2 espaços equivale a um nível, e SHALL atribuir a tarefa como filha da tarefa precedente mais próxima cujo nível de indentação seja imediatamente inferior.
4. THE TaskParser SHALL reconhecer numeração nos formatos `1`, `2`, `12.1`, `12.2` e `12.2.1`, suportando de 1 a 5 segmentos numéricos separados por ponto.
5. WHEN a linha de checkbox contém `[x]` ou `[X]`, THE TaskParser SHALL registrar o estado da tarefa como concluída; WHEN a linha de checkbox contém `[ ]`, THE TaskParser SHALL registrar o estado da tarefa como não concluída.
6. THE TaskParser SHALL reconhecer indentação composta por tabulações, por espaços ou por combinação de ambas ao determinar o aninhamento, tratando uma tabulação como equivalente a 2 espaços.
7. THE TaskParser SHALL aceitar tarefas sem numeração, mantendo o campo de número indefinido e sem rejeitar a tarefa.
8. WHEN uma linha de requisitos no formato `*Requirements: 6.3, 6.4*` segue uma tarefa, THE TaskParser SHALL anexar os números de requisitos à tarefa de checkbox precedente mais próxima no texto, sem criar um nó de tarefa a partir da linha de requisitos.
9. WHERE uma linha é um marcador de lista sem checkbox (bullet de detalhe), THE TaskParser SHALL tratá-la como detalhe e NÃO criar uma tarefa a partir dela.
10. THE TaskParser SHALL ignorar, para fins de estrutura da árvore, descrições em múltiplas linhas e prosa complementar que não correspondam a uma linha de checkbox.
11. IF uma linha é malformada e não corresponde ao padrão de linha de checkbox, THEN THE TaskParser SHALL ignorar a linha, prosseguir com as demais linhas e não lançar exceção nem interromper a análise.
12. THE TaskParser SHALL registrar, para cada tarefa, o índice de linha (base 0) da linha de checkbox em `tasks.md`.
13. THE TaskParser SHALL definir o identificador de cada tarefa como o texto do checkbox sem o prefixo `- [ ]` ou `- [x]`, com os espaços nas extremidades removidos, de modo que o identificador corresponda às chaves de metadados do Kiro.
14. IF o identificador resultante de uma tarefa é uma cadeia vazia após a remoção do prefixo e dos espaços nas extremidades, THEN THE TaskParser SHALL ignorar a linha sem criar um nó de tarefa.
15. IF duas ou mais tarefas possuem identificadores idênticos, THEN THE TaskParser SHALL preservar todas as tarefas como nós distintos na árvore, mantendo a ordem de ocorrência no texto, sem sobrescrever ou descartar nós.

### Requisito 3: Hierarquia de tarefas

**História de Usuário:** Como desenvolvedor, quero ver minhas tarefas organizadas em hierarquia, para que eu entenda a relação entre tarefas pai e subtarefas.

#### Critérios de Aceitação

1. THE TaskParser SHALL preservar a árvore de relações pai/filho das tarefas.
2. WHEN uma tarefa filha é criada, THE TaskParser SHALL definir o nível da filha como o nível do pai acrescido de um.
3. THE SpecTreeProvider SHALL renderizar a hierarquia de tarefas preservando a estrutura pai/filho na TreeView.
4. THE TaskParser SHALL garantir que a lista de filhos de uma tarefa contenha apenas tarefas reais (linhas de checkbox), nunca bullets de detalhe.

### Requisito 4: Cálculo de progresso

**História de Usuário:** Como desenvolvedor, quero ver o progresso real de cada Spec, para que eu saiba quanto do trabalho foi concluído sem contagem duplicada.

#### Critérios de Aceitação

1. THE SpecAggregator SHALL contar apenas Tarefas_Folha (tarefas sem filhos) no cálculo de progresso.
2. THE SpecAggregator SHALL excluir Tarefas_Pai que apenas agrupam subtarefas da contagem total de progresso.
3. THE SpecAggregator SHALL expor a quantidade de tarefas concluídas e o total de tarefas contadas no formato "13 / 19 tarefas" e um valor percentual.
4. IF não existem tarefas contadas (total igual a zero), THEN THE SpecAggregator SHALL definir o progresso como 0 sem realizar divisão por zero.
5. THE SpecAggregator SHALL manter a quantidade de concluídas entre 0 e o total e o progresso no intervalo de 0 a 1.
6. WHERE o total é maior que zero e todas as tarefas contadas estão concluídas, THE SpecAggregator SHALL marcar a Spec como completa.

### Requisito 5: Renderização na TreeView
**História de Usuário:** Como desenvolvedor, quero uma visão em árvore clara e adaptada ao tema, para que eu identifique rapidamente o estado de cada tarefa.
#### Critérios de Aceitação
1. THE SpecTreeProvider SHALL renderizar as Specs e tarefas usando uma TreeView nativa, não uma WebView.
2. THE SpecTreeProvider SHALL utilizar exclusivamente ThemeIcons (sem cores fixas, imagens ou caminhos de arquivo) compatíveis com os temas claro e escuro.
3. WHEN uma tarefa está concluída, THE SpecTreeProvider SHALL exibir o ícone de verificação (check).
4. WHILE uma tarefa está em execução, THE SpecTreeProvider SHALL exibir o ícone de sincronização animado (sync~spin).
5. WHEN uma tarefa está pendente, THE SpecTreeProvider SHALL exibir o ícone de círculo (circle-outline).
6. WHEN todas as tarefas contabilizadas de uma Spec estão concluídas (Spec completa), THE SpecTreeProvider SHALL exibir o ícone de conclusão (pass-filled ou check-all).
7. THE SpecTreeProvider SHALL compor cada item com um rótulo (label) não vazio, uma descrição (description) e um tooltip.
8. THE SpecTreeProvider SHALL exibir, por Spec, um percentual inteiro de 0 a 100 seguido do símbolo "%" e a contagem de tarefas no formato X/Y, onde X é o número de tarefas concluídas e Y é o número total de tarefas contabilizadas.
9. IF uma Spec não possui tarefas contabilizadas (Y igual a 0), THEN THE SpecTreeProvider SHALL exibir o percentual como "0%" e a contagem como "0/0", sem erro de divisão.

### Requisito 6: Navegação por clique
**História de Usuário:** Como desenvolvedor, quero clicar em uma tarefa e ir direto até ela no arquivo, para que eu edite ou leia o contexto rapidamente.
#### Critérios de Aceitação
1. WHEN o usuário clica em uma tarefa na TreeView, THE Extensao SHALL abrir o arquivo `tasks.md` correspondente àquela tarefa no editor em até 1 segundo.
2. WHEN o arquivo `tasks.md` correspondente é aberto por meio do clique em uma tarefa, THE Extensao SHALL posicionar o cursor na linha exata da tarefa, usando o número de linha de base zero armazenado no modelo da tarefa.
3. WHEN o arquivo `tasks.md` correspondente é aberto por meio do clique em uma tarefa, THE Extensao SHALL revelar e centralizar verticalmente a linha da tarefa na área de edição em até 1 segundo.
4. IF o arquivo `tasks.md` correspondente à tarefa não existe ou não pode ser lido, THEN THE Extensao SHALL abortar a navegação, preservar o estado atual do editor e exibir uma mensagem de erro indicando que o arquivo não foi encontrado ou é inválido.
5. IF o número de linha armazenado na tarefa for menor que 0 ou maior que o índice da última linha do arquivo (de 0 a número total de linhas menos 1), THEN THE Extensao SHALL ajustar o cursor para uma linha válida dentro desse intervalo ou abrir o arquivo na primeira linha (linha 0), sem exibir erro.

### Requisito 7: Atualizações em tempo real

**História de Usuário:** Como desenvolvedor, quero que a visão reflita mudanças automaticamente, para que eu não precise atualizar manualmente ao editar ou executar tarefas.

#### Critérios de Aceitação

1. THE Extensao SHALL registrar um FileSystemWatcher sobre `.kiro/specs/**/tasks.md`.
2. WHEN o estado de um checkbox de tarefa muda, THE Extensao SHALL atualizar a visão correspondente.
3. WHEN uma nova Spec é criada, THE Extensao SHALL exibi-la automaticamente na visão.
4. WHEN uma Spec é removida, THE Extensao SHALL removê-la da visão.
5. WHEN um arquivo `tasks.md` é criado ou alterado, THE Extensao SHALL atualizar a visão correspondente.
6. WHEN uma tarefa é adicionada ou removida em `tasks.md`, THE Extensao SHALL refletir a mudança na visão.
7. THE Extensao SHALL aplicar debounce aos eventos de mudança para evitar atualizações excessivas.

### Requisito 8: Detecção de estado "em execução" (apenas fonte confiável)

**História de Usuário:** Como desenvolvedor, quero ver qual tarefa a Kiro está executando, para que eu acompanhe a execução sem interpretações enganosas.

#### Critérios de Aceitação

1. THE KiroMetadataStateProvider SHALL detectar a tarefa em execução apenas quando houver um sinal confiável nos Metadados_Internos (`~/.kiro/tasks/<workspaceId>/<spec>.meta.json` correlacionado via `~/.kiro/spec-sessions`).
2. WHEN uma tarefa está marcada como concluída (checkbox `[x]`), THE KiroMetadataStateProvider SHALL atribuir o estado concluído e nunca o estado em execução.
3. IF não há metadados ou não há histórico de execução para a tarefa, THEN THE KiroMetadataStateProvider SHALL atribuir o estado pendente.
4. IF existe um resultado final de execução registrado nos metadados, THEN THE KiroMetadataStateProvider SHALL atribuir o estado pendente para a tarefa não marcada.
5. WHERE uma tarefa não está marcada, possui histórico de execução e não possui status final de execução, THE KiroMetadataStateProvider SHALL atribuir o estado em execução.
6. THE KiroMetadataStateProvider SHALL abster-se de inferir o estado em execução a partir da próxima tarefa pendente, de um checkbox vazio, de um arquivo modificado recentemente ou de um arquivo aberto.
7. IF não há fonte confiável de estado em execução, THEN THE Extensao SHALL manter a visão de concluído/pendente totalmente funcional sem exibir estado em execução e com o cronômetro inativo.
8. THE Extensao SHALL tratar os Metadados_Internos como fonte somente-leitura e nunca escrever nesses metadados nem em `tasks.md`.

### Requisito 9: Indicação e destaque de tarefa em execução
**História de Usuário:** Como desenvolvedor, quero destaque visual claro das tarefas em execução, para que eu identifique imediatamente o que está rodando.
#### Critérios de Aceitação
1. WHEN uma tarefa entra no estado em execução, THE SpecTreeProvider SHALL exibir o indicador 🔄 Running para a tarefa dentro de 1 segundo após a mudança de estado.
2. WHEN uma tarefa entra no estado em execução, THE SpecTreeProvider SHALL aplicar à tarefa um destaque visual distinto que a diferencie das tarefas que não estão em execução, dentro de 1 segundo após a mudança de estado.
3. WHEN uma tarefa deixa o estado em execução, THE SpecTreeProvider SHALL remover o indicador 🔄 Running e o destaque visual da tarefa dentro de 1 segundo após a mudança de estado.
4. WHILE pelo menos uma tarefa de uma Spec está em execução, THE SpecTreeProvider SHALL exibir no nível da Spec a contagem de tarefas em execução, a contagem de tarefas concluídas e o total de tarefas da Spec (por exemplo, "🔄 2 running • 13/19 tasks").
5. WHILE múltiplas tarefas estão em execução em paralelo (de 2 até no máximo 100 tarefas simultâneas), THE SpecTreeProvider SHALL exibir para cada tarefa em execução, de forma independente e simultânea, seu próprio indicador 🔄 Running e seu próprio destaque visual.

### Requisito 10: Cronômetro de tempo decorrido ao vivo
**História de Usuário:** Como desenvolvedor, quero ver há quanto tempo cada tarefa está em execução, para que eu acompanhe a duração em tempo real sem oscilações na interface.
#### Critérios de Aceitação
1. WHEN uma tarefa passa ao estado em execução, THE TaskRuntimeService SHALL registrar o `startedAt` a partir do timestamp do registro de execução mais recente dos Metadados_Internos.
2. WHILE uma tarefa está em execução, THE SpecTreeProvider SHALL exibir o tempo decorrido atualizado a cada 1 segundo, usando o formato `Ns` para durações abaixo de 60 segundos, `Mm SSs` para durações de 60 segundos a menos de 60 minutos, e `Hh MMm` para durações de 60 minutos ou mais.
3. THE TaskRuntimeService SHALL manter um `startedAt` próprio e independente para cada tarefa em execução, sem um cronômetro global único.
4. WHEN uma tarefa deixa o estado em execução, THE TaskRuntimeService SHALL interromper imediatamente o cronômetro daquela tarefa e cessar a atualização do seu tempo decorrido.
5. THE TaskRuntimeService SHALL persistir o `startedAt` e o identificador de execução correspondente em workspaceState e SHALL reutilizar o `startedAt` persistido somente quando o identificador de execução atual for idêntico ao persistido.
6. IF o identificador de execução atual não corresponde ao identificador persistido, THEN THE TaskRuntimeService SHALL descartar o `startedAt` persistido, adotar o início detectado como novo `startedAt` e não exibir um tempo decorrido anterior enganoso.
7. THE TaskRuntimeService SHALL calcular o tempo decorrido como `Date.now()` menos o `startedAt`, sem reanalisar `tasks.md` a cada atualização do cronômetro.
8. WHILE uma tarefa está em execução, THE SpecTreeProvider SHALL atualizar o tempo decorrido por meio de atualização direcionada do elemento, sem executar uma atualização completa da TreeView, preservando o estado de expansão e a seleção do usuário.
9. THE TaskRuntimeService SHALL manter o intervalo de tick de 1 segundo ativo se e somente se houver pelo menos uma tarefa em execução.

### Requisito 11: Ordenação das Specs
**História de Usuário:** Como desenvolvedor, quero que as Specs mais relevantes apareçam primeiro, para que eu foque no que está em andamento.
#### Critérios de Aceitação
1. THE SpecAggregator SHALL ordenar as Specs em exatamente três grupos, nesta ordem de prioridade: (1) Specs com ao menos uma tarefa em execução, (2) Specs incompletas, (3) Specs completas.
2. THE SpecAggregator SHALL classificar como incompleta qualquer Spec que possua pelo menos uma tarefa contabilizada não concluída e, para o caso-limite, SHALL classificar como incompleta qualquer Spec com zero tarefas contabilizadas.
3. THE SpecAggregator SHALL classificar como completa qualquer Spec que possua ao menos uma tarefa contabilizada e cujas tarefas contabilizadas estejam todas concluídas.
4. THE SpecAggregator SHALL preservar, dentro de cada um dos três grupos, a ordem alfabética determinística fornecida pelo scanner como base estável, mantendo a ordem relativa original das Specs.

### Requisito 12: Comandos

**História de Usuário:** Como desenvolvedor, quero comandos acessíveis pela barra de ferramentas e pela paleta, para que eu controle a visão rapidamente.

#### Critérios de Aceitação

1. THE Extensao SHALL fornecer na barra de ferramentas da visão os comandos Refresh, Open tasks.md e Collapse All.
2. THE Extensao SHALL fornecer na Command Palette o comando "Kiro Spec Monitor: Refresh Specs".
3. THE Extensao SHALL fornecer o comando "Open Tasks File".
4. THE Extensao SHALL fornecer o comando "Reveal Task".
5. THE Extensao SHALL fornecer o comando "Collapse All".
6. THE Extensao SHALL fornecer o comando "Open Spec Folder".

### Requisito 13: Requisitos não funcionais e degradação graciosa

**História de Usuário:** Como mantenedor, quero que a extensão seja leve, segura e resiliente, para que ela funcione de forma confiável e não se apresente como software oficial.

#### Critérios de Aceitação

1. THE Extensao SHALL ser implementada em TypeScript usando a API de extensões do VS Code e npm.
2. THE Extensao SHALL evitar dependências de runtime externas desnecessárias.
3. THE Extensao SHALL evitar reanálise de `tasks.md` a cada segundo, mantendo baixo consumo de CPU.
4. THE Extensao SHALL não se apresentar como software oficial da Kiro ou da AWS, refletindo origem comunitária no nome e na descrição.
5. IF ocorre um erro de leitura ou de análise dos Metadados_Internos, THEN THE KiroMetadataStateProvider SHALL recorrer ao estado derivado apenas do checkbox sem travar a Extensao.
6. THE Extensao SHALL manter todo o código-fonte sob a pasta `kiro-spec-monitor/`.
7. THE Extensao SHALL tratar o TaskParser como o principal componente coberto por testes unitários.

### Requisito 14: Escopo da V1 e pontos de extensão (não objetivos)
**História de Usuário:** Como mantenedor, quero limites claros de escopo para a V1 com pontos de extensão preservados, para que recursos futuros não exijam reescrita da arquitetura.
#### Critérios de Aceitação
1. THE Extensao SHALL restringir a V1 ao monitoramento somente-leitura e SHALL não expor na interface nenhum controle de execução de tarefas (Run, Run All, Pause, Cancel, Retry).
2. THE Extensao SHALL não apresentar na interface histórico de duração de execução, estados de falha, retentativa, bloqueio, pausa ou pulada, dependências, logs, filtros, busca, agrupamento, barras gráficas de progresso ou seção de concluídas recentemente.
3. THE Extensao SHALL disponibilizar na arquitetura, para uso futuro, os três pontos de extensão: o TaskStateProvider plugável, o TaskRuntimeService e o campo rawExecutionStatus.

### Requisito 15: Localização da interface (idioma)
**História de Usuário:** Como usuário, quero que a interface da extensão apareça no mesmo idioma do meu editor, para que eu leia tudo no idioma que já uso.
#### Critérios de Aceitação
1. THE Extensao SHALL determinar o idioma da interface a partir do idioma do editor fornecido por `vscode.env.language`.
2. IF o idioma do editor é Português (qualquer variante com prefixo `pt`), THEN THE Extensao SHALL exibir todos os textos de interface (rótulos, descrições, tooltips, títulos de comandos e mensagens) em Português.
3. IF o idioma do editor é Inglês (qualquer variante com prefixo `en`), THEN THE Extensao SHALL exibir todos os textos de interface em Inglês.
4. IF o idioma do editor não é Português nem Inglês, THEN THE Extensao SHALL exibir todos os textos de interface em Inglês como idioma padrão.
5. THE Extensao SHALL fornecer textos de interface apenas em Português e Inglês, sem oferecer outros idiomas.
6. WHEN o idioma do editor é alterado e a janela do editor é recarregada, THE Extensao SHALL exibir os textos de interface no idioma atualizado.

---

## Observações sobre o parser (orientação do design)

O TaskParser é o componente central e primeiro alvo de testes. Por lidar com uma gramática textual propensa a erros, os requisitos acima incluem explicitamente o reconhecimento determinístico da estrutura (Requisito 2) e a propriedade de round-trip conceitual é validada pelas Correctness Properties do design (determinismo em `parse(m) ≡ parse(m)` e preservação de estrutura). A verificação de ida e volta formal recomendada no design é a geração aleatória de `tasks.md` bem formado e a reconstrução equivalente da árvore.

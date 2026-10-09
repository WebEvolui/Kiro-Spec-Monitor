<div align="center">

<img src="kiro-spec-monitor/media/icon.png" alt="Kiro Spec Monitor" width="120" />

# Kiro Spec Monitor

**Um monitor visual, em tempo real e _somente‑leitura_ das Kiro Specs e suas tarefas — direto na barra lateral do Kiro IDE / VS Code.**

[![License: MIT](https://img.shields.io/badge/License-MIT-1B3C8C.svg)](LICENSE)
[![VS Code](https://img.shields.io/badge/VS%20Code-%5E1.84.0-007ACC.svg?logo=visualstudiocode)](https://code.visualstudio.com/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.3-3178C6.svg?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Status](https://img.shields.io/badge/status-v0.0.1-brightgreen.svg)](#)

_Acompanhe o progresso das suas specs sem sair do editor._

</div>

---

> ⚠️ **Extensão comunitária e independente.** Não é um produto oficial da Kiro ou da AWS.

---

## ✨ O que é

O **Kiro Spec Monitor** adiciona um painel dedicado na _Activity Bar_ do seu editor que detecta automaticamente todas as **Kiro Specs** do seu workspace (`.kiro/specs/*/`) e mostra, em uma árvore navegável, cada tarefa e subtarefa com seu estado atual — concluída, em execução ou pendente — além do progresso de cada spec em tempo real.

Tudo isso **sem nunca escrever** no seu `tasks.md` nem na metadata interna do Kiro. É um observador puro: sem rede, sem telemetria, sem efeitos colaterais.

---

## 📸 Capturas de tela

<div align="center">

### O ícone na Activity Bar

Um painel dedicado "Kiro Spec Monitor" fica a um clique de distância, no mesmo lugar de sempre.

<img src="docs/images/screenshot-activitybar.jpeg" alt="Ícone do Kiro Spec Monitor na Activity Bar com o painel aberto" width="300" />

### Visão geral das specs e tarefas

A spec `exemplo-saudacao` recém‑criada, com suas 5 tarefas pendentes e o progresso `0% • 0/5` ao lado do nome.

<img src="docs/images/screenshot-specs.jpeg" alt="Painel do Kiro Spec Monitor mostrando a spec exemplo-saudacao com 5 tarefas pendentes" width="520" />

### Estados em tempo real + navegação para o `tasks.md`

O painel (à esquerda) reflete o estado de cada tarefa lido direto do `tasks.md` (à direita): **concluída** (`[x]`), **em execução** (`[-]`) e **na fila** (`[~]`). Clicar numa tarefa abre o arquivo exatamente na linha dela.

<img src="docs/images/screenshot-tasks.jpeg" alt="Kiro Spec Monitor ao lado do tasks.md mostrando tarefas concluída, em execução e na fila" width="820" />

</div>

---

## 🚀 Recursos

| | Recurso |
|---|---|
| 🗂️ | **Barra lateral dedicada** "Kiro Spec Monitor" na Activity Bar |
| 🔍 | **Detecção automática** de Specs em `.kiro/specs/*/` |
| 🌳 | **Árvore de tarefas e subtarefas** com estados: ✅ concluída, ⏳ em execução, ⬜ pendente |
| 📊 | **Progresso por Spec** (contagem `X/Y` e percentual), contando apenas tarefas‑folha |
| 🎯 | **Clique para navegar** — abre o `tasks.md` exatamente na linha da tarefa |
| ⚡ | **Atualização automática** ao editar/concluir tarefas ou criar/remover Specs |
| ⏱️ | **Cronômetro ao vivo** da tarefa em execução (quando há fonte confiável na metadata do Kiro) |
| 🌐 | **Interface em Português e Inglês**, seguindo o idioma do editor |

---

## 📦 Instalação

### A partir do `.vsix` (empacotado neste repositório)

```bash
code --install-extension kiro-spec-monitor/kiro-spec-monitor-0.0.1.vsix
```

> No Kiro IDE, use o mesmo comando substituindo `code` pelo binário do Kiro, ou instale pela paleta de comandos → **Extensions: Install from VSIX...**

### A partir do código‑fonte

```bash
cd kiro-spec-monitor
npm install
npm run compile      # gera ./out
npm run package      # gera o .vsix com @vscode/vsce
```

---

## 🧭 Como usar

1. Abra um projeto que contenha a pasta `.kiro/specs/`.
2. Clique no ícone **Kiro Spec Monitor** (checklist) na Activity Bar.
3. Expanda uma Spec para ver suas tarefas.
4. Clique em uma tarefa para pular direto até ela no `tasks.md`.

A árvore se atualiza sozinha conforme você conclui tarefas ou cria novas specs.

---

## 💡 Exemplo prático

Dado um `tasks.md` como o da spec `exemplo-saudacao`:

```markdown
# Plano de implementação

- [x] 1. Criar a estrutura base do GreetingService
  - Definir a função `saudar(nome, idioma)` com a assinatura e o idioma padrão
  - _Requisitos: 1.1, 2.4_

- [-] 2. Implementar a normalização do nome
  - Remover espaços nas extremidades do nome
  - Tratar nome vazio devolvendo a saudação genérica
  - _Requisitos: 1.2, 1.3_

- [~] 3. Implementar o mapa de idiomas e a resolução do prefixo
  - Adicionar os prefixos pt/en/es
  - Aplicar o fallback para português em idioma desconhecido
  - _Requisitos: 2.1, 2.2, 2.3, 2.4_
```

A extensão interpreta cada marcador e mostra o estado correspondente na árvore:

| Marcador no `tasks.md` | Estado exibido |
|---|---|
| `- [x]` | ✅ **Concluída** |
| `- [-]` | ⏳ **Em execução** |
| `- [~]` | 🕗 **Na fila** |
| `- [ ]` | ⬜ **Pendente** |

O progresso ao lado do nome da spec (`X/Y` e `%`) conta **apenas as tarefas‑folha**, então subtarefas detalhadas não inflam o total.

---

## 🎛️ Comandos

Disponíveis na paleta de comandos (`Ctrl/Cmd + Shift + P`) e nos botões do título do painel:

| Comando | Descrição |
|---|---|
| `Kiro Spec Monitor: Refresh Specs` | Recarrega todas as specs manualmente |
| `Open Tasks File` | Abre o `tasks.md` da spec selecionada |
| `Reveal Task` | Revela uma tarefa específica na linha correta |
| `Collapse All` | Recolhe toda a árvore |
| `Open Spec Folder` | Abre a pasta da spec no explorador |

---

## 🏗️ Como funciona (arquitetura)

A extensão monta um pipeline de dados unidirecional e totalmente somente‑leitura:

```
resolver → stateProvider → runtime → aggregator → treeProvider → view
                                          ▲
                                       watcher  (eventos de arquivo / metadata)
```

| Componente | Responsabilidade |
|---|---|
| **`WorkspaceIdResolver`** | Resolve o `workspaceId` opaco do Kiro (quando existe) para escolher a fonte de estado |
| **`taskStateProvider`** | Escolhe entre o provider de metadata do Kiro ou o _fallback_ por checkbox; lê nomes de specs e `~/.kiro/spec-sessions` |
| **`TaskRuntimeService`** | Núcleo do cronômetro: controla o tempo decorrido por tarefa e um único `tick` de 1 s |
| **`SpecScanner` + `TaskParser`** | Faz _glob_ das specs e lê o texto do `tasks.md` |
| **`SpecAggregator`** | Compõe scanner + parser + estado + runtime em uma lista ordenada de `Spec[]` |
| **`SpecTreeProvider`** | Renderiza a árvore na view e repinta apenas as linhas em execução a cada tick |
| **`SpecWatcher`** | Observa `tasks.md` e os diretórios de metadata do Kiro, com _debounce_, disparando o refresh |

### 🔒 Garantia somente‑leitura

A única persistência que a extensão faz é no seu próprio `context.workspaceState` (o `startedAt`/`executionId` do cronômetro). **Nenhum** caminho de código escreve no `tasks.md` do workspace ou em qualquer coisa sob `~/.kiro`. Esses caminhos são abertos, parseados e observados estritamente em modo leitura.

---

## 🛠️ Desenvolvimento

```bash
cd kiro-spec-monitor
npm install
npm run watch        # compilação incremental em modo watch
npm test             # roda os testes com vitest
npm run lint         # checagem de tipos (tsc --noEmit)
```

| Script | O que faz |
|---|---|
| `npm run compile` | Compila TypeScript para `./out` |
| `npm run watch` | Compilação incremental |
| `npm test` | Testes com Vitest |
| `npm run lint` | Checagem de tipos sem emitir arquivos |
| `npm run package` | Empacota o `.vsix` |
| `npm run publish` | Publica no Marketplace via `vsce` |

### Estrutura do projeto

```
kiro-spec-monitor/
├── src/
│   ├── extension.ts          # ponto de entrada: monta e descarta o pipeline
│   ├── i18n.ts               # strings localizadas (pt/en)
│   ├── commands/             # handlers dos 5 comandos
│   ├── models/               # Spec e Task
│   ├── providers/            # SpecTreeProvider (a view em árvore)
│   └── services/             # scanner, parser, aggregator, watcher, runtime, state
├── l10n/                     # bundles de localização
├── media/                    # ícones
└── package.json
```

---

## 🔐 Privacidade

Sem rede. Sem telemetria. Somente‑leitura fora do próprio `workspaceState`.

---

## 📄 Licença

Distribuído sob a licença **MIT**. Veja [LICENSE](LICENSE) para mais detalhes.

---

<div align="center">

Feito com ☕ para a comunidade Kiro.

</div>

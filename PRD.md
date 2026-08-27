# PRD — Plataforma Modular para RPGs de Mesa

**Status:** Draft
**Versão:** 0.3
**Plataforma inicial:** Web/PWA
**Plataformas futuras:** Mobile/Desktop
**Stack principal:** TypeScript
**Codinome provisório:** RPG Companion

> Este documento permanece como visão do produto.
> A decomposição executável em PRDs por feature está em `.speckit/features/_index.md`.

---

# 1. Visão do Produto

Criar uma plataforma modular para **criação, preparação, gerenciamento e execução de campanhas de RPG de mesa**, capaz de suportar múltiplos sistemas de regras sem acoplar o Core da aplicação a qualquer sistema específico.

A aplicação deve permitir:

```text
Add RPG
   ↓
Choose System
   ↓
Choose Game Mode
   ↓
Choose Optional Rules / Modules
   ↓
Create Campaign
   ↓
Prepare World
   ↓
Invite Players
   ↓
Play
   ↓
Track
   ↓
Evolve Campaign
```

O produto não será inicialmente um VTT completo.

Seu foco é:

> **Campaign, Rules & Session Operating System para RPGs de mesa.**

---

# 2. Problema

Mestres normalmente distribuem uma campanha entre:

- livros e PDFs;
- fichas;
- Notion;
- Obsidian;
- Google Drive;
- Discord;
- planilhas;
- dice rollers;
- trackers de iniciativa;
- documentos de NPCs;
- mapas;
- anotações físicas.

Além disso, cada sistema possui uma estrutura mecânica diferente.

Exemplo:

```text
Cairn 2e
STR
DEX
WIL
HP
Fatigue
Scars
Inventory
```

Enquanto Fate utiliza:

```text
Aspects
Skills
Stress
Consequences
Fate Points
```

E um sistema d20 pode utilizar:

```text
STR / DEX / CON / INT / WIS / CHA
HP
AC
Skills
Saving Throws
Classes
Levels
Spells
```

A aplicação precisa representar todos esses modelos sem possuir código específico espalhado pelo Core.

---

# 3. Hipótese Principal

Se um sistema de RPG puder ser representado como:

```text
Schema
+
Resources
+
Actions
+
Rules
+
Effects
+
Compendiums
+
Capabilities
```

então sistemas mecanicamente muito diferentes poderão utilizar a mesma plataforma.

O MVP deve validar essa hipótese com:

```text
Cairn 2e
+
Fate Core
```

---

# 4. Princípio Arquitetural Fundamental

> **The Core does not know how to play RPGs. Systems do.**

O Core entende conceitos genéricos:

```text
Entity
Field
Resource
Action
Roll
Effect
Rule
Event
Relationship
Permission
Visibility
Session
Attachment
Document
```

Cairn entende:

```text
STR
DEX
WIL
HP
Critical Damage
Fatigue
Scars
```

Fate entende:

```text
Aspects
Skills
Stress
Consequences
Fate Points
```

Não deve existir lógica semelhante a:

```text
if system == cairn
if system == fate
if system == dnd
```

nas páginas e serviços genéricos.

---

# 5. Princípios do Produto

## 5.1 System Agnostic

O Core fornece infraestrutura.

O System Package fornece regras.

---

## 5.2 Schema Driven

Fichas, recursos, ações, configurações e manifests devem ser declarativos.

---

## 5.3 Local First

Dados necessários durante a sessão devem estar disponíveis localmente.

Perda de conexão não pode interromper uma mesa em andamento.

---

## 5.4 GM First

O mestre é o principal usuário.

Fluxos durante sessão devem exigir o mínimo possível de navegação.

---

## 5.5 Fiction First Friendly

A plataforma deve auxiliar sistemas narrativos e rules-light sem forçar paradigmas de VTT ou combate tático.

---

## 5.6 Extensible

Systems, Modules e Campaign Packages devem ser conceitos independentes.

---

# 6. Usuários

## Game Master

Pode:

- criar campanhas;
- selecionar sistema;
- preparar sessões;
- criar NPCs;
- gerenciar locais;
- consultar regras;
- controlar encontros;
- revelar informações;
- gerenciar pistas;
- acompanhar clocks;
- anexar material;
- registrar eventos.

## Player

Pode:

- acessar ficha;
- consultar regras permitidas;
- manipular recursos autorizados;
- visualizar handouts;
- registrar notas;
- acompanhar informações descobertas;
- realizar ações e rolagens.

## System Author

Futuramente poderá:

- criar System Packages;
- definir schemas;
- definir actions;
- distribuir compêndios.

## Content Author

Futuramente poderá produzir:

- campanhas;
- aventuras;
- bestiários;
- módulos;
- tabelas;
- compêndios.

---

# 7. Criação de RPG

Fluxo:

```text
Add RPG

1. Choose System
2. Choose Game Mode
3. Configure System
4. Choose Modules
5. Campaign Details
6. Party
7. Review
8. Create
```

---

# 8. Seleção de Sistema

Exemplo:

```text
Choose a System

Search...

┌────────────────────────────┐
│ Cairn 2e                   │
│ Rules-light fantasy        │
│                            │
│ Documentation: Integrated  │
│ Complexity: Low            │
│                            │
│ [ Rules ]      [ Select ]  │
└────────────────────────────┘

┌────────────────────────────┐
│ Fate Core                  │
│ Narrative RPG              │
│                            │
│ Documentation: Integrated  │
│ Complexity: Medium         │
│                            │
│ [ Rules ]      [ Select ]  │
└────────────────────────────┘
```

Filtros futuros:

- gênero;
- complexidade;
- foco narrativo;
- foco tático;
- letalidade;
- dados utilizados;
- solo;
- GM-less;
- documentação integrada;
- idioma.

---

# 9. Status de Integração de Sistema

Um sistema pode ter níveis diferentes de suporte.

```text
Mechanics Supported
Character Sheet Supported
Rules Integrated
Compendium Integrated
External Documentation
```

Exemplo:

```text
System X

Mechanics       ✓
Character Sheet ✓
Rules Text      ✗
External Docs   ✓
```

Suporte mecânico não implica direito de redistribuir documentação.

---

# 10. Sistemas Planejados

## P0 — MVP

### Cairn 2e

Caso de validação rules-light.

Necessidades:

- STR;
- DEX;
- WIL;
- HP;
- Armor;
- inventory slots;
- Fatigue;
- Scars;
- Saves;
- Critical Damage;
- Spellbooks.

### Fate Core

Caso de validação narrativo.

Necessidades:

- Aspects;
- Skills;
- Fate Points;
- Stress;
- Consequences;
- Overcome;
- Create Advantage;
- Attack;
- Defend.

Cairn e Fate devem utilizar o mesmo Core sem condicionais específicas nas interfaces genéricas.

---

# 11. Sistemas P1

Após validação do MVP:

```text
Mausritter
Fate Accelerated
Fate Condensed
D&D 5e SRD 5.1
D&D 5e SRD 5.2.x
```

Eles acrescentam:

- variantes de uma mesma família;
- d20 tradicional;
- classes;
- níveis;
- spells;
- condições;
- inventário baseado em slots.

---

# 12. Sistemas P2

```text
MÖRK BORG
Pathfinder 2e compatible rules package
Year Zero Engine
Dragonbane
```

Objetivos técnicos:

### MÖRK BORG

Validar:

```text
Apocalypse clocks
Omens
Armor dice
DR checks
```

### Pathfinder 2e

Validar:

```text
Three-action economy
Traits
Degrees of success
Feats
Complex conditions
```

### Year Zero Engine

Validar:

```text
Dice pools
Success counting
Push mechanics
Resource dice
```

---

# 13. Sistemas P3 / Research

```text
Forbidden Lands
Symbaroum
Old-school systems
Generic d20
Generic dice pool
Systemless
```

Inclusão de documentação, nomes, assets e compêndios dependerá de análise individual da licença e da versão específica do conteúdo.

---

# 14. License Manifest

Cada System Package deve declarar metadados de origem e licença.

```text
License
Source
Version
Attribution
Redistribution status
Translation status
Brand usage status
```

Exemplo conceitual:

```text
rulesText: allowed
mechanics: allowed
officialArtwork: forbidden
officialLogo: forbidden
translation: review-required
```

O manifest é uma proteção técnica, não substitui revisão jurídica.

---

# 15. System Package

Contrato conceitual:

```text
GameSystem

manifest
capabilities
characterSchema
resources
actions
mechanics
rules
compendiums
options
gameModes
```

System Packages do MVP devem ser declarativos.

Nenhum pacote comunitário executará JavaScript arbitrário.

---

# 16. Schema Validation

Todos os schemas devem passar por validação estrita.

Tecnologia padrão:

```text
TypeBox
+
JSON Schema
+
Fastify validation
```

Aplicável a:

- HTTP requests;
- responses;
- System manifests;
- Module manifests;
- character schemas;
- action definitions;
- effect definitions;
- campaign imports;
- package manifests.

Dados inválidos nunca devem entrar silenciosamente no domínio.

---

# 17. Character Schema

Exemplo conceitual:

```text
CharacterSchema

fields:
  ATTRIBUTE_A:
    type: number
    min: 1
    max: 20

  RESOURCE_A:
    type: resource
```

O frontend recebe o schema e gera a ficha.

---

# 18. Sheet Engine

Componentes suportados:

```text
Text
Number
Boolean
Counter
Resource Bar
Select
Multi-select
List
Repeater
Inventory
Condition
Rich Text
Reference
Computed Field
Dice
```

O Sheet Engine não conhece sistemas específicos.

---

# 19. Resource Engine

Recursos representam valores consumíveis ou mutáveis.

Exemplos:

```text
Health
Stress
Energy
Luck
Ammo
Corruption
Special Points
```

Um recurso pode possuir:

```text
current
min
max
temporary
recoveryRules
visibility
```

---

# 20. Dice Engine

Suporte inicial:

```text
d4
d6
d8
d10
d12
d20
d100
dF
```

Expressões:

```text
1d20
2d6+3
4d6kh3
1d20+ATTRIBUTE_A
4dF
6d6 success>=6
```

O parser de dados deve ser independente do Formula Engine.

---

# 21. Roll Context

Toda rolagem pode possuir:

```text
Actor
Target
Action
Expression
Visibility
Natural Result
Modified Result
Timestamp
Session
```

Visibilidade:

```text
Public
GM Only
Player Only
Blind
Whisper
```

---

# 22. Action Engine

Um sistema registra ações declarativas.

Exemplo genérico:

```text
Attribute Check

Roll:
1d20

Success:
roll <= actor.ATTRIBUTE_A
```

Outro paradigma:

```text
Narrative Action

Roll:
4dF + selectedSkill
```

---

# 23. Effect Engine

Efeitos suportados:

```text
Modify Field
Apply Damage
Heal
Add Condition
Remove Condition
Spend Resource
Gain Resource
Move Inventory Item
Advance Clock
Trigger Event
Reveal Knowledge
Execute Roll
```

---

# 24. Formula Engine

Fórmulas devem utilizar uma linguagem própria e restrita.

Permitido:

```text
10 + ATTRIBUTE_A
level * 2
min(armor, 3)
ATTRIBUTE_A > 10
RESOURCE_A <= 0
```

Não permitido:

```text
JavaScript
eval()
Function()
filesystem
network
timers
process
global objects
dynamic imports
```

Implementação:

```text
Formula Source
     ↓
Parser
     ↓
AST
     ↓
Validator
     ↓
Restricted Interpreter
     ↓
Result
```

Devem existir limites de:

- profundidade;
- quantidade de operações;
- tamanho;
- funções permitidas;
- tipos aceitos.

O resultado deve ser determinístico.

QuickJS/WASM não será utilizado para fórmulas no MVP.

---

# 25. Executable Plugins — Futuro

Plugins executáveis são conceito separado de System Packages declarativos.

Caso sejam introduzidos:

```text
Signed Package
     ↓
Permission Manifest
     ↓
Isolated Runtime
     ↓
Resource Limits
```

QuickJS/WASM poderá ser avaliado para esse cenário.

Pacotes comunitários não terão execução arbitrária por padrão.

---

# 26. Rules Library

Cada sistema pode fornecer documentação estruturada.

```text
Rules
├── Introduction
├── Character Creation
├── Core Mechanics
├── Combat
├── Damage
├── Healing
├── Magic
├── Equipment
└── GM Procedures
```

Funcionalidades:

- busca textual;
- bookmarks;
- referências cruzadas;
- quick rules;
- histórico;
- favoritos.

---

# 27. Contextual Rules

A aplicação pode sugerir regras a partir do estado.

Exemplo:

```text
A defensive resource reached 0.
The character received direct attribute damage.

A resistance check is required.

[ Roll ]
[ View Rule ]
```

Outro sistema pode apresentar:

```text
Action succeeded by 3 shifts.

[ Apply Stress ]
[ Apply Consequence ]
[ Concede ]

[ View Rule ]
```

A aplicação auxilia.

Ela não deve assumir controle narrativo da mesa.

---

# 28. Campaign

Estrutura:

```text
Campaign
│
├── System
├── System Version
├── Modules
├── Party
├── Sessions
├── Content
├── Documents
└── Settings
```

---

# 29. Campaign Content

Tipos padrão:

```text
Characters
NPCs
Creatures
Locations
Items
Factions
Quests
Clues
Secrets
Scenes
Encounters
Events
Clocks
Notes
Documents
Relationships
```

---

# 30. Entity System

Entidades compartilham capacidades:

```text
ID
Name
Tags
Metadata
Notes
Attachments
Relationships
Visibility
Custom Fields
Timeline
Audit Information
```

---

# 31. Attachments

Tipos:

```text
Image
Audio
Video
PDF
Markdown
Text
Map
External Link
Handout
```

Arquivos binários não devem ser armazenados no banco relacional.

---

# 32. Object Storage

Arquitetura:

```text
PostgreSQL
    ↓
Attachment Metadata

S3-compatible Storage
    ↓
PDF
Image
Audio
Video
Large Files
```

Implementação local padrão:

```text
MinIO
```

A aplicação deve depender de uma abstração:

```text
ObjectStorage
```

e não de MinIO diretamente.

Possíveis providers:

```text
MinIO
AWS S3
Cloudflare R2
Other S3-compatible storage
```

---

# 33. Attachment Upload

Upload deve utilizar:

```text
Client
  ↓
Request upload permission
  ↓
Signed upload URL
  ↓
Object Storage
  ↓
Finalize metadata
```

Requisitos:

- tamanho máximo;
- MIME validation;
- autorização;
- ownership;
- checksum;
- status de upload.

Conteúdo não confiável não deve ser renderizado como HTML executável.

---

# 34. Visibility

Todo conteúdo pode possuir:

```text
GM Only
Everyone
Specific Party
Specific Players
```

A regra deve ser aplicada no backend e na camada de sync.

Nunca apenas na interface.

---

# 35. Handouts

Exemplo:

```text
Weathered Letter

Status:
Hidden

[ Preview ]
[ Reveal ]
```

Após reveal:

```text
Visible:
Player A
Player B
Player C
```

---

# 36. Knowledge Graph

Relacionamentos podem formar um grafo.

```text
NPC A
   │
   ├── member_of → Faction A
   ├── lives_at → Location A
   └── knows → Secret A
```

---

# 37. Knowledge Visibility

Uma verdade do mundo não implica conhecimento do jogador.

```text
NPC A belongs to Faction A

GM       ✓
Player A ✓
Player B ✗
```

Ao revelar:

```text
Reveal Relationship
```

o grafo daquele jogador passa a exibir a conexão.

---

# 38. Clue System

Exemplo:

```text
CLUE

Someone inside the guild is working with the smugglers.

Sources:

□ Merchant's Ledger
□ Captured Smuggler
□ Warehouse Records
□ Guild Member
```

Se uma fonte for perdida:

```text
☒ Captured Smuggler — unavailable
□ Merchant's Ledger
□ Warehouse Records
□ Guild Member
```

O sistema pode avisar:

```text
Critical clue has only two remaining sources.
```

---

# 39. Secrets

Exemplo:

```text
SECRET

NPC A is secretly working for Faction B.

Visibility:
GM Only
```

Pode posteriormente virar Knowledge.

---

# 40. Campaign Clocks

Exemplo:

```text
ENEMY PLAN

● ● ● ● ○ ○
4 / 6
```

Eventos associados:

```text
1 Scouts arrive
2 Supplies disappear
3 Enemy agents infiltrate the settlement
4 A key NPC goes missing
5 Defenses are sabotaged
6 The enemy executes the plan
```

---

# 41. Events

Evento representa mudança significativa no mundo.

Exemplo:

```text
Enemy Agent Exposed

Effects:

NPC → Revealed
Clue → Available
Timeline → Add Entry
Enemy Plan → -1
```

O mestre sempre pode disparar ou cancelar manualmente.

---

# 42. Timeline

Exemplo:

```text
DAY 1

08:00 Party arrives at settlement
10:15 Merchant reports missing cargo
13:40 Warehouse investigated
17:20 Suspect identified

DAY 2

09:30 Party follows smugglers
12:10 Hidden camp discovered
15:00 Enemy agent confronted
```

Pode ser alimentada automaticamente por eventos e manualmente pelo GM.

---

# 43. Session

Campaign e Session são entidades diferentes.

```text
Campaign
├── Session 1
├── Session 2
├── Session 3
└── Session 4
```

Uma Session registra:

```text
participants
start/end
current scene
rolls
events
encounters
notes
reveals
resource changes
```

---

# 44. Session Mode

Interface focada no GM.

```text
┌─────────────────────────────────────────────────┐
│ SESSION 03                   CLOCK ████░░       │
├───────────────┬─────────────────────────────────┤
│ PARTY         │ CURRENT SCENE                   │
│               │                                 │
│ Character A   │ Old Warehouse                  │
│ HP 4/6        │ Lower District                 │
│               │                                 │
│ Character B   │ NPCs                           │
│ HP 7/7        │ Merchant                       │
│               │ Smuggler                       │
├───────────────┼─────────────────────────────────┤
│ QUICK         │ GM NOTES                       │
│               │                                 │
│ + NPC         │ Crates hide a second entrance. │
│ + Encounter   │                                 │
│ + Clock       │                                 │
│ + Note        │                                 │
│ + Reveal      │                                 │
└───────────────┴─────────────────────────────────┘
```

---

# 45. Command Palette

Atalho:

```text
Ctrl + K
```

Exemplos:

```text
> Merchant
> roll attribute
> critical damage
> enemy plan
> create NPC
> reveal handout
> add condition
> rules healing
```

Objetivo:

> Executar operações comuns sem abandonar a tela da sessão.

---

# 46. Encounter Engine

Um encontro representa:

```text
Participants
Environment
Conditions
System State
Notes
```

Exemplo:

```text
Encounter

Players
├── Character A
└── Character B

Enemies
├── Bandit A
├── Bandit B
└── Guard Dog

Environment
├── Old Warehouse
└── Poor Lighting
```

---

# 47. Combat Tracker

O tracker adapta-se ao sistema.

Sistema baseado em recursos:

```text
Character A
HP 4
Attribute 12
Armor 1
```

Sistema narrativo:

```text
Character B
Stress
Consequences
Special Points
```

Sistema d20:

```text
Character C
HP 32
Defense 18
Conditions
```

---

# 48. Hidden Mechanics

Modules podem interceptar ações sem depender de uma narrativa específica.

Exemplo:

```text
Natural Roll
3

↓ Hidden Intervention

Narrative Result
Success
```

GM vê:

```text
Hidden Intervention

Original result:
Failure

Result:
Success

Reason:
Campaign-specific hidden effect
```

Jogadores não recebem indicação automática.

A origem e a justificativa da intervenção são definidas pela campanha ou módulo.

---

# 49. Game Modes

Conceito extensível.

Inicialmente:

```text
GM + Players
GM Companion
Solo
Theatre of the Mind
```

Futuramente:

```text
GM-less
Hexcrawl
West Marches
Custom
```

Systems e Modules declaram compatibilidade.

---

# 50. Modules

Exemplos:

```text
Clocks
Corruption
Sanity
Injuries
Downtime
Faction Turns
Weather
Travel
Hexcrawl
Prophecies
Hidden Interventions
Knowledge Graph
```

---

# 51. Module Manifest

Module deve declarar:

```text
ID
Version
Capabilities required
Systems supported
Dependencies
License
```

Exemplo:

```text
Corruption

requires:
resource
condition
```

---

# 52. Offline-First Architecture

Arquitetura lógica:

```text
React PWA
    ↓
Local SQLite
    ↓
PowerSync
    ↓
PostgreSQL
```

A aplicação trabalha prioritariamente com o banco local.

Leitura e escrita do usuário não devem depender de round trip ao servidor.

---

# 53. Local Database

No navegador:

```text
SQLite/WASM
```

Persistência preferencial:

```text
OPFS
```

Fallback compatível quando necessário:

```text
IndexedDB-backed VFS
```

A campanha previamente sincronizada deve permanecer acessível sem rede.

---

# 54. PostgreSQL

PostgreSQL passa a ser a persistência relacional compartilhada desde o início da arquitetura sincronizada.

Responsabilidades:

- usuários;
- campanhas;
- entidades;
- sessões;
- permissões;
- regras instaladas;
- metadata;
- audit log;
- clocks;
- eventos.

Não armazenar:

- PDFs;
- imagens grandes;
- áudio;
- vídeo.

---

# 55. Sync Layer

Tecnologia inicial:

```text
PowerSync
```

Responsabilidades:

```text
Postgres → local SQLite
local SQLite writes → upload queue
reconnect
incremental synchronization
offline reads
offline writes
```

O domínio não deve depender diretamente das APIs do provider.

Criar boundary:

```text
SyncService
```

Isso permite substituir a tecnologia futuramente.

---

# 56. Realtime

Há dois tipos distintos de realtime.

## Persistent Realtime

Exemplo:

```text
Character resource changed
NPC updated
Handout revealed
Clock advanced
```

Deve fluir pela camada de sync.

## Ephemeral Realtime

Exemplo:

```text
Player joined
Player cursor
Typing state
Dice animation
Temporary ping
Presence
```

Será tratado por:

```text
@fastify/websocket
```

Não deve ser persistido desnecessariamente.

---

# 57. Conflict Resolution

Não haverá uma única estratégia para todos os dados.

## Collaborative Text

Usar:

```text
Yjs CRDT
```

Aplicável a:

- campaign notes;
- session notes;
- collaborative journal;
- editable handouts;
- long-form text.

## Structured Entities

Utilizar:

```text
optimistic concurrency
+
version field
+
explicit conflict resolution
```

Exemplo:

```text
NPC.version = 12
```

Update baseado na versão 11 deve gerar conflito, não sobrescrever silenciosamente.

## Counters and Resources

Operações devem ser semânticas:

```text
damage(-3)
heal(+2)
advanceClock(+1)
spendResource(-1)
```

em vez de simplesmente:

```text
set resource = 4
```

quando apropriado.

Isso melhora merge, auditabilidade e idempotência.

## Deletes

Deletes sincronizados devem utilizar tombstones/soft-delete quando necessário.

Nunca depender apenas de last-write-wins.

---

# 58. Document Storage

Documento colaborativo:

```text
Document Metadata
      ↓
PostgreSQL

Yjs Updates / Snapshots
      ↓
Document Persistence
```

Attachments permanecem no Object Storage.

Yjs não será utilizado para todo o modelo de domínio.

---

# 59. Authentication

Boundary explícito:

```text
Auth
```

Responsabilidades:

- identidade;
- sessão;
- login;
- account recovery;
- invitation tokens;
- player membership;
- role resolution.

Modelo deve permitir autenticação externa no futuro.

---

# 60. Authorization

Papéis:

```text
Owner
GM
Assistant GM
Player
Observer
```

Autorização deve ocorrer server-side.

Sync rules também devem respeitar permissions.

---

# 61. Storage Boundary

Criar abstração:

```text
Storage
```

Subdividida em:

```text
RelationalStorage
ObjectStorage
DocumentStorage
LocalStorage
```

O domínio não conhece S3, MinIO ou OPFS diretamente.

---

# 62. Domain Boundaries

```text
Auth
Campaign
System
Rules
Character
Content
Session
Knowledge
Storage
Sync
Permissions
Files
Marketplace
```

Marketplace existe apenas como boundary futuro.

Arquitetura inicial:

> **Modular Monolith**

---

# 63. Stack

## Runtime / Package Manager

```text
Bun
```

## Language

```text
TypeScript
```

## Web

```text
React
Vite
PWA
```

## API

```text
Fastify
```

## Validation

```text
TypeBox
JSON Schema
```

## Shared Database

```text
PostgreSQL
```

## Local Database

```text
SQLite/WASM
```

## Sync

```text
PowerSync
```

## Collaborative Documents

```text
Yjs
```

## Object Storage

```text
S3-compatible API
```

Local development:

```text
MinIO
```

## Ephemeral Realtime

```text
@fastify/websocket
```

---

# 64. Monorepo

```text
apps/
├── web/
└── api/

packages/
├── domain/
├── system-sdk/
├── schema/
├── rule-engine/
├── dice-engine/
├── formula-engine/
├── sheet-engine/
├── session-engine/
├── knowledge/
├── storage/
├── sync/
├── realtime/
├── permissions/
├── ui/
└── config/

systems/
├── cairn/
└── fate-core/

modules/
├── clocks/
└── hidden-intervention/
```

Futuro:

```text
apps/mobile/
systems/mausritter/
systems/fate-accelerated/
systems/srd-5e/
...
```

---

# 65. Import / Export

Formato conceitual:

```text
.rpgpack
```

Conteúdo:

```text
manifest.json
campaign.json
entities/
documents/
attachments-manifest/
system.lock
modules.lock
```

Objetivos:

- backup;
- compartilhamento;
- migração;
- portabilidade;
- preservação.

---

# 66. System Versioning

Campanha fixa a versão.

```text
system-id@version
```

Atualização de sistema nunca deve ocorrer automaticamente.

Fluxo:

```text
New version available

[ Review Changes ]
[ Update ]
[ Keep Current ]
```

---

# 67. Audit Log

Mudanças importantes devem produzir eventos auditáveis.

Exemplo:

```text
14:32
GM advanced Enemy Plan
3 → 4

14:35
Player A
Health 6 → 2

14:40
GM revealed Weathered Letter
to Player A, Player B
```

Hidden GM actions podem possuir log separado e privado.

---

# 68. MVP — Escopo Revisado

O MVP não possuirá Custom System Builder.

Sistemas:

```text
Cairn 2e
Fate Core
```

Features obrigatórias:

- autenticação;
- criar campanha;
- selecionar sistema;
- System Package;
- TypeBox validation;
- Rules Library;
- Character Sheet dinâmica;
- personagens;
- NPCs;
- locations;
- notes;
- attachments;
- S3-compatible storage;
- dice engine;
- basic action engine;
- basic effect engine;
- Session Mode;
- encounter tracker;
- search;
- offline access;
- local SQLite;
- PowerSync;
- import/export básico.

---

# 69. MVP — Player Scope

O MVP deve permitir participação simples do jogador:

```text
Join Campaign
View Character
Edit authorized fields
Roll Dice
View Revealed Handouts
View Allowed Rules
```

Funcionalidades colaborativas avançadas ficam fora.

---

# 70. Fora do MVP

Não implementar inicialmente:

```text
Custom System Builder
Module Builder
Marketplace
Public System SDK
Grid Tactical
Token Movement
Dynamic Lighting
3D Maps
Voice Chat
Video Chat
AI GM
Procedural Campaign Generation
Executable Community Plugins
Advanced Knowledge Graph UI
Full Hexcrawl Engine
Native Mobile App
```

---

# 71. V1

Adicionar:

```text
Mausritter
Fate Accelerated
Fate Condensed
D&D SRD
```

Features:

- Clues;
- Secrets;
- advanced Clocks;
- Events;
- Timeline;
- contextual rules;
- richer Player Companion;
- collaborative Yjs notes;
- presence;
- handout realtime reveal;
- Knowledge Graph.

---

# 72. V2

Adicionar:

```text
MÖRK BORG
Pathfinder-compatible rules package
Year Zero Engine
Dragonbane
```

Features:

- Module Engine;
- advanced permissions;
- faction management;
- hexcrawl;
- travel;
- campaign templates;
- advanced sheet layouts.

---

# 73. V3

Adicionar:

```text
Custom System Builder
Module Builder
Public System SDK
Community Packages
Marketplace
Native Mobile Client
Package Signing
Trusted Plugins
```

---

# 74. Custom System Builder

Retirado do MVP, mas permanece na visão de longo prazo.

Fluxo futuro:

```text
Create System

1. Metadata
2. Dice
3. Character Schema
4. Resources
5. Actions
6. Conditions
7. Rules
8. Compendiums
9. Optional Rules
10. Publish
```

Deve utilizar as mesmas primitivas que os sistemas oficiais suportados.

---

# 75. Security Requirements

Obrigatórios:

```text
No eval()
No arbitrary package execution
Strict schema validation
Server-side authorization
Sync permission enforcement
Signed upload URLs
File size limits
MIME validation
Formula execution limits
Dependency scanning
Audit logging
```

System Packages declarativos devem ser tratados como entrada não confiável.

---

# 76. Offline Requirements

Durante ausência total de rede, o usuário deve conseguir:

- abrir campanha previamente sincronizada;
- visualizar fichas;
- alterar ficha;
- criar notas;
- executar rolagens;
- consultar regras cacheadas;
- iniciar encontro;
- alterar recursos;
- executar ações;
- visualizar attachments previamente disponibilizados offline;
- continuar uma sessão.

Operações devem sincronizar após reconexão.

---

# 77. Offline Attachment Policy

Attachments não precisam ser todos baixados automaticamente.

Estados:

```text
Cloud Only
Cached
Pinned Offline
Downloading
Unavailable
```

GM pode selecionar:

```text
[ Make Campaign Available Offline ]
```

com estimativa de espaço necessário.

---

# 78. Métricas

## Activation

Novo usuário deve conseguir:

```text
Create Account
→ Add RPG
→ Select System
→ Create Character
→ Start Session
```

em menos de 10 minutos.

## Rules

Regra comum encontrada em:

```text
< 10 seconds
```

## Session Operations

NPC simples criado em:

```text
< 30 seconds
```

Encounter iniciado em:

```text
< 15 seconds
```

Handout revelado em:

```text
< 5 seconds
```

---

# 79. Offline Performance Metric

Para uma campanha previamente sincronizada:

```text
Installed PWA
Offline
Warm local database
Typical campaign dataset
```

tempo entre abertura da aplicação e Session Mode utilizável:

```text
p95 < 2 seconds
```

A medição não inclui download inicial de attachments.

---

# 80. Data Safety Metrics

Objetivo:

```text
0 silent overwrites of collaborative text
```

Conflitos estruturados não resolvíveis automaticamente devem ser apresentados explicitamente ao usuário.

Nenhuma operação offline confirmada pela interface pode ser silenciosamente descartada.

---

# 81. Estratégia de Validação

O produto será validado por um grupo real de jogadores e mestres utilizando uma **campanha sandbox independente de campanhas em andamento**.

Objetivos:

- validar usabilidade do GM;
- validar experiência do jogador;
- testar regras e fichas;
- testar sincronização;
- testar funcionamento offline;
- testar encounters;
- testar handouts;
- testar visibility;
- testar clues;
- testar clocks;
- testar hidden mechanics;
- coletar feedback sem expor spoilers ou informações de campanhas reais.

O conteúdo da campanha sandbox deve ser propositalmente descartável.

---

# 82. Campanha Sandbox de Validação

Campanha sugerida:

```text
The Missing Caravan
```

Premissa:

> Uma pequena caravana desapareceu entre uma vila e um posto comercial. O grupo é contratado para descobrir o que aconteceu.

O cenário deve permanecer simples e genérico.

Locais:

```text
Village
Old Road
Abandoned Warehouse
Forest Camp
Trading Post
```

NPCs:

```text
Merchant
Village Elder
Guard
Traveler
Smuggler
Bandit Leader
```

Itens:

```text
Weathered Letter
Merchant Ledger
Broken Seal
Supply Crate
Old Map
```

A aventura existe para exercitar funcionalidades da aplicação, não para fornecer uma campanha complexa.

---

# 83. Clock de Validação

```text
ENEMY PLAN

● ● ● ○ ○ ○
3 / 6
```

Eventos:

```text
1 Scouts observe the village
2 Supplies disappear
3 Caravan is captured
4 Evidence begins to disappear
5 Captives are moved
6 The enemy abandons the region
```

O clock permite testar:

- avanço manual;
- avanço por Events;
- sincronização;
- audit log;
- visibility;
- alterações offline.

---

# 84. Secrets e Knowledge de Validação

Secrets:

```text
The missing caravan was not attacked randomly.

An NPC inside the settlement is helping the smugglers.

The abandoned warehouse contains a hidden entrance.
```

Knowledge inicial dos jogadores:

```text
A caravan is missing.
It never reached the trading post.
The old road is considered dangerous.
```

Knowledge do GM:

```text
All campaign truths.
NPC relationships.
Clue locations.
Enemy plan.
```

Esses dados permitem validar diferença entre:

```text
World Truth
GM Knowledge
Party Knowledge
Player Knowledge
```

sem revelar conteúdo de nenhuma campanha real.

---

# 85. Clue Redundancy de Validação

Clue principal:

```text
Someone inside the settlement is helping the smugglers.
```

Fontes:

```text
□ Merchant Ledger
□ Captured Smuggler
□ Hidden Letter
□ Warehouse Records
```

Possível evolução:

```text
Captured Smuggler escapes.

☒ Captured Smuggler — unavailable
□ Merchant Ledger
□ Hidden Letter
□ Warehouse Records
```

O sistema deve:

- atualizar disponibilidade;
- manter a clue ativa;
- informar quantidade de fontes restantes;
- nunca bloquear a campanha apenas porque uma fonte deixou de existir.

---

# 86. Hidden Mechanic de Validação

Uma hidden mechanic genérica será utilizada apenas para validar infraestrutura.

Exemplo:

```text
Hidden Favor
```

Configuração:

```text
Trigger:
A specific campaign condition is met.

Effect:
Modify the outcome of a roll.

Visibility:
GM Only
```

Execução:

```text
Original Roll:
Failure

Hidden Effect:
Applied

Final Outcome:
Success
```

Log do GM:

```text
Hidden Intervention

Original:
Failure

Result:
Success

Source:
Hidden Favor
```

Objetivo:

Validar que um módulo consegue alterar resultados sem revelar sua existência aos jogadores.

Nenhuma relação com campanhas reais deve ser necessária.

---

# 87. Cenários de Teste Multiplayer

## Teste 1 — Join Campaign

GM cria campanha.

Jogadores entram por convite.

Validar:

- memberships;
- roles;
- permissions;
- sincronização inicial.

---

## Teste 2 — Character Update

Player A altera recurso da própria ficha.

Esperado:

```text
Player A
Local SQLite updated immediately

↓

GM receives synchronized state
```

Outro jogador sem permissão não pode alterar o recurso.

---

## Teste 3 — Handout Reveal

GM possui:

```text
Weathered Letter

Visibility:
GM Only
```

Executa:

```text
Reveal to Player A
```

Esperado:

```text
Player A → receives handout
Player B → does not receive handout
```

---

## Teste 4 — Offline Player

Player perde conexão.

Executa:

```text
Character update
Note creation
Dice roll
```

Interface permanece operacional.

Após reconexão:

```text
Pending mutations
↓
Synchronize
↓
Consistent campaign state
```

---

## Teste 5 — Concurrent Editing

GM e Assistant GM editam a mesma Session Note.

Esperado:

```text
Yjs merge
```

Nenhuma edição deve desaparecer silenciosamente.

---

## Teste 6 — Structured Conflict

GM e Assistant GM alteram simultaneamente um mesmo campo estrutural.

Esperado:

```text
Version conflict detected
↓
Explicit resolution
```

Não utilizar silent last-write-wins.

---

## Teste 7 — Clock

GM avança:

```text
Enemy Plan
3 → 4
```

Esperado:

- jogadores autorizados recebem estado;
- Event correspondente pode ser executado;
- alteração entra no audit log.

---

## Teste 8 — Rules Lookup

Durante encontro, jogador consulta uma regra.

Objetivo:

```text
Rule found in < 10 seconds
```

A consulta deve funcionar também offline caso a documentação esteja cacheada.

---

# 88. Critérios de Aceite do MVP

O GM consegue:

- criar conta;
- criar RPG;
- selecionar Cairn ou Fate;
- criar campanha;
- consultar regras integradas;
- criar personagem;
- criar NPC;
- criar local;
- anexar arquivos;
- criar notas;
- iniciar sessão;
- executar ações;
- rolar dados;
- gerenciar encounter;
- pesquisar regra;
- trabalhar offline;
- reconectar e sincronizar;
- exportar campanha.

O jogador consegue:

- entrar numa campanha;
- visualizar a própria ficha;
- alterar campos autorizados;
- executar rolagens;
- acessar conteúdo revelado.

---

# 89. Critério Arquitetural de Aceite

Este é o teste mais importante do MVP:

> As páginas genéricas de Character, Session, Encounter e Rules devem funcionar tanto com Cairn quanto com Fate sem branches de código baseados no identificador do sistema.

Aceitável:

```text
system.capabilities
system.characterSchema
system.actions
```

Não aceitável:

```text
if cairn
if fate
```

---

# 90. Visão de Longo Prazo

```text
GM Companion
      ↓
Multi-System RPG Manager
      ↓
Rules Platform
      ↓
Campaign Platform
      ↓
System + Module SDK
      ↓
Community Ecosystem
```

O produto deve eventualmente permitir:

```text
Add RPG
    ↓
Choose System
    ↓
Choose Modules
    ↓
Create Campaign
    ↓
Invite Players
    ↓
Prepare
    ↓
Play Offline or Online
    ↓
Synchronize
    ↓
Record
    ↓
Evolve Campaign
```

sem que o Core tenha sido escrito especificamente para aquele RPG.

---

# 91. Decisões Técnicas Fundamentais

As seguintes decisões ficam registradas nesta versão do PRD:

```text
TypeBox over Zod
for Core/System schema contracts

PostgreSQL
as shared relational persistence

SQLite
as local client persistence

PowerSync
as initial local-first sync provider

S3-compatible Object Storage
for binary attachments

MinIO
as default local/self-hosted S3 implementation

Yjs
only for collaborative documents

AST Interpreter
for formulas

@fastify/websocket
for ephemeral realtime

Modular Monolith
for backend architecture

Cairn + Fate
as MVP architecture validation systems
```

Estas escolhas podem posteriormente virar ADRs durante a elaboração da Tech Spec.

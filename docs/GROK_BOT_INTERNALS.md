# Grok Bot — внутрішня будова (розбір бінарника v0.18.0)

Витягнуто з `dist/host/host-main.cjs` (25 МБ, esbuild-бандл без мініфікації — імена файлів і функцій
збережені), `dist/electron-main/main.cjs`, `dist/renderer/*` та з живих сесій у застосунку.
Це довідка для Halo Bot: що саме робить оригінал і як.

---

## 1. Системний промпт (`src/host/runner/system-prompt.ts`)

Функція `buildSandBaseSystemPrompt({ cloudAgentsEnabled })` збирає ~40 КБ тексту з 14 розділів.
Перший рядок: «You are Grok Bot, a warm, concise desktop assistant.»

| Розділ | Суть |
|---|---|
| **How a turn works** | 5 тактів: 1) Reply first — перша дія на будь-якому ході, відкритому людиною, це текстовий `SendMessage` **до** будь-якого інструмента; 2) Pick the surface; 3) Work out loud; 4) Show your work; 5) Close the loop |
| **SendMessage is your only voice** | Звичайний текст асистента — «внутрішній монолог», користувач його не бачить. `ack ≠ delivery`: підтвердження на початку не звільняє від доставки результату в кінці |
| **Reply first, then keep the user posted** | Оновлення на кожному значущому такті; найгірший режим — довга тиша; другий найгірший — стіна дрібних повідомлень |
| **Tone** | «Тепла, гостра подруга/друг, що добре це вміє», не хелпдеск. Без «Certainly», «I'd be happy to». Em-dash названо «robot tell» і заборонено як типову пунктуацію. Займенники — тільки заявлені, інакше they |
| **Reply length and shape** | Більшість відповідей — 1–2 речення. Мультиповідомлення за замовчуванням: 2–4 окремі `SendMessage` замість одного абзацу. Проза, не булети. Заборонені префікси «Done —», «tldr:», «quick version:» |
| **Showing your work** | Візуал — за замовчуванням, не доказ. Зображення з інструментів автоматично зберігаються на диск, шлях повертається в результаті; вигадувати шляхи скріншотів заборонено |
| **Never fabricate data** | Жодних вигаданих чисел/цитат/джерел; заборонено вигадувати навіть пункти меню самого застосунку |
| **Asking for decisions** | Рішення питають **віджетом** (`type:"widget"`), не прозою. Кожен варіант має бути реальним, перевіреним. Віджет завершує хід |
| **Threaded replies** | `reply_to` ховає повідомлення у гілку (`N in thread`); за замовчуванням не використовується |
| **Where you work** | Дві машини: box (`Shell`/`Read`, за замовчуванням) і компʼютер користувача (`ExternalShell`/`ExternalRead`, кожна дія — approval). Слово «box» — жаргон, користувачу завжди «my computer» |
| **Long-running commands** | `block_until_ms: 0` — команда одразу йде у фон, агента «оживляють» по завершенні. Дев-сервери й вотчери — норма |
| **Delegating background work** | `Task` → субагент у фоні; `CheckSubagent` (не для полінгу, а щоб ловити зависання), `MessageSubagent` (перебиває, зберігає контекст), `StopSubagent` |
| **Managing plugins and MCP servers** | Плагін = бандл, конектор = MCP-сервер сервісу. Встановлення/видалення — тільки після віджет-підтвердження |
| **Reaching services that have no connector** | Драбина ескалації: памʼять/файли → конектор (MCP) → веб → залогінений браузер боксу → десктоп боксу → віддати крок користувачу |

Окремий блок **The box desktop**: агент **не має** права сам клікати — тільки читати екран
(`Screenshot`). Уся взаємодія делегується субагентам: `browserUse` (сторінковий рівень, посилання на
елементи, працює паралельно) або `computerUse` (справжній десктоп, один екран — тільки один за раз).
Прямо заборонено обходити це через `xdotool`, CDP, Playwright, Puppeteer, `/json/new`, читання
cookie-БД чи eval JS через DevTools.

Ще: `request_box_help` — передача боксу користувачу для логіна/2FA/капчі/оплати (одна коротка
інструкція, без попереднього віджета «передати?»).

---

## 2. Інструменти (повний перелік, підтверджений самим ботом)

Чат і стан: `SendMessage`, `ReactToMessage`, `update_state`.
Бокс: `Shell`, `AwaitShell`, `Read`, `Screenshot`. Компʼютер користувача: `ExternalShell`,
`AwaitExternalShell`, `ExternalRead`. Перенос: `CopyToBox`, `CopyFromBox`.
Веб: `WebSearch`, `WebFetch`. Медіа: `GenerateImage`. Код: `CloudAgent`.
Люди: `CreateAgent`, `UpdateAgent`, `CreateChannel`, `UpdateChannel`, `SendToAgent`.
Фон: `Task`, `CheckSubagent`, `MessageSubagent`, `StopSubagent`, `TodoWrite`.
MCP: `GetMcpTools`, `CallMcpTool`, `SearchPlugins`, `GetPlugin`, `InstallPlugin`, `UninstallPlugin`,
`AddMcpServer`, `UninstallMcpServer`, `AuthenticateMcpServer`, `GetMcpServerStatus`,
`RestartMcpServers`, `RemoveMcpAccount`, `RenameMcpAccount`, `SetMcpInstructions`.
Інше: `request_box_help`, `SendFeedback`, `OfferRepositorySwitch`, `StartSlackStreaming`.

### `SendMessage` — 5 типів
`text` (+ `images[]`, які рендеряться в тій самій бульбашці), `attachment` (file:// або https://),
`widget` (питання з варіантами), `cursor-agent` (картка хмарного агента за `bcId`),
`secret-request` (маскований ввід секрету — значення йде одразу у файл облікових даних конектора,
агент його не бачить).
Ще поля: `reply_to` (адреса на кшталт `t3u` / `t3s1` — гілка), `channel` (`platform:chat` —
доставка у зовнішній месенджер замість чату застосунку).

### `update_state` — єдиний інструмент стану
| target | actions |
|---|---|
| `memory` | `write` (fact, tier, scope), `forget` (точний текст факту) |
| `routine` | `create`, `update`, `pause`, `resume`, `delete` |
| `workflow` | `write` (name, description «use this when…», body у markdown), `delete` |
| `profile` | `set` (name, description) |
| `settings` | `set` (`hidden_from_sidebar`, `notify_on_updates`) |
| `channel` | `disconnect` (platform) |
| `project` | `create`, `join`, `leave` |
| `avatar` | `set` (шлях до зображення ≤5 МБ), `clear` |

**Routine ≠ workflow**: routine має тригер і виконується сама; workflow — це «навичка», рецепт у
markdown з описом «use this when…», який не запускається сам.

**Scope памʼяті**: `agent` (своя), `user` (спільна для всіх ботів), `project` (шард у проєкті).

---

## 3. Памʼять (`src/host/runner/sand-memory.ts`)

- Три рівні: `profile` (хто такий користувач — у промпті кожного ходу), `log` (датована історія,
  за замовчуванням), `note` (дрібниці, згасають першими, лишаються на диску).
- Фізично: тека памʼяті з `profile.md` і `log/`; бот може грепати її звичайним `Shell`.
- Ліміти: 30 свіжих фактів у промпт, бюджет 4000 символів, 100 profile-фактів, 500 символів на факт,
  1000 у UI.
- Ранг згадування: `log2(importance) + createdAt / (30 днів)` — тобто напіврозпад 30 днів;
  важливість: `[episode] 1.5`, звичайний `1.0`, `[note] 0.5`.
- Кожні `SAND_MEMORY_EPISODE_INTERVAL` (типово 6) ходів пишеться «епізод» — стисла історія.
- Витяг фактів — окремий дешевий виклик моделі після обміну; є фільтр «тривіальних» реплік
  (`hi`, `thanks`, `ok`, `lol`, …) і евристика «варте памʼяті» (довше 40 символів або містить «?»).
- Формат відповіді екстрактора: рядки `profile: …` / `log: …` / `note: …` / `remove: <точний текст>`,
  або одне слово `NONE`.
- `sand_memory_dreaming` — окремий фіче-флаг (фонова «переробка» памʼяті).

---

## 4. Auto-review (перевірка дій перед запуском)

Класифікатор ризику викликається на кожну «поверхню»: `shell`, `browser`, `computer`,
`automation_write`, `cloud_agent`, `subagent`. Режими: `off | shadow | enforce`
(`shadow` — рахує, але не блокує). Результат: `allow` / `block` + `reason` + інколи `proposedRule`.
Заблоковане показується як картка approval; користувач тисне **Always allow / Allow once / Never**.
Правила користувача зберігаються як `allowInstructions` / `blockInstructions` (до 20 записів,
по 1000 символів) — це той самий «When Grok Bot wants to… It should…» у налаштуваннях.

Практична деталь: у Windows їхній `ExternalShell` запускається **не** через `powershell.exe` —
під час перевірки `Get-Date` повернуло `command not found`, а бот доповів, що `pwsh` не встановлено.

---

## 5. Тригери routine (`sand-state-tool.ts`)

`schedule` — cron-рядок, або `trigger` — подієвий слухач:
`cron`, `slack`, `github`, `linear`, `pagerduty`, `sentry`, `microsoftTeams`, `group`.

- Slack: канал `#eng`, DM `@dana` або `*`; збіг за `mention | keyword | message | reaction`.
- GitHub: репозиторій «owner/name», події `pr-opened`, `comment`, `push`, `release`,
  `ci-passed`/`ci-failed` (останні дві потребують `ciBranch`).
- microsoftTeams потребує `tenantId` і принаймні один team id.

---

## 6. Процеси й транспорт

- `electron-main` ↔ `host` ↔ `box` через власний **gateway** (websocket, `src/host/gateway-*.ts`),
  плюс `webauthn-gateway` — проксі апаратного ключа користувача в бокс.
- `local-exec-daemon` — окремий процес для дій на машині користувача, з машиною дозволів
  (`local-tool-permission*.ts`).
- `box-store-sync` — синхронізація файлів і сесій Chrome між боксом і хостом: маніфест, pack,
  transfer, hydration, `chrome-session-watcher`.
- Воркери: `agent-store-worker`, `transcript-mirror-worker`, `search-index-worker`,
  `box-store-vacuum-worker`.
- Сховище сесій — SQLite (`agent-db.ts`), транскрипт посторінково, є recovery і GC розмов.

---

## 7. Коди помилок

Реєстр `src/shared/errors/registry.ts`: **87 кодів** `SAND-E0001`…`SAND-E0724`, кожен з полями
`name`, `domain`, `retryable`, `summary`, `payload`, `seededFrom`. Домени: `registry`, `transport`
(0101–0113: `gatewayRefused`, `gatewayTimeout`, `gatewayHttp5xx`, `gatewayDns`, `backendUnreachable`…),
далі сесії, бокс, автоматизації, інструменти.

---

## 8. Фіче-флаги (Statsig) — фактично дорожня карта

`sand_auto_review`, `sand_computer`, `sand_computer_use_playwright`, `sand_browser_use_subagent`,
`sand_subagent`, `sand_multitask`, `sand_multiplayer`, `sand_agent_network`, `sand_memory_dreaming`,
`sand_teach_by_demonstration`, `sand_spotlight`, `sand_global_search`, `sand_cloud_agent`,
`sand_action_audit_logs`, `sand_action_audit_settings`, `sand_model_selection`, `sand_default_model`,
`sand_automations_model`, `sand_browser_use_model`, `sand_usage_page`, `sand_trial_*`,
`sand_min_client_version`, `sand_auto_update_when_idle`, `sand_notify_bus`.

---

## 9. Компоненти дизайн-системи (`sand-kit-*`)

`agent-avatar`, `avatar-stack`, `base-avatar`, `breadcrumb`, `button`, `divider`, `icon`,
`icon-button`, `list-item`, `message-input-frame`, `status-dot`, `system-event` (+`__chip`, `__label`),
`text`, `timestamp`, `unread-badge`, `user-profile`, `working-badge`.

Спостережене в UI:
- **system-event** — центрований приглушений рядок: «Grok Bot can run commands on your computer.»,
  «Created routine ⏱ Uptime Check», «Messaged Recon», «Updated memory for …».
- **Згорнутий обмін між ботами** — «2 messages with 🔵 Studio» замість купи повідомлень.
- **NEW** — синя лінія непрочитаного.
- Картка approval **прикріплена знизу** над композером, з кнопками Always allow / Allow once / Never
  і розкривачем «Show the command».
- Панель компʼютера — оверлей поверх затемненого застосунку, зверху «Teach a task» (запис із
  червоною рамкою і таймером) і кнопка згортання; знизу — док із Chrome, файловим менеджером і терміналом.
- Запис демонстрації повертається в чат як відео-картка + системне повідомлення користувача
  «The recording is finished. Learn the task from it.» з чипом **Learn from demonstration**.

---

## 10. Що з цього вже перенесено в Halo Bot

- SendMessage-only модель, «reply first», короткі часті повідомлення.
- Box vs компʼютер користувача, approvals із трьома варіантами і липкими правилами.
- System-event рядки, згортання службового шуму, приховані tool-картки за перемикачем.
- Routines з людськими розкладами; памʼять у файлі; мультибот через SendToAgent/CreateAgent.
- Дизайн-токени, метрики вікна, стани аватара.

## 11. Що варте перенесення далі

1. Памʼять із рівнями `profile/log/note` + автовитяг після кожного обміну + напіврозпад.
2. Віджети-питання (`type:"widget"`) замість запитань прозою.
3. Вкладення/зображення прямо в бульбашці.
4. Workflows («навички» з описом «use this when…») окремо від routines.
5. Фонові команди (`block_until_ms: 0`) з «оживленням» після завершення.
6. Передача браузера користувачу для логіна (аналог `request_box_help`).
7. Субагенти `browserUse` / `computerUse` як окремі фонові процеси.

---

## 12. Повний API гейтвею (`SAND_GATEWAY_COMMANDS`)

Десктоп говорить із хостом/боксом через один websocket-канал команд. Перелік показує всю
функціональність продукту, зокрема ту, що ще не увімкнена в UI:

**Розмови**: `getTranscript`, `getAgentTranscript(Page|Window|Tail)`, `getAgentThread`, `sendPrompt`,
`promptAcceptanceStatus`, `getConversationOutline`, `reactToMessage`, `respondToWidget`,
`dismissWidget`, `submitSecret`, `appendConnectorCard`.

**Дозволи**: `resolveAutoReviewApproval`, `resolveLocalToolPermission`.

**Боти**: `listAgents`, `countAgents`, `searchAgents`, `searchMedia`, `createAgent`,
`kickstartAgent`, `updateAgent`, `deleteAgent(s)`, `duplicateAgent`, `createGroup`,
`setGroupMembers`, `broadcastToAgents`, `setAgentAvatarBytes`, `getAgentAvatar`.

**Памʼять**: `getAgentMemories`, `deleteAgentMemory`, `clearAgentMemories`.

**Автоматизації (routines)**: `getAgentAutomations`, `listAllAutomations`, `createAgentAutomation`,
`updateAgentAutomation`, `setAgentAutomationEnabled`, `deleteAgentAutomation`, `runAgentAutomationNow`.

**Workflows (навички)**: `getAgentWorkflows`, `create/update/delete`, `setAgentWorkflowEnabled`,
`runAgentWorkflowNow`, `importAgentWorkflowText`, `importAgentWorkflowUrl`, `portAgentLocalSkills`,
`skillsCatalog`, `syncPluginSkills`, `getPluginSyncStatus`, `getSkillPublishTargets`, `publishSkill`,
`resyncPublishedSkill`, `unpublishSkill` — тобто навички можна публікувати у спільний каталог.

**Спільні кімнати (мультиплеєр)**: `getSharingState`, `createRoomFromAgent`, `createRoomInvite`,
`joinSharedRoom`, `respondToRoomJoinRequest`, `createSharedRoom`, `addOwnAgentToSharedRoom`,
`removeOwnAgentFromSharedRoom`, `setSharedRoomTyping`, `leaveSharedRoom` — кілька людей і їхні боти
в одній кімнаті.

**Канали**: `getAgentChannels`, `connectChannel`, `disconnectChannel`, `refreshChannel`,
`getListenerIntegrations`, `getListenerConnectUrl`.

**Фон**: `getSubagents`, `getAsyncTasks`.

**Бокс («forever box»)**: `getForeverBoxStatus`, `ensureForeverBox`, `resetForeverBox`,
`updateForeverBox`, `autoUpdateBoxNow`, `snapshotBoxStoreNow`, `getBoxStoreStatus`, `clearBoxStoreNow`,
`setBoxMigrating`, `prepareBoxForRecreate`, `resumeBoxAfterRecreate`, `handBackForeverBox`,
`setBoxSecrets`, `getBoxSecretsStatus`, `listBoxMcpServers`, `isEgressTunnelAvailable`.

**Навчання демонстрацією**: `startTeachRecording`, `stopTeachRecording`, `getTeachRecordingStatus`.

**Інше**: `getTrays`/`dismissTray`/`clearTrays` (сповіщення), `uploadAttachment`,
`readAttachmentImage/Text/Chunk`, `getHostSettings`/`setHostSettings`, `updateHostNow`,
`completeMcpOAuth`, `requestWebAuthnCeremony`, `refreshMcp`, `isAgentNetworkEnabled`,
`isGlobalSearchEnabled`, `requestDiskSaverAudit`, `setWindowFocused`.

Стани компʼютера в UI: «Starting Grok Bot's computer», «Booting up the computer»,
«Waking your computer…», «Connecting to your computer…», «Reconnecting to your computer…»,
«Can't reach your computer», «Open an agent to reset the shared computer.»

## 13. Субагенти (`Task`)

Інструмент `Task` — це той самий Task із Cursor/Claude Code, дороблений: типи субагентів
`computerUse`, `browserUse`, `watchVideo`, `videoReview`, `executor`, плюс `Explore` для коду.
Правила з опису інструмента: запускати кілька паралельно; завжди давати короткий опис (3–5 слів);
субагент не бачить наміру користувача, тож завдання має бути самодостатнім; результат повертається
одним повідомленням; можна `resume` за id.

`computerUse` описано так: керує десктопом бокса через screenshot/click/drag/type/key/scroll/wait,
працює у фоні, **не** може ставити уточнювальні питання, тільки один такий субагент одночасно
(бо екран один), і не може діяти замість людини — на паролі/2FA/капчі/оплаті він зупиняється і
звітує, щоб бот викликав `request_box_help`.

## 14. Редактор routine (виміряно в UI)

Права панель, заголовок «Routine»: перемикач **Active**, кнопки **Delete** і **Test run**,
поле **Name**, багаторядкова **Instruction** (текст, який бот пише сам собі), картка
**When to run** зі списком тригерів і кнопкою **+ Add another** (кілька розкладів на одну routine),
і **Run history** («No runs yet»).

Приклад інструкції, яку бот написав собі сам:
«Check whether https://example.com is up. Send the user exactly one line with the result: whether it is
up or down, plus the HTTP status if available. Always send that one line; do not stay silent.»

## 15. Каталог шаблонів ботів (32 штуки, з бандла)

`eligibility: universal` — показуються всім: Night Shift, Inbox Triage, Chief of Staff, Negotiator,
Prototyper, Researcher, Shopper, Apartment Scout, Lookout, Competitor Watcher.

`eligibility: selected-tools` — зʼявляються лише коли підключено відповідний конектор
(`recommendedIf: ["Salesforce","HubSpot",…]`), а назва інструмента підставляється в опис через `${tool}`:
CRM Scribe, Pipeline Scout, First Responder, Win-Loss Analyst, Icebreaker, Call Coach, Deck Designer,
Channel Digest, Ticket Triager, Feedback Miner, Review Responder, Marketing Analyst, Shopkeeper,
Invoice Chaser, Expense Auditor, Subscription Sleuth, Paralegal, Application Screener, Sourcing Scout,
QA Engineer, Dashboard Watcher, Data Scientist.

## 16. Контекстне меню бота в сайдбарі

`Pin | Move to new section | Mark as Unread | Edit Profile | Duplicate | Copy conversation ID |
Hide from sidebar | Delete`.

## 17. Що показала жива багатоботова сесія

- Новий бот **сам** робить перший прохід: Archivist після створення оглянув спільний компʼютер,
  створив `/workspace/collections` з каталогом та inbox і відзвітував — без жодного запиту від людини
  (у гейтвеї це `kickstartAgent`).
- Канал: Studio створив «Ops Room», поставив у ньому два адресні питання (`@Recon`, `@Archivist`),
  зібрав відповіді й підсумував їх у своєму особистому чаті — тобто бот-бот координація реальна.
- У каналі повідомлення показують імʼя автора над бульбашкою, аватар збоку, а згадки рендеряться
  чипом «аватар + імʼя».
- У приватному чаті обмін між ботами згортається в один рядок «2 messages with Studio».

## 18. Порівняння можливостей: Grok Bot vs Halo Bot (станом на цю ітерацію)

| Можливість | Grok Bot | Halo Bot |
|---|---|---|
| Іменовані боти з профілем і памʼяттю | так | так |
| Постійний компʼютер бота | хмарна VM (спільна на акаунт) | локальний Chromium-екран на бота, сесії зберігаються |
| Перегляд екрана бота | превʼю + повний VNC-режим | живий превʼю (той самий екран, зменшений) + повна панель |
| Дозволи (approvals) | Always allow / Allow once / Never + правила | те саме + LLM-рецензія ризику (Smart) |
| Routines | розклад + події (Slack/GitHub/Linear/…) | interval / daily / weekdays / weekly, кілька тригерів, Test run, історія |
| Навчання демонстрацією | запис відео + модель дивиться | запис реальних дій у браузері → скіл із кроками і селекторами |
| Навички (workflows/skills) | так, із публікацією в каталог | так, локальні файли `skills/*.md` |
| Мультибот | канали, @згадки, передача роботи | канали, @згадки, SendToAgent, обмеження ланцюга |
| Субагенти | computerUse / browserUse / watchVideo / executor | browser / research / shell + Check/Stop |
| Плагіни | маркетплейс MCP (хмарний) | маркетплейс MCP (локальні stdio-сервери), інструменти вливаються в бота |
| Памʼять | profile/log/note, автовитяг, напіврозпад | те саме |
| Компактизація контексту | так (summarization) | так (summary + tail) |
| Зір | так | так (скріншоти йдуть у модель) |
| Облік використання | Trial usage % | токени/дзвінки/час, за ботами |
| Windows | інсталятор, автозапуск | інсталятор (nsis), автозапуск, трей із ботами, бейдж непрочитаного |
| Хмарні агенти, iOS, спільні кімнати | так | ні (поза локальним фокусом) |

## 19. Що ще перенесено в цій ітерації

- **Плагіни = MCP по-справжньому**: власний stdio-клієнт JSON-RPC, каталог із 12 реальних серверів
  (Filesystem, Fetch, Knowledge Graph, Sequential Thinking, Git, SQLite, Playwright, GitHub, Brave, Slack,
  Notion, Time), інструменти вливаються в набір бота як `mcp__<server>__<tool>`. Перевірено наскрізно:
  бот сам перелічив `mcp__sequential_thinking__sequentialthinking`.
- **Меню акаунта** внизу сайдбара (Settings / Plugins / Open data folder / About / Quit) — як у оригіналі,
  без пунктів, що стосуються хмари (iOS, Trial usage).
- **Живий екран бота**: превʼю в панелі деталей — це той самий WebContentsView, зменшений зумом,
  а не скріншот. Клік відкриває повний режим із адресним рядком і кнопкою «Teach a task».
- **Навчання демонстрацією** повністю: рекордер стрімить події через console-канал (переживає навігацію),
  паролі пишуться як `<secret>`, трек перетворюється на скіл із селекторами.
- **Зір**: скріншоти і зображення з інструментів ідуть у модель як `image_url`; `Read` більше не вивалює
  байти PNG у контекст, а віддає картинку «подивись».
- **Памʼять**: рівні profile/log/note, автовитяг після кожного обміну, напіврозпад 30 днів.
- **Компактизація**: коли розмова переростає бюджет, старі ходи згортаються у підсумок (із збереженням
  хвоста і без осиротілих tool-результатів).
- **Стійкість**: ретраї на транзієнтних помилках (тільки до першого стріму), таймаут «сервер замовк»,
  банер «Model server unreachable» з кнопками Retry / Open settings.
- **Обмежувач routine**: не більше N запусків на добу (типово 24), інакше routine ставиться на паузу —
  локальний аналог їхнього spend guard.
- **Windows**: інсталятор nsis, автозапуск, трей зі списком ботів, бейдж непрочитаного на іконці,
  тайтлбар перефарбовується під тему.

## 20. Де Halo вже кращий за оригінал на Windows

- `ExternalShell` виконується через `powershell.exe`. У Grok Bot та сама команда (`Get-Date`) впала з
  `command not found`, бо їхній локальний виконавець шукає `pwsh` і використовує POSIX-оболонку.
- Немає хмарної залежності: бокс, браузер, памʼять і плагіни живуть на машині користувача.
- Модель обирається під залізо: список моделей ранжується за підтримкою інструментів і за тим, чи влізає
  вона в памʼять.

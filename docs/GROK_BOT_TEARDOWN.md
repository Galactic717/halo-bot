# Grok Bot — розбір оригіналу (база для Halo Bot)

Джерела: `D:\Grok\Grok Bot` (v0.18.0, розпакований `app.asar`), x.ai/bot, огляд у `Grok_ta_Grok_Bot_ohliad.md`.

## 1. Що це

"AI teammates you can give real work to" — іменовані боти з **постійною** памʼяттю, файлами, сесіями браузера.
Не чат-сесія, а напарник: логіниться у твої застосунки, клікає як людина, доводить справу до кінця,
повертається тільки за схваленням (approvals). Кілька ботів працюють паралельно і передають роботу один одному.

Ключові обіцянки з лендінгу:
- Message Bots like teammates (desktop + iOS)
- Work with many Bots at once (паралельно, 24/7)
- Grok Bot works where you work (логін один раз, далі бот сам користується сайтами)
- You're in control (кроки, що ризикують, ідуть на approval)
- Show a Bot how it's done → зберігається як **routine**, далі виконується сама
- Bots get smarter over time (памʼять + навчання один від одного)
- Connect the Bots (спільний тред, боти пересилають роботу)

## 2. Технічний стек оригіналу

`package.json`: `name: "sand"`, productName "Grok Bot", author SpaceXAI, homepage cursor.com.

- **Electron** (frameless, `titleBarStyle: hidden` + `titleBarOverlay` на Windows; `hiddenInset` на macOS)
- **React 19 + StyleX + @base-ui/react**, Vite build, motion, tiptap (композер), react-markdown + katex + mermaid + highlight.js, pdfjs, xlsx, mammoth
- **Connect RPC / protobuf** (`@bufbuild/protobuf`, `@connectrpc/connect`) до бекенду Cursor/xAI
- **Statsig** (feature flags), **Sentry**, **OpenTelemetry**
- `zod` для схем, `ws` для гейтвею

Процеси (кожен — окремий bundle):
| Процес | Файл | Роль |
|---|---|---|
| electron-main | `dist/electron-main/main.cjs` (18 МБ) | вікна, IPC, оновлення, auth |
| host | `dist/host/host-main.cjs` (25 МБ) | **весь агентний рантайм** |
| local-exec-daemon | `dist/local-exec-daemon/main.cjs` (8.7 МБ) | виконання на машині користувача + дозволи |
| node-agent-coordinator | | координація агентів |
| renderer | `dist/renderer/*` | UI |
| workers | agent-store-worker, transcript-mirror-worker, search-index-worker, box-store-vacuum-worker |

## 3. Архітектура host (з мап модулів `src/host/**`)

- **Box** — «компʼютер» бота (хмарна VM). Один спільний компʼютер на акаунт, у кожного бота свій «екран».
  `box-store-sync` синхронізує файли/сесії Chrome між боксом і хостом (manifest, pack, transfer, hydration).
- **Session** — `agent-db.ts` (SQLite), транскрипти сторінками, канали, ростер, самарі, recovery.
- **Runner** — `sand-agent-runner.ts` + `turn-*`: цикл ходу, збірка system prompt, toolset на хід,
  spill великих виводів, subagent-и (browser-use, computer-use), memory.
- **Auto-review** — окремий класифікатор ризику (`sand-auto-review*.ts`) на кожну поверхню:
  shell, browser, computer, automation_write, cloud_agent, subagent. Режими `off | shadow | enforce`.
  Блокує → показує картку approval у чаті, може запропонувати правило («proposedRule»).
- **Automations (routines)** — тригери за розкладом і за подіями (listener integrations), spend guard, історія.
- **Memory** — `memory-service`, `memory-synthesis-service`, `agent-state`.
- **MCP** — керування MCP-серверами + маркетплейс.
- **Gateway** — websocket-протокол host ↔ box, а також webauthn-proxy (2FA у боксі через ключ користувача).

### Інструменти агента (реальні імена з бінарника)
| Інструмент | Призначення |
|---|---|
| `SendMessage` | **єдиний** спосіб сказати щось користувачу (звичайний текст не доставляється) |
| `ReactToMessage` | емодзі-реакція |
| `Read`, `Shell`, `AwaitShell` | робота всередині box |
| `ExternalRead`, `ExternalShell`, `AwaitExternalShell` | робота на машині користувача (через local-exec + дозволи) |
| `CopyToBox`, `CopyFromBox` | перенос файлів |
| `WebSearch`, `WebFetch` | веб |
| `CreateAgent`, `UpdateAgent`, `SendToAgent` | керування іншими ботами, передача роботи |
| computer-use / browser-use | керування екраном і браузером (як subagent) |
| MCP meta-tools | `CallMcpTool`, `InstallPlugin` тощо |

Показова деталь із промпта: система примусово нагадує моделі, що **plain text ніколи не доходить до
користувача** — тільки виклик `SendMessage`. Це і є основа «фонового» UX.

## 4. Дизайн-система

Два шари токенів у `dist/renderer/assets/index-lCyB53CO.css`
(`@layer reset, anysphere.tokens, anysphere.scss, anysphere.stylex, glass.scss, glass.stylex, overrides`):

**Легасі шар `--cursor-*`** (від Cursor):
- база: `--cursor-base:#F0F0F0`, `--cursor-editor:#181818`, `--cursor-sidebar:#181818`, `--cursor-chrome:#141414`, `--cursor-accent:#599CE7`
- усі поверхні = `color-mix(base X%, transparent)`: bg 20/14/8/6/4 %, stroke 20/12/8/4 %, text 100/74/60/36 %
- акценти: blue `#7BAFE9`, green `#3FA266`, red `#FC6B83`, yellow `#F1B467`, purple `#9386F2`, cyan `#81A1C1`, magenta `#B48EAD`, orange `#D08770`
- радіуси 2/4/6/8/12/full, шрифт 11/12/13/14 px (база **13px**), сітка 4px з півкроками

**Актуальний шар `--sand-*`** (власне Grok Bot, «glass»):
- фони `#fcfcfc` (base/elevated) і `#f7f7f7` (subtle), scrim `#14141480`
- текст `#141414` / `#14141499` / `#14141466`, on-color `#fcfcfc`
- fill primary `#070707`, accent `#1084fe` (hover `#0c64c1`, subtle `#1084fe17`), success `#00c972`, danger `#ff263c`, warning `#ff9800`
- 5 «supplementary» кольорів для аватарів ботів: `#ff6700`, `#97683d`, `#00bca6`, `#9159fe`, `#ff309b`
- бордери `#14141426` / `#1414141a` / `#1414140d`, focus `#14141466`
- бульбашки чату: user `#070707` (темна), agent `#eeeeee`
- метрики: `--sand-sidebar-width:280px`, `--sand-info-pane-width:320px`, `--sand-chat-min-width:424px`,
  `--sand-titlebar-block: 52px` (44px у режимі «компʼютер»), ваги 400/500/600

Вікно на Windows: `frame:false`, `titleBarStyle:"hidden"`, `titleBarOverlay` висотою 51px (у режимі
компʼютера 43px), колір оверлея = колір теми, символи чорні/білі за яскравістю. Мін. розмір 512×520.

## 5. Що з цього беремо в Halo Bot

Беремо: модель «бот = постійний напарник», SendMessage-only, box/external розділення інструментів,
approvals на ризикових діях, routines, памʼять, мультибот, панель «Компʼютер», структуру токенів і метрики.

Не беремо: хмарну VM (працюємо локально на Windows), Cursor-бекенд, protobuf-RPC, телеметрію,
брендинг і тексти промптів xAI (пишемо свої).

## 6. Живий інтерфейс (перевірено на залогіненому акаунті, v0.18.0)

Тема `data-theme="cursor-dark"`, `data-platform="win32"`. Реальні значення темної теми:
`--sand-bg-base:#070707`, `--sand-bg-subtle:#111111`, `--sand-bg-elevated:#181818`,
текст `#fcfcfc / #fcfcfc99 / #fcfcfc66`, акцент `#1084fe` (hover `#459ffe`),
бульбашка користувача `#5a5a5a`, бульбашка бота `#262626`, бордер `#fcfcfc26`, blur `24px`,
`--sand-window-controls-inset:140px`, `--sand-window-controls-block:51px`.

Каркас вікна (виміряно):
- `aside` «Grok Bot agents» — 280px, фон `#111111`, зверху 44px відступ під тайтлбар,
  кнопка «New» 24×24 у куті, поле Search 255×32, рядок бота 255×54 (аватар 32 + імʼя + час + прев'ю),
  знизу «Plugins» і рядок акаунта 255×40, ручка зміни ширини 12px
- `header` 44px: аватар+імʼя бота (кнопка «View agent settings»), справа іконка «Grok Bot's Computer»
- транскрипт: повідомлення шириною до 640px, дії при наведенні (реакція / відповісти / ще) 24×24
- композер: пігулка на всю ширину, «+» 28×28 зліва, мікрофон 28×28 справа
- права панель «Conversation details» 320px: екран бота (превʼю 16:10) + «Routines» + кнопка «Create Routine»;
  вкладка Settings бота: аватар, Name, Title, Description, картка Notifications

Онбординг: вибір кольору (10) і «обличчя» аватара (9 форм), поле Name, кнопка Get started,
внизу стрічка Suggestions (Night Shift, Inbox Triage, Chief of Staff…). Аватар має стани
`data-grok-state`: `idle | sleeping | happy` (анімоване обличчя).

Глобальні Settings (модалка, розділи General / Usage & Billing / Updates):
Account, Appearance→Theme (Follow System), Agent→Timezone,
**Execution on Local Computer** (`Ask every time`), **Auto-review** (вмик./вимк.),
**Auto-review Rules** — правила природною мовою «When Grok Bot wants to: … It should: Allow automatically»,
Security Key (апаратний ключ для 2FA).

Plugins — маркетплейс MCP: вкладки Marketplace / Yours, пошук, категорії, картки з кнопкою Add.

## 7. Повний перелік інструментів (бот перелічив їх сам)

| Група | Інструменти |
|---|---|
| Чат і стан | `SendMessage`, `ReactToMessage`, `update_state` (memory, routines, workflows, profile, settings, projects, avatar) |
| Компʼютер бота | `Shell`, `Read`, `Screenshot`, `AwaitShell` |
| Компʼютер користувача | `ExternalShell`, `ExternalRead`, `AwaitExternalShell` |
| Перенос файлів | `CopyToBox`, `CopyFromBox` |
| Веб | `WebSearch`, `WebFetch` |
| Зображення | `GenerateImage` |
| Код | `CloudAgent` (хмарні агенти + PR) |
| Люди і групи | `CreateAgent`, `UpdateAgent`, `CreateChannel`, `UpdateChannel`, `SendToAgent` |
| Фонова робота | `Task` (executor, browser, desktop, video), `CheckSubagent`, `MessageSubagent`, `StopSubagent`, `TodoWrite` |
| Конектори | `GetMcpTools`, `CallMcpTool`, `SearchPlugins`, `GetPlugin`, `InstallPlugin`, `UninstallPlugin`, `AddMcpServer`, `UninstallMcpServer`, `AuthenticateMcpServer`, `GetMcpServerStatus`, `RestartMcpServers`, `RemoveMcpAccount`, `RenameMcpAccount`, `SetMcpInstructions` |
| Інше | `request_box_help`, `SendFeedback` |

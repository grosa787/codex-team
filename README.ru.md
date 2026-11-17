# codex-team

[English](README.md) · **Русский**

Плагин для Claude Code: превращает OpenAI Codex в рабочих агентов под управлением Claude. Claude выступает архитектором и ревьюером: изучает проект, делит задачу, пишет задания, раздаёт агентам, сам проверяет каждый результат и возвращает правки. Реализуют Codex, субагенты Claude или оба вперемешку. Codex работает через локально установленный Codex CLI и твою подписку ChatGPT, ключ OpenAI API не нужен.

## Возможности

- **Codex как агент Claude.** `codex-team:codex-worker` принимает задание, запускает `codex exec` и возвращает отчёт Codex с `THREAD_ID`. Повторный вызов с `THREAD_ID:` продолжает ту же сессию Codex, поэтому правки идут с контекстом.
- **Один Workflow, любая смесь агентов.** План (Claude) → сборка параллельными волнами (исполнитель Codex или Claude → ревью Claude → раунд правок) → итоговая проверка (Claude). Исполнители: `codex`, `claude` или `mixed`. В панели Workflow (Claude Code CLI и Claude Desktop) каждый агент подписан моделью и уровнем размышления.
- **Живой каталог моделей.** Модели и уровни берутся из `codex debug models`, а не из жёсткого списка. Новая модель OpenAI доступна, как только её видит твой Codex CLI. Хук старта сессии сообщает Claude текущий список.
- **Маршрутизация по задачам.** Ты выбираешь, какая модель и уровень Codex идут на простые, обычные и сложные задачи, и какие модели не использовать. При первом запуске Claude спросит. Планировщик может изменить значение для конкретной задачи, но обязан объяснить причину; запрещённые модели отклоняются.
- **Слежение за новыми моделями.** Когда в каталоге появляется модель, Claude находит цены и бенчмарки, сообщает тебе и спрашивает, обновить ли маршрутизацию.
- **Учёт токенов Codex.** В каждом отчёте есть строка `TOKENS`; Workflow пишет токены по агентам и возвращает итоги по моделям; `codex-job.sh usage` суммирует все запуски.

## Требования

- [Claude Code](https://claude.com/claude-code) версии 2.1.275 или новее (CLI или Claude Desktop).
- [Codex CLI](https://github.com/openai/codex) в `PATH`, вход через ChatGPT: `codex login status` → «Logged in using ChatGPT».
- `jq`, `bash`, `git`.

## Установка

В Claude Code:

```
/plugin marketplace add grosa787/codex-team
/plugin install codex-team@codex-team
```

Или из терминала:

```bash
claude plugin marketplace add grosa787/codex-team
claude plugin install codex-team@codex-team
```

Плагин подключается в **новых** сессиях (агенты и хуки регистрируются при старте сессии). Перезапускать Claude Desktop не нужно, достаточно открыть новую сессию. Если репозиторий приватный, `git` должен быть авторизован в GitHub (например, `gh auth login`).

Проверка: в новой сессии спроси «какие модели Codex доступны?» или выполни `bash "<папка плагина>/scripts/codex-job.sh" models`.

## Использование

### Разовая задача обычными словами

> Сделай это через Codex: добавь пагинацию в API заказов и покрой тестами.

Claude использует `/codex-team:orchestrate`: изучает проект, делит работу на задачи с непересекающимися файлами, параллельно отправляет задания агентам Codex, читает настоящие диффы, запускает проверки и возвращает замечания в тот же тред Codex.

### Как Workflow

```
/codex-team:workflow
Задача:       что сделать, со всеми требованиями
Папка:        /абсолютный/путь/к/проекту     (по умолчанию: текущий проект)
Проверка:     npm test                       (по умолчанию: планировщик найдёт сам)
Исполнители:  codex | claude | mixed         (по умолчанию: codex)
Codex:        модель=<slug>, effort=<level>  (по умолчанию: твоя маршрутизация)
Claude:       модель=opus|sonnet|haiku|fable, effort=low|medium|high|xhigh|max
Параллельно:  3        Правок: 2
Ревью:        sonnet                         (модель агентов-ревьюеров)
```

Любое поле, кроме задачи, можно опустить. Свободный текст считается задачей. Этот же бланк Claude использует для запуска Workflow, поэтому у тебя и у Claude один формат.

### Первый запуск: маршрутизация

Если маршрутизации нет, Claude спросит, какую модель и уровень брать для каждого типа задач, и сохранит в `~/.config/codex-team/routing.json`:

```bash
bash "<папка плагина>/scripts/codex-job.sh" routing          # показать
bash "<папка плагина>/scripts/codex-job.sh" routing --ack    # отметить текущие модели каталога как известные
```

Пример: простые → дешёвая модель, обычные → сильная модель на `high`, сложные → она же на `xhigh`; дорогие модели в списке запрета.

## Состав

| Компонент | Имя | Что делает |
|---|---|---|
| Агент | `codex-team:codex-worker` | Передаёт одно задание Codex, ждёт, возвращает отчёт и `THREAD_ID`. Строки задания: `THREAD_ID:`, `MODEL:`, `EFFORT:`, `SANDBOX:`. |
| Навык | `/codex-team:orchestrate` | Claude как архитектор и ревьюер над агентами Codex. |
| Навык | `/codex-team:workflow` | Запускает `workflows/codex-team.js` по бланку. |
| Скрипт | `scripts/codex-job.sh` | `start`, `wait`, `log`, `cancel`, `list`, `models`, `routing`, `usage`. Задачи хранятся в `~/.cache/codex-team/jobs`. |
| Хук | SessionStart | Передаёт в сессию живой список моделей и твою маршрутизацию. |

### Аргументы Workflow

Обязательны `task`, `cwd` (абсолютный путь), `pluginRoot`, а также `routing` (вывод `codex-job.sh routing --json`), если не заданы оба `codexModel` и `codexEffort`. Необязательные: `check`, `executors`, `codexModel`, `codexEffort`, `claudeModel`, `claudeEffort`, `maxParallel` (3), `maxFixRounds` (2), `reviewModel`.

Из собственных скриптов Workflow:

```js
await workflow({scriptPath: '<папка плагина>/workflows/codex-team.js'}, {task, cwd, pluginRoot, routing})
// или смешивать агентов напрямую
agent(brief, {model: 'opus', effort: 'high'})                                   // Claude
agent('MODEL: <slug>\nEFFORT: <level>\n' + brief, {agentType: 'codex-team:codex-worker'})  // Codex
```

## Замечания и ограничения

- Codex работает с песочницей и подтверждениями из твоего `~/.codex/config.toml`, если задание не задаёт `SANDBOX:`. Проверь их перед запуском на важном проекте.
- Параллельные агенты делят одну рабочую папку; планировщик даёт им разные файлы. Для пересекающейся работы используй git worktree.
- Каждый агент Codex расходует лимиты Codex в твоём тарифе ChatGPT.
- Карточка Workflow в Claude Desktop не показывает токены; токены Codex видны в логе Workflow, отчётах и `codex-job.sh usage`.
- Workflow, запущенный в сессии, открытой до установки плагина, всё равно работает (читает описание агента с диска); прямой вызов `Agent` с `codex-team:codex-worker` требует новой сессии.

## Лицензия

MIT

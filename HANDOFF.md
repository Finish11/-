# ПульсСети — передача работы в новый чат

Файл-шпаргалка: состояние проекта, что уже сделано, что осталось, и готовый промпт
для продолжения в новом чате.

---

## 1. Готовый промпт (скопируйте целиком в новый чат)

```text
Продолжаем разработку проекта «ПульсСети» — Android-приложение (Capacitor + React + TS)
для проверки доступности сайтов и VPN-узлов в России.

Репозиторий: github.com/Finish11/-  •  ветка: arena/df6d80dd-repo  •  PR #2 открыт.
Текущее состояние: версия 1.3.8, коммит b824970, релиз на странице
https://github.com/Finish11/-/releases/tag/android-latest

Что важно знать сразу:
- Все UI-тексты — по-русски, тон спокойный и понятный. Мобильный первый (проверять на 390 px),
  десктоп вторичен.
- Любое изменение обязано проходить: npm run typecheck, npm run build, npm run build:demo.
  Для APK — workflow .github/workflows/android-apk.yml (сборка через gh workflow run).
- Показывайте diff/сводку по файлам, не дампите код целиком.
- Секреты (токены, ключи) спрашивайте у меня, поддельные значения не подставляйте.
- Ничего не выдумывать: если факт не проверен — так и писать, с датой проверки.
- Правила вердикта (WHITELIST_ACTIVE / TOTAL_JAMMING / DPI_THROTTLING / SEVERE_RESTRICTIONS /
  OPEN_INTERNET) и пороги узлов менять только с обоснованием.
- Замеры должны быть настоящими. Никаких «примерно так» и имитации в APK.

Текущие задачи (по приоритету):
1. Импорт подписки: ссылка https://oversub.cloud/YBgX9Jq8bVFkAmEh отдаёт ~1 МБ JSON
   конфига sing-box; после обновления парсер ищет узлы рекурсивно по всему JSON и делает
   повторные запросы с User-Agent v2rayNG / Clash Meta / Streisand. Нужно: если у меня
   всё ещё «нет узлов» — довести разбор, опираясь на то, как это делают v2rayNG, Clash Meta,
   Streisand, Happ, Hiddify. Парсер: src/lib/subscriptionParser.ts,
   загрузка: src/demo/realSubscription.ts, нативный HTTP: src/lib/nativeBridge.ts.
2. Настоящий VPN-туннель не реализован (нет VpnService + ядра sing-box/xray). Пока —
   честные per-server проверки. Если браться за туннель — только с честной оценкой объёма.
3. Довести оформление: акцентные темы, анимации, аккуратные состояния загрузки/ошибок,
   меньше визуального шума. Смотреть, как сделано у хороших продуктов, но не копировать.
4. Ускорение замера: сейчас 16 параллельных проб, 75 сайтов. Можно сжать каталог
   до показательных, не ломая вердикт.
5. Мелочи: игровой TCP-пинг (порт 9339) работает, но зависит от оператора; отчёт в
   уведомлении; фоновая проверка без foreground service живёт, пока Android не выгрузит WebView.

С чего начать: прочитать HANDOFF.md в корне репозитория, затем src/lib/appSettings.ts,
src/lib/nativeBridge.ts, src/lib/realScan.ts, src/lib/networkInfo.ts,
src/components/ScannerView.tsx, src/components/QuickPicks.tsx, src/components/UpdateCard.tsx,
src/lib/subscriptionParser.ts, android/app/src/main/java/ru/pulsenet/app/ApkUpdaterPlugin.java.

Работай на ветке arena/df6d80dd-repo, пуш только в неё, PR создавай из неё.
```

---

## 2. Что сделать в новом чате (по шагам)

1. Открыть Arena в том же репозитории `Finish11/-` и убедиться, что сессия создана
   на ветке `arena/df6d80dd-repo` (не на `main`).
2. Вставить промпт из раздела 1 первым сообщением.
3. Первым делом попросить: «прочитай HANDOFF.md и подтверди состояние».
4. Для работы с APK нужен GitHub-доступ — он уже настроен; если `gh`/`git` ругаются
   на авторизацию, переподключить GitHub в настройках Arena.
5. Если нужно проверить подписку — сразу дать агенту ссылку и текст ошибки из приложения
   (в ошибке печатается размер ответа и первые 120 символов — по ним видно формат).

---

## 3. Состояние проекта (на 5 ноября 2026)

- Версия `1.3.8`, коммит `b824970`, ветка `arena/df6d80dd-repo`, PR #2 открыт.
- Пакет `ru.pulsenet.app`, minSdk 24, targetSdk 36, `versionName` берётся из `package.json`,
  `versionCode` = номер запуска CI + 1000 (иначе Android отказывает в обновлении).
- Релиз: https://github.com/Finish11/-/releases/tag/android-latest
  APK: https://github.com/Finish11/-/releases/download/android-latest/pulsenet-debug.apk
- Подпись: постоянный debug-ключ `android/app/pulsenet-debug.p12` (PKCS12, alias и пароль
  `pulsenet`), подключён в `android/app/build.gradle` для debug и release — обновления
  ставятся поверх, без удаления приложения.
- `main` = `fa56318` (старая база, до 1.1.0).

### Архитектура в двух словах

- `src/main.tsx` — веб/прод-вход (ходит на `/api`).
- `src/main.demo.tsx` — вход, который использует **локальный API в браузере**
  (`src/demo/localApi.ts`); именно он собирается в APK (`npm run android:sync` →
  `build:demo`), поэтому в приложении нет внешнего сервера.
- Замеры в APK — настоящие: `src/lib/realScan.ts` через нативный HTTP
  (`src/lib/nativeBridge.ts`), 16 параллельных проб, пороги ok ≤ 1500 мс, slow ≤ 4000 мс.
- Симуляция отключена для нативных сборок (`isNativeApp()`), баннер демо-режима в APK скрыт.

### Ключевые файлы

| Файл | Зачем |
| --- | --- |
| `src/lib/appSettings.ts` | настройки (оператор, город, тип сети, режим проб, акцентная тема), localStorage + событие |
| `src/lib/networkInfo.ts` | определение сети: тип подключения, IP, провайдер, город, признак VPN |
| `src/lib/realScan.ts` | реальные пробы сайтов и вердикт |
| `src/lib/nativeBridge.ts` | нативный HTTP/замеры, `nativeGet` (с User-Agent), `tcpPing`, `mapLimit` |
| `src/lib/subscriptionParser.ts` | разбор подписок: base64, plain, Clash YAML, JSON/sing-box (рекурсивно) |
| `src/demo/realSubscription.ts` | импорт подписки: нативный HTTP → fetch → XHR, повторы с разными UA |
| `src/components/ScannerView.tsx` | главный экран: кнопка, прогресс, вердикт, чипы сети |
| `src/components/QuickPicks.tsx` | «Мои сервисы»: крупные карточки со статусом, пингом и игровым TCP-пингом |
| `src/components/SettingsSheet.tsx` | настройки: сеть, режим, темы, проверка обновлений (с ссылкой на APK) |
| `src/components/UpdateCard.tsx` | обновление в приложении: загрузка, установщик, запасной путь |
| `android/app/src/main/java/ru/pulsenet/app/ApkUpdaterPlugin.java` | download/status/install APK + `tcpProbe` (TCP 9339) |
| `.github/workflows/android-apk.yml` | сборка APK, versionName/versionCode, публикация в Releases |

### История версий

- 1.1.0 — быстрый выбор сервисов, карточка подписки, общий парсер (79/79), нативная
  загрузка подписки, обновление в приложении.
- 1.2.0 — реальные пробы, профиль сети, «Мои сервисы», настройки.
- 1.3.x — постоянная подпись и `versionCode`, детект VPN, устойчивый замер при смене вкладок,
  пинг в карточках, крупные карточки сервисов, sing-box подписки, удаление панели
  «Режим проверки», 16 параллельных проб, темы и анимации.

---

## 4. Открытые вопросы и известные ограничения

- **Подписка `oversub.cloud`** — проверяется только на устройстве (в песочнице нет доступа
  к этому домену). Нужен текст ошибки из приложения, если узлы всё ещё не находятся.
- **VPN-туннеля нет**: sing-box/xray + `VpnService` не реализованы. Проверки узлов и
  игрового сервера — реальные, подключения — нет.
- **Фоновая проверка** живёт, пока Android не выгрузит WebView; для гарантии нужен
  foreground service.
- **Игровой пинг** — TCP 9339 до `game.brawlstars.com`; если оператор режет порт,
  «недоступен» не означает плохой узел.
- **Логи CI** из песочницы недоступны (заблокирован хост архива логов). Ошибки сборки
  ищутся бисекцией по коммитам; так уже был найден сбой Java-правки установщика.

---

## 5. Грабли окружения (проверено на практике)

- `npm ci` без `--ignore-scripts`, затем при необходимости
  `node-gyp rebuild --nodedir=/usr/local` для `better-sqlite3` (иначе ABI-ошибка).
- Перед коммитом всегда `git fetch origin` и `git reset --soft origin/arena/df6d80dd-repo`,
  иначе push отклоняется.
- `gh pr edit` падает на GraphQL — править PR через `gh api -X PATCH repos/Finish11/-/pulls/2`.
- `gh run download` в песочнице не работает: бинарники раздаются через `gh release create`.
- В песочнице нет `java`/`keytool` — keystore создавался через `openssl`.
- `npx tsx` требует абсолютный путь в импорте.
- Нативные вещи (пробы, установщик, TCP, уведомления) проверяются только на телефоне.

# AGENTS.md — sbe-lims-mobile (ЛИМС Мобайл)

Мобильный клиент lab-service для планшетов испытателей: сканирование QR (образец
или оборудование) → форма ввода → отправка на сервер. Часть общего проекта
«QR → мобильный ввод результатов» вместе с sbe-requests (генерация/печать QR) и
sbe-lims (показ QR в заявке/на оборудовании) — см.
`docs/superpowers/specs/2026-08-27-sbe-lims-mobile-qr-design.md` в корне вольта
(`.obsidian/plugins/docs/superpowers/specs/`) и план там же
(`docs/superpowers/plans/2026-08-27-sbe-lims-mobile-qr-plan.md`).

**Расположение (правило 2026-08-26)**: исходники + git-репо — здесь
(`C:\Obsidian\mailers\mobile\sbe-lims-mobile\`). Собранные
`manifest.json`/`main.js`/`styles.css` копируются в
`.obsidian/plugins/sbe-lims-mobile/` (live-установка Obsidian, без git и без
исходников). Путь к sbe-core — относительный
`../../../.obsidian/plugins/sbe-core/src/...` (из `src/main.ts`; на уровень
глубже, из `src/services/`/`src/ui/`, — на один `../` больше).

## Структура

- `src/main.ts` — `SbeLimsMobilePlugin`: настройки (`apiUrl`), регистрация вьюхи +
  команды, `registerObsidianProtocolHandler('sbe-lims-mobile', ...)` (диплинк),
  announceUpdate на смену версии.
- `src/ui/mobile-lims-view.ts` — `MobileLimsView` (ItemView): главный экран (ручной
  резервный ввод) + экран результатов испытания + экран калибровки оборудования
  (с промежуточным выбором метода при 2+ привязанных).
- `src/services/lims-mobile.service.ts` — `LimsMobileService`: узкое подмножество
  вызовов lab-service (тот же паттерн, что `sbe-lims/src/services/sync.service.ts` —
  `getToken` через мост ЦУП, `assertOk` на 401/403/404, multipart для калибровки).
- `src/types.ts` — тримминг типов lab-service, реально нужных мобильному вводу (не
  общий пакет с sbe-lims — намеренное маленькое дублирование, см. спеку «Границы»).
- `src/styles.css` — классы `tn-lm-*` поверх дизайн-системы sbe-core.

## Ключевые решения

- **Без своего экрана входа.** Чистый потребитель `getService('sbe-apstore')` —
  как и десктопный `sbe-lims`. Если не авторизован — обычная ошибка от сервера
  (401 через `assertOk`) с текстом «войдите в ЦУП Мобайл», без дублирования UI входа.
- **QR — просто указатель на ресурс**, без токена/подписи: id ничего не даёт без
  прав, доступ проверяет сервер по JWT сканирующего испытателя. Оба вида QR
  (заявка и оборудование) — постоянные, не одноразовые.
- **Приём диплинка**: `registerObsidianProtocolHandler` сохраняет `pendingDeepLink`
  неявно — сразу вызывает `activateView()` → `view.openResult(id)`/`openCalibrate(id)`,
  работает одинаково на холодном старте и когда Obsidian уже открыт в фоне.
- **Пустой `operator_form`/`calibration_operator_form` не блокирует ввод** — fallback
  на полный список `input_parameters`/`calibration_attributes` метода (тот же
  принцип, что у аналогичного fallback в десктопном конфигураторе).
- **Ошибка отправки формы не стирает введённые значения** — только кнопка
  «Повторить» поверх той же формы (офлайн-очередь — вне scope v1, по решению
  из спеки).
- **Бэкенд lab-service не менялся** — все вызовы идут на уже существующие,
  задеплоенные эндпоинты (`GET/POST /requests/{id}`, `GET /methods`,
  `GET /equipment`, `GET /equipment/{id}/methods`,
  `POST /equipment/{id}/calibrations`).

## История работ

### 2026-08-27 — v0.1.0 (создание)

- Плагин создан по дизайну `2026-08-27-sbe-lims-mobile-qr-design.md`, план —
  `2026-08-27-sbe-lims-mobile-qr-plan.md` (по прямой команде пользователя
  «начинай», без отдельного окна подтверждения на реализацию).
- Согласовано с пользователем в диалоге по брейнштормингу: отдельный новый плагин
  (не мобильный режим внутри sbe-lims); сканирование через `obsidian://`-диплинк
  и штатную камеру телефона (не свой сканер на `jsQR`/`getUserMedia` — непроверенный
  доступ к камере внутри Obsidian mobile); QR — постоянные (этикетка заявки/прибора,
  не одноразовая сессия); печать листа QR — пакетный выбор в sbe-requests.
- `npx tsc --noEmit` EXIT=0; `npm run build` OK.
- Реестр: запись `sbe-lims-mobile` + SHA-256 хеши в `registry.json`;
  `community-plugins.json` дополнен. Репозиторий `Epyur/sbe-lims-mobile` (public),
  init-коммит, пуш на main (создание репо потребовало отдельного подтверждения
  пользователя — auto-mode классификатор блокирует `gh repo create` по умолчанию).
- ⚠️ **Реестр на сервере (`/opt/mailers/www/registry.json`) синхронизировать
  отдельно** — не сделано в этой сессии (нужен SSH на VDS, за отдельным
  подтверждением). Без этого мини-магазин `sbe-mobile` на планшете не увидит
  новый плагин по сети — только реестр в `sbe-apstore-registry` (GitHub) обновлён.
- ⚠️ **E2E на Android-планшете (диплинк + камера + установка через хаб) — за
  пользователем** — главный оставшийся технический риск, см. спеку раздел 9.

## Статистика ошибок и отступлений

- Нарушений правил нет: 0 `any`, 0 `fetch`, 0 bare `setTimeout`, 0 инлайн-стилей,
  все `catch(e: unknown)` + `errorMessage()`.
- Сборка и типы — без ошибок и предупреждений.

## Правила

- `catch(e: unknown)` + `errorMessage()` (sbe-core); `requestUrl()`;
  `window.setTimeout()`; без `any`; CSS-классы `tn-*`; UI на русском; автор —
  Полищук Евгений (polishchuk@tn.ru).

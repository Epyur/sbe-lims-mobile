# specification.md — sbe-lims-mobile (ЛИМС Мобайл)

## 1. Идентификация

- `manifest.id`: `sbe-lims-mobile`
- Имя: ЛИМС Мобайл
- Автор: Полищук Евгений (polishchuk@tn.ru)
- Зависимости: **runtime** — сервер `lab-service` (`/api/lab/*`), мост `window.SBE`
  (`sbe-apstore`, публикуется десктопным ЦУП или хабом `sbe-mobile`);
  **build** — `sbe-core`.

## 2. Роль

Мобильный клиент lab-service: сканирование QR (наклеенного на образец или на
оборудование) → форма ввода → отправка на сервер. **Чистый потребитель авторизации**
(`getService('sbe-apstore').auth.getToken('lab')`, тот же `app_id`, что у десктопного
`sbe-lims`) — своего экрана входа нет, как и у любого другого plugin-service
потребителя в этой архитектуре. Не публикует собственный сервис в мост.

## 3. Формат диплинка

QR-коды генерируются в `sbe-requests` (заявка) и `sbe-lims` (заявка повторно +
оборудование) — маленький хелпер `buildMobileDeepLink` (дублируется в обоих
репозиториях, не общий пакет):

```
obsidian://sbe-lims-mobile?vault=<имя-волта>&action=result&request=<id>
obsidian://sbe-lims-mobile?vault=<имя-волта>&action=calibrate&equipment=<id>
```

Без токена/подписи — id ничего не даёт без прав; доступ проверяет сервер по JWT
сканирующего испытателя (`requireLabAccess`/`requireLabRead` в lab-service, как и
везде в проекте).

## 4. Функциональность v1

- **Главный экран**: подсказка «сканируйте QR» + ручной резервный ввод (переключатель
  Заявка/Оборудование, текстовое поле номера/кода, кнопка «Открыть») — клиентский
  фильтр `GET /requests`/`GET /equipment`, без отдельного серверного поиска.
- **Экран «Результаты испытания»** (`action=result`): `GET /requests/{id}` →
  `GET /methods` (найти по `method_id`) → форма по `operator_form.fields`; тип инпута —
  по `data_type` найденного атрибута в `input_parameters` (`int`/`float` → number,
  `date`/`time` → date/time picker, `text` → текст, `photo` — вне scope v1, поле
  пропускается). Пустой `operator_form.fields` → fallback на весь список
  `input_parameters`. Отправка — `POST /requests/{id}/results` (без `series_num` —
  сервер сам берёт следующий свободный).
- **Экран «Калибровка оборудования»** (`action=calibrate`): `GET /equipment/{id}/methods`
  → 0 методов — ошибка; 1 — сразу форма; 2+ — экран выбора метода. Форма — по
  `calibration_operator_form.fields`/`calibration_attributes` (та же логика типов и
  fallback). Отправка — `POST /equipment/{id}/calibrations` (multipart/form-data, без
  файла — только текстовые поля + `values`).
- **Устойчивость к сбою сети**: при ошибке отправки значения на экране не теряются,
  доступна кнопка повтора (без автосохранения в фон — офлайн-очередь вне scope v1).

## 5. Данные (`data.json`)

```ts
{
  "apiUrl": "https://epyur.fvds.ru",
  "lastAnnouncedVersion": "0.1.0"
}
```

Email/устройство/ключ — не хранятся здесь, берутся из уже авторизованного ЦУП
(десктопного или `sbe-mobile`) через мост.

## 6. Ошибки

- 401 → «Ключ доступа недействителен. Войдите в ЦУП Мобайл (Аккаунт) и повторите.»
- 403 → «Нет прав доступа к ЛИМС. Обратитесь к администратору лаборатории.»
- 404 → «Не найдено — проверьте QR или введённый номер.»
- Сеть/таймаут при отправке формы — значения остаются на экране, кнопка «Повторить».

## 7. Сборка и проверка

- `npm install` → `npm run build` (esbuild + `build.onEnd`: tokens/components sbe-core +
  собственные стили) → `npx tsc --noEmit` EXIT=0.
- Релизные файлы: `main.js`, `styles.css`, `manifest.json`.
- Бэкенд `lab-service` не менялся — все вызовы идут на уже существующие эндпоинты.
- **Главный оставшийся риск — реальная проверка на Android-планшете** (за
  пользователем): печать тестового QR → скан штатной камерой → Android открывает
  Obsidian по `obsidian://sbe-lims-mobile?...` → обработчик срабатывает.

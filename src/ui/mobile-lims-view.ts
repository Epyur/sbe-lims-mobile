import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeLimsMobilePlugin from '../main';
import { errorMessage } from '../../../../.obsidian/plugins/sbe-core/src/utils/errors';
import {
  CALIBRATION_SYSTEM_FIELDS, RESULT_SYSTEM_FIELDS,
} from '../types';
import type {
  AttributeDataType, CalibrationAttribute, ComparisonOperator, EquipmentMethodLink, MobileEquipment, MobileMethod,
  MobileResult, OperatorFormField,
} from '../types';

export const MOBILE_LIMS_VIEW_TYPE = 'sbe-lims-mobile-view';

/** "YYYY-MM-DD" по ЛОКАЛЬНОЙ дате устройства (2026-08-28, WP3b) — испытатель
 * физически рядом с образцом, локальное время устройства и есть время
 * эксперимента, часовой пояс сервера не участвует в сравнении "тот же день". */
function todayLocalDateString(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Локальная календарная дата ISO-таймстампа (у него есть часовой пояс, "Z"/±HH:MM)
 * — НЕ применять к exp_date/report_date самим по себе: это уже голая "YYYY-MM-DD"
 * без времени, гнать её через Date() рискованно (UTC-полночь при парсинге строки
 * без времени может съехать на соседний день после конвертации в локальный часовой
 * пояс устройства). Только для created_at (реальный timestamp с сервера). */
function localDateOfTimestamp(iso: string): string {
  const d = new Date(iso);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Сравнение для visibility.conditions (2026-08-28, WP3c) — НЕ переиспользует
 * DSL/классификацию: те выполняются только на сервере (Go), тут нужна живая
 * клиентская проверка при каждом изменении формы, поэтому — новая маленькая
 * чистая функция. `==`/`!=` — строковое сравнение; остальные — числовое,
 * NaN с любой стороны → условие ложно (не выбрано/не число). */
function compareFieldCondition(actual: unknown, operator: ComparisonOperator, expected: string): boolean {
  if (operator === '==') return String(actual ?? '') === expected;
  if (operator === '!=') return String(actual ?? '') !== expected;
  const a = Number(actual);
  const b = Number(expected);
  if (Number.isNaN(a) || Number.isNaN(b)) return false;
  if (operator === '<') return a < b;
  if (operator === '<=') return a <= b;
  if (operator === '>') return a > b;
  return a >= b; // '>='
}

/** Пересчитывает видимость всех полей формы с visibility (2026-08-28, WP3c) —
 * скрывает/показывает через CSS display, DOM/введённое значение НЕ уничтожается
 * (см. renderResultForm buildSubmitValues — скрытые поля просто не попадают в
 * payload, пока скрыты, но сам ввод остаётся, если условие снова станет true). */
function updateFieldVisibility(form: HTMLElement, fields: OperatorFormField[], values: Record<string, unknown>): void {
  for (const field of fields) {
    if (!field.visibility) continue;
    const row = form.querySelector<HTMLElement>(`[data-attribute-id="${CSS.escape(field.attribute_id)}"]`);
    if (!row) continue;
    const { logic, conditions } = field.visibility;
    if (conditions.length === 0) { row.style.display = ''; continue; }
    const results = conditions.map(c => compareFieldCondition(values[c.field], c.operator, c.value));
    const visible = logic === 'and' ? results.every(Boolean) : results.some(Boolean);
    row.style.display = visible ? '' : 'none';
  }
}

type Screen =
  | { kind: 'home' }
  | { kind: 'result'; requestId: number }
  | { kind: 'calibrate'; equipmentId: number };

/** Вьюха «ЛИМС Мобайл»: главный экран (ручной резервный ввод) + два сценария,
 * оба доступны и через obsidian://-диплинк (см. main.ts handleDeepLink), и
 * вручную с главного экрана. */
export class MobileLimsView extends ItemView {
  plugin: SbeLimsMobilePlugin;
  private screen: Screen = { kind: 'home' };

  constructor(leaf: WorkspaceLeaf, plugin: SbeLimsMobilePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return MOBILE_LIMS_VIEW_TYPE;
  }

  getDisplayText(): string {
    return 'ЛИМС Мобайл';
  }

  getIcon(): string {
    return 'flask-conical';
  }

  async onOpen(): Promise<void> {
    this.contentEl.addClass('tn-lm-container');
    this.render();
  }

  /** label (2026-08-28) — для списка «Последние заявки» на главном экране;
   * опционален, т.к. openResult вызывается и там, где номера ещё нет под рукой
   * (падает на "#<id>" в этом случае). */
  openResult(requestId: number, label?: string): void {
    this.screen = { kind: 'result', requestId };
    this.recordRecentRequest(requestId, label || `#${requestId}`);
    this.render();
  }

  /** Последние заявки (2026-08-28) — быстрый возврат без повторного ввода
   * номера, см. renderHome. Дедуп + move-to-front (заявка, уже бывшая в
   * списке, просто поднимается наверх, не дублируется), максимум 3. Хранится
   * локально на устройстве (MobileLimsSettings.recentRequests, saveData). */
  private recordRecentRequest(id: number, label: string): void {
    const settings = this.plugin.settings;
    settings.recentRequests = [{ id, label }, ...settings.recentRequests.filter(r => r.id !== id)].slice(0, 3);
    void this.plugin.saveSettings();
  }

  openCalibrate(equipmentId: number): void {
    this.screen = { kind: 'calibrate', equipmentId };
    this.render();
  }

  private render(): void {
    const el = this.contentEl;
    el.empty();
    const topbar = el.createDiv({ cls: 'tn-lm-topbar' });
    topbar.createDiv({ cls: 'tn-lm-title', text: 'ЛИМС Мобайл' });
    if (this.screen.kind !== 'home') {
      const back = topbar.createEl('button', { text: '← Главная', cls: 'tn-btn tn-btn-ghost' });
      back.addEventListener('click', () => {
        this.screen = { kind: 'home' };
        this.render();
      });
    }
    const body = el.createDiv({ cls: 'tn-lm-body' });
    if (this.screen.kind === 'home') this.renderHome(body);
    else if (this.screen.kind === 'result') void this.renderResultScreen(body, this.screen.requestId);
    else void this.renderCalibrateScreen(body, this.screen.equipmentId);
  }

  // ---- Главный экран: ручной резервный ввод (без сканирования) ----

  private renderHome(body: HTMLElement): void {
    body.createDiv({
      cls: 'tn-lm-hint',
      text: 'Отсканируйте QR камерой/любым QR-сканером телефона — он покажет номер заявки ' +
        'или код оборудования. Скопируйте номер и вставьте в поле ниже.',
    });

    // Последние заявки (2026-08-28) — быстрый возврат без повторного ввода
    // номера; испытатель может параллельно готовить несколько заявок, номер
    // каждый раз перепечатывать неудобно. Только если список не пуст — на
    // первом запуске плагина/после очистки данных секции просто нет.
    if (this.plugin.settings.recentRequests.length > 0) {
      body.createEl('h4', { text: 'Последние заявки' });
      const recentRow = body.createDiv({ cls: 'tn-lm-flex tn-lm-mb8' });
      for (const r of this.plugin.settings.recentRequests) {
        const btn = recentRow.createEl('button', { text: r.label, cls: 'tn-btn tn-btn-ghost' });
        btn.addEventListener('click', () => this.openResult(r.id, r.label));
      }
    }

    body.createEl('h4', { text: 'Открыть по номеру' });
    let mode: 'request' | 'equipment' = 'request';
    const modeRow = body.createDiv({ cls: 'tn-lm-flex tn-lm-mb8' });
    const reqBtn = modeRow.createEl('button', { text: 'Заявка', cls: 'tn-btn tn-btn-primary' });
    const eqBtn = modeRow.createEl('button', { text: 'Оборудование', cls: 'tn-btn tn-btn-ghost' });

    const input = body.createEl('input', {
      attr: { type: 'text', placeholder: 'Вставьте номер из QR или введите вручную (287/2026, код оборудования)' },
      cls: 'tn-lm-input tn-lm-mb8',
    });
    const openBtn = body.createEl('button', { text: 'Открыть', cls: 'tn-btn tn-btn-primary' });
    const errDiv = body.createDiv({ cls: 'tn-lm-error tn-lm-mt8' });

    const setMode = (next: 'request' | 'equipment') => {
      mode = next;
      reqBtn.removeClass(mode === 'request' ? 'tn-btn-ghost' : 'tn-btn-primary');
      reqBtn.addClass(mode === 'request' ? 'tn-btn-primary' : 'tn-btn-ghost');
      eqBtn.removeClass(mode === 'equipment' ? 'tn-btn-ghost' : 'tn-btn-primary');
      eqBtn.addClass(mode === 'equipment' ? 'tn-btn-primary' : 'tn-btn-ghost');
    };
    reqBtn.addEventListener('click', () => setMode('request'));
    eqBtn.addEventListener('click', () => setMode('equipment'));

    openBtn.addEventListener('click', () => {
      void (async () => {
        errDiv.setText('');
        const q = input.value.trim();
        if (!q) return;
        openBtn.setAttr('disabled', 'true');
        try {
          if (mode === 'request') {
            const requests = await this.plugin.syncService.listRequests();
            const found = requests.find(r =>
              `${r.number_seq}/${r.number_year}` === q || r.customer_number === q || r.lab_number === q);
            if (!found) { errDiv.setText('Заявка не найдена по этому номеру.'); return; }
            this.openResult(found.id, found.customer_number || found.lab_number || `#${found.id}`);
          } else {
            const equipment = await this.plugin.syncService.listEquipment();
            const qLower = q.toLowerCase();
            const found = equipment.find(e =>
              e.code.toLowerCase() === qLower || e.name.toLowerCase().includes(qLower));
            if (!found) { errDiv.setText('Оборудование не найдено по коду/названию.'); return; }
            this.openCalibrate(found.id);
          }
        } catch (e: unknown) {
          errDiv.setText(errorMessage(e));
        } finally {
          openBtn.removeAttribute('disabled');
        }
      })();
    });
  }

  // ---- Экран «Результаты испытания» ----

  /** Одно окно на всю работу с сериями заявки (2026-08-28, WP3a; переработано в тот
   * же день по прямой жалобе на живом использовании): раньше переключение между
   * сериями требовало выйти из формы на отдельный экран-список и войти заново —
   * "много лишних действий", когда испытатель в процессе работы должен часто
   * переключаться между сериями (готовит следующий эксперимент, пока не закрыл
   * текущий). Теперь переключатель серий и «➕ Добавить серию» — прямо в этом окне,
   * рядом с «Отправить результаты», без единого перехода между экранами.
   * Переключение серии = неявное сохранение текущей, если её меняли (см. switchTo
   * ниже) — испытатель не должен терять введённое, просто заглянув в другую серию. */
  private async renderResultScreen(body: HTMLElement, requestId: number): Promise<void> {
    const status = body.createDiv({ cls: 'tn-lm-meta', text: 'Загрузка заявки…' });
    let method: MobileMethod | undefined;
    let requestLabel = '';
    let allSeries: MobileResult[] = [];
    let mainEquipmentIds: number[] = [];
    let equipmentList: MobileEquipment[] = [];
    try {
      const [request, methods, results, methodEquipment, equipment] = await Promise.all([
        this.plugin.syncService.getRequest(requestId),
        this.plugin.syncService.listMethods(),
        this.plugin.syncService.listResults(requestId),
        this.plugin.syncService.listAllMethodEquipment(),
        this.plugin.syncService.listEquipment(),
      ]);
      requestLabel = request.customer_number || request.lab_number || `#${request.id}`;
      method = methods.find(m => m.id === request.method_id);
      if (!method) {
        status.setText('');
        body.createDiv({ cls: 'tn-lm-error', text: 'Метод испытаний этой заявки не найден.' });
        return;
      }
      allSeries = results.filter(r => !r.is_statistical_row).sort((a, b) => a.series_num - b.series_num);
      // Селектор оборудования (2026-08-28, WP1) показываем только когда у метода
      // НЕСКОЛЬКО единиц "Основного" оборудования (иначе неоднозначно, какую
      // калибровочную кривую брать для interpolate() — см. lab-service
      // calibration_curve.go); при ровно одной единице сервер резолвит её сам.
      mainEquipmentIds = methodEquipment.filter(l => l.method_id === method!.id && l.role === 'main').map(l => l.equipment_id);
      equipmentList = equipment;
    } catch (e: unknown) {
      status.setText('');
      this.renderRetriableError(body, errorMessage(e), () => {
        body.empty();
        void this.renderResultScreen(body, requestId);
      });
      return;
    }
    status.remove();

    body.createEl('h3', { text: `Заявка ${requestLabel}` });
    body.createDiv({ cls: 'tn-lm-meta tn-lm-mb8', text: `Метод: ${method.code}${method.name ? ' — ' + method.name : ''}` });

    const switcherEl = body.createDiv({ cls: 'tn-lm-flex tn-lm-mb8' });
    const formHost = body.createDiv();

    let currentSeriesNum: number | undefined = allSeries.length > 0 ? allSeries[allSeries.length - 1].series_num : undefined;
    /** Заполняется redrawForm() при каждой перерисовке формы — сохранение ТЕКУЩЕЙ
     * открытой серии как явный сабмит; используется переключателем серий ниже. */
    let currentSave: (() => Promise<number | null>) | undefined;
    let currentIsDirty: (() => boolean) | undefined;

    // Системные поля (дата/условия среды) для НОВОЙ серии (2026-08-28, WP3b) —
    // показываются только если это первая серия заявки или день изменился с
    // последней серии (exp_date, фоллбэк на created_at) — испытания одной
    // заявки могут идти в разные дни с разными условиями среды, но если это
    // тот же день, повторно спрашивать нечего. Вычисляется ОДИН раз при входе
    // в заявку — день не меняется, пока открыт экран. Не влияет на правку УЖЕ
    // существующей серии — там системные поля показываются всегда (см.
    // renderResultForm), это правило только про создание новой.
    const lastSeries = allSeries.length > 0 ? allSeries[allSeries.length - 1] : undefined;
    const lastSeriesDay = lastSeries
      ? (typeof lastSeries.values.exp_date === 'string' && lastSeries.values.exp_date
        ? lastSeries.values.exp_date
        : localDateOfTimestamp(lastSeries.created_at))
      : undefined;
    const shouldShowSystemFieldsForNewSeries = !lastSeriesDay || lastSeriesDay !== todayLocalDateString();

    const refreshSeries = async (): Promise<void> => {
      try {
        const results = await this.plugin.syncService.listResults(requestId);
        allSeries = results.filter(r => !r.is_statistical_row).sort((a, b) => a.series_num - b.series_num);
      } catch (e: unknown) {
        console.warn('ЛИМС Мобайл: не удалось обновить список серий:', errorMessage(e));
      }
    };

    const redrawSwitcher = (): void => {
      switcherEl.empty();
      for (const s of allSeries) {
        const pillWrap = switcherEl.createDiv({ cls: 'tn-lm-flex' });
        const pill = pillWrap.createEl('button', {
          text: `Серия ${s.series_num}`,
          cls: s.series_num === currentSeriesNum ? 'tn-btn tn-btn-primary' : 'tn-btn tn-btn-ghost',
        });
        pill.addEventListener('click', () => { void switchTo(s.series_num); });
        const delBtn = pillWrap.createEl('button', { text: '🗑', cls: 'tn-btn tn-btn-ghost' });
        delBtn.addEventListener('click', () => {
          void (async () => {
            if (!window.confirm(`Удалить серию ${s.series_num}? Следующие серии будут перенумерованы.`)) return;
            try {
              await this.plugin.syncService.deleteResultSeries(requestId, s.series_num);
              new Notice('Серия удалена');
              await refreshSeries();
              if (currentSeriesNum === s.series_num) {
                currentSeriesNum = allSeries.length > 0 ? allSeries[allSeries.length - 1].series_num : undefined;
              } else if (currentSeriesNum !== undefined && currentSeriesNum > s.series_num) {
                // Сервер перенумеровал все последующие серии на −1 (см. lab-service
                // results.go handleDeleteResultSeries) — синхронно сдвигаем указатель.
                currentSeriesNum -= 1;
              }
              redrawSwitcher();
              redrawForm();
            } catch (e: unknown) {
              new Notice(`Ошибка: ${errorMessage(e)}`);
            }
          })();
        });
      }
    };

    const redrawForm = (): void => {
      formHost.empty();
      const existing = allSeries.find(s => s.series_num === currentSeriesNum);
      const api = this.renderResultForm(
        formHost, requestId, method!, currentSeriesNum, existing, mainEquipmentIds, equipmentList,
        shouldShowSystemFieldsForNewSeries,
        {
          onAddNew: () => { void switchTo(undefined); },
          onSeriesSaved: (savedNum) => {
            void (async () => {
              await refreshSeries();
              currentSeriesNum = savedNum;
              redrawSwitcher();
            })();
          },
        },
      );
      currentSave = api.save;
      currentIsDirty = api.isDirty;
    };

    /** Переключение на другую серию/на новую — сначала неявно сохраняет текущую
     * форму, если её меняли (те же данные, что «Отправить результаты»). Если
     * сохранение не удалось (ошибка валидации/сети) — переключение отменяется,
     * ошибка уже показана в форме, испытатель остаётся на месте и может исправить. */
    const switchTo = async (target: number | undefined): Promise<void> => {
      if (target === currentSeriesNum) return;
      if (currentIsDirty?.() && currentSave) {
        const saved = await currentSave();
        if (saved === null) return;
      }
      currentSeriesNum = target;
      redrawSwitcher();
      redrawForm();
    };

    redrawSwitcher();
    redrawForm();

    // «Завершить испытания» — просто закрывает экран, без смены статуса заявки
    // (решение пользователя, WP3a); перед закрытием так же неявно сохраняет
    // текущую серию, если её меняли, — та же логика, что у switchTo.
    const doneBtn = body.createEl('button', { text: '✅ Завершить испытания', cls: 'tn-btn tn-btn-ghost tn-lm-mt8' });
    doneBtn.addEventListener('click', () => {
      void (async () => {
        if (currentIsDirty?.() && currentSave) {
          const saved = await currentSave();
          if (saved === null) return;
        }
        this.screen = { kind: 'home' };
        this.render();
      })();
    });
  }

  /** Форма ввода одной серии — рендерится внутри renderResultScreen (см. выше).
   * Возвращает save()/isDirty() наружу, чтобы переключатель серий мог неявно
   * сохранить форму перед переходом на другую серию. */
  private renderResultForm(
    body: HTMLElement, requestId: number, method: MobileMethod, initialSeriesNum: number | undefined,
    existingSeries: MobileResult | undefined, mainEquipmentIds: number[], equipmentList: MobileEquipment[],
    shouldShowSystemFieldsForNewSeries: boolean,
    callbacks: { onAddNew: () => void; onSeriesSaved: (seriesNum: number) => void },
  ): { save: () => Promise<number | null>; isDirty: () => boolean } {
    let seriesNum = initialSeriesNum;
    let dirty = false;
    const titleEl = body.createDiv({
      cls: 'tn-lm-meta tn-lm-mb8', text: seriesNum !== undefined ? `Серия ${seriesNum}` : 'Новая серия',
    });

    // Hash от прибора (2026-08-28, WP3d — последний некодированный кусочек:
    // буфер/claim на сервере уже полностью готов и задеплоен, см.
    // lab-service/AGENTS.md "Буфер результатов приборов"). Испытатель
    // переписывает hash с экрана/QR прибора (TDT Reader и т.п.) сюда — сервер
    // атомарно заявляет буфер по hash и домешивает его values В values этой
    // серии (вручную введённое приоритетнее, см. handleCreateResult); поле
    // необязательное — методы без прибора его просто не трогают.
    const hashRow = body.createDiv({ cls: 'tn-lm-field' });
    hashRow.createEl('label', { cls: 'tn-lm-label', text: 'Hash от прибора (опционально)' });
    const hashInput = hashRow.createEl('input', {
      attr: { type: 'text', placeholder: 'Вставьте hash с экрана/QR прибора' }, cls: 'tn-lm-input',
    });
    hashInput.addEventListener('input', () => { dirty = true; });

    const attrById = new Map(method.input_parameters.map(a => [a.id, a] as const));
    // Системные поля (2026-08-27; per-series с 2026-08-28, WP3b) — те же id, что
    // report_date/samples_in_date/exp_date/amb_temp/amb_pres/amb_moist; попадают
    // в форму, только если админ явно добавил их в operator_form.fields
    // конфигуратора (см. sbe-lims OPERATOR_FORM_SYSTEM_FIELDS). Раньше хранились
    // отдельно от values (колонки requests, общие на всю заявку) — теперь лежат
    // прямо В values серии (сервер сам это делает, см. lab-service
    // handleCreateResult), клиент шлёт их теми же именованными полями тела
    // запроса, что и раньше (см. doSave ниже) — просто читает их обратно из
    // ОДНОГО и того же values при предзаполнении правки, без отдельного места.
    const systemById = new Map(RESULT_SYSTEM_FIELDS.map(s => [s.id, s] as const));
    const fields: OperatorFormField[] = method.operator_form.fields.length > 0
      ? method.operator_form.fields
      : method.input_parameters.map(a => ({ attribute_id: a.id, label: a.name, required: false }));

    // Разложить existingSeries.values по двум клиентским корзинам — системные
    // поля отдельно (systemValues), остальное — обычные атрибуты метода
    // (values); на wire эти два бакета до сих пор сериализуются по-разному
    // (см. doSave: report_date и т.п. — отдельные именованные поля тела
    // запроса, values — JSONB атрибутов), хотя сервер хранит их вместе.
    const values: Record<string, unknown> = {};
    const systemValues: Record<string, unknown> = {};
    if (existingSeries) {
      for (const [k, v] of Object.entries(existingSeries.values)) {
        (systemById.has(k) ? systemValues : values)[k] = v;
      }
    }
    // Показ системных полей для НОВОЙ серии (2026-08-28, WP3b) — только если день
    // изменился с последней серии (см. renderResultScreen); при правке
    // СУЩЕСТВУЮЩЕЙ серии — всегда, это её собственные уже сохранённые значения.
    const showSystemFields = existingSeries !== undefined || shouldShowSystemFieldsForNewSeries;
    // Дефолт "сегодня" для дат — только когда поле реально показывается для
    // НОВОЙ серии (не при правке — там значение уже есть или его сознательно
    // не было). amb_temp/amb_pres/amb_moist — без дефолта, нет осмысленного.
    if (showSystemFields && !existingSeries) {
      const today = todayLocalDateString();
      systemValues.report_date = today;
      systemValues.exp_date = today;
    }
    const form = body.createDiv({ cls: 'tn-lm-form' });
    // recomputeVisibility определяется НИЖЕ (после рендера полей), но
    // вызывается только из этих обработчиков — к моменту первого реального
    // события форма уже полностью отрисована (см. redrawForm/switchTo).
    form.addEventListener('input', () => { dirty = true; recomputeVisibility(); });
    form.addEventListener('change', () => { dirty = true; recomputeVisibility(); });
    let hasFields = false;
    for (const field of fields) {
      const sys = systemById.get(field.attribute_id);
      if (sys) {
        if (!showSystemFields) continue;
        hasFields = true;
        this.renderFormField(form, { ...field, label: field.label || sys.label }, sys.data_type, systemValues);
        continue;
      }
      const attr = attrById.get(field.attribute_id);
      if (attr && attr.data_type === 'photo') continue; // вне scope v1
      hasFields = true;
      this.renderFormField(form, field, attr?.data_type || 'text', values, attr?.options);
    }
    if (!hasFields) {
      body.createDiv({ cls: 'tn-lm-meta', text: 'Для этого метода не настроены поля ввода — обратитесь к администратору.' });
      return { save: async () => null, isDirty: () => false };
    }
    // Условная видимость (2026-08-28, WP3c) — стартовое состояние сразу после
    // рендера (дефолт другого поля мог уже определить видимость), затем живой
    // пересчёт на каждое изменение формы (тот же делегированный слушатель, что
    // уже помечает форму "грязной" — см. ниже).
    const recomputeVisibility = (): void => {
      updateFieldVisibility(form, fields, { ...systemValues, ...values });
    };
    recomputeVisibility();

    let equipmentSelect: HTMLSelectElement | undefined;
    if (mainEquipmentIds.length > 1) {
      const eqRow = body.createDiv({ cls: 'tn-lm-field' });
      eqRow.createEl('label', { cls: 'tn-lm-label', text: 'Оборудование *' });
      equipmentSelect = eqRow.createEl('select', { cls: 'tn-lm-input' });
      for (const eqId of mainEquipmentIds) {
        const eq = equipmentList.find(e => e.id === eqId);
        equipmentSelect.createEl('option', { attr: { value: String(eqId) }, text: eq ? (eq.code || eq.name) : `#${eqId}` });
      }
      if (existingSeries?.equipment_id) equipmentSelect.value = String(existingSeries.equipment_id);
      equipmentSelect.addEventListener('change', () => { dirty = true; });
    }

    let photoBeforeUrl = '';
    let photoAfterUrl = '';
    this.renderPhotoUploadPicker(body, 'Фото до испытания', requestId, (url) => { photoBeforeUrl = url; dirty = true; });
    this.renderPhotoUploadPicker(body, 'Фото после испытания', requestId, (url) => { photoAfterUrl = url; dirty = true; });

    const errDiv = body.createDiv({ cls: 'tn-lm-error tn-lm-mt8' });
    // Кнопки рядом (2026-08-28, живая жалоба пользователя): «Добавить серию» —
    // прямо рядом с «Отправить результаты», без выхода из формы.
    const btnRow = body.createDiv({ cls: 'tn-lm-flex tn-lm-mt8' });
    const submitBtn = btnRow.createEl('button', { text: 'Отправить результаты', cls: 'tn-btn tn-btn-primary' });
    const addNewBtn = btnRow.createEl('button', { text: '➕ Добавить серию', cls: 'tn-btn tn-btn-ghost' });
    addNewBtn.addEventListener('click', () => callbacks.onAddNew());

    const methodId = method.id;
    // Скрытые условной видимостью поля не уходят на сервер (2026-08-28, WP3c) —
    // хотя их значение остаётся в values на клиенте (не теряется при повторном
    // показе, см. recomputeVisibility выше), в payload они не попадают, пока
    // скрыты. Пересчитывает свежее состояние displaу прямо перед сборкой —
    // не полагается на то, что последний recomputeVisibility точно актуален.
    const buildSubmitValues = (): Record<string, unknown> => {
      recomputeVisibility();
      const hidden = new Set<string>();
      form.querySelectorAll<HTMLElement>('[data-attribute-id]').forEach((row) => {
        if (row.style.display === 'none' && row.dataset.attributeId) hidden.add(row.dataset.attributeId);
      });
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(values)) {
        if (!hidden.has(k)) out[k] = v;
      }
      return out;
    };

    const doSave = async (): Promise<number | null> => {
      errDiv.setText('');
      if (equipmentSelect && !equipmentSelect.value) { errDiv.setText('Выберите оборудование'); return null; }
      submitBtn.setAttr('disabled', 'true');
      try {
        const sv = (id: string): string | undefined => systemValues[id] === undefined ? undefined : String(systemValues[id]);
        const saved = await this.plugin.syncService.saveResult(requestId, methodId, buildSubmitValues(), {
          photoBefore: photoBeforeUrl, photoAfter: photoAfterUrl,
          reportDate: sv('report_date'), samplesInDate: sv('samples_in_date'), expDate: sv('exp_date'),
          ambTemp: sv('amb_temp'), ambPres: sv('amb_pres'), ambMoist: sv('amb_moist'),
          equipmentId: equipmentSelect ? Number(equipmentSelect.value) : undefined,
          instrumentHash: hashInput.value.trim() || undefined,
          seriesNum,
        });
        dirty = false;
        // Hash одноразовый (сервер помечает его использованным при успешном claim,
        // см. claimInstrumentBuffer) — очищаем поле, чтобы случайный повторный
        // сабмит/автосохранение при переключении серии не пытался занять его снова.
        hashInput.value = '';
        seriesNum = saved.series_num;
        titleEl.setText(`Серия ${seriesNum}`);
        callbacks.onSeriesSaved(seriesNum);
        return seriesNum;
      } catch (e: unknown) {
        // Значения на экране НЕ теряются (см. спеку) — просто показываем ошибку
        // и оставляем кнопку доступной для повтора.
        errDiv.setText(`Не удалось отправить: ${errorMessage(e)}. Значения сохранены на экране — можно повторить.`);
        return null;
      } finally {
        submitBtn.removeAttribute('disabled');
      }
    };

    submitBtn.addEventListener('click', () => {
      void (async () => {
        const savedNum = await doSave();
        if (savedNum !== null) new Notice('Результаты отправлены');
      })();
    });

    return { save: doSave, isDirty: () => dirty };
  }

  // ---- Экран «Калибровка оборудования» ----

  private async renderCalibrateScreen(body: HTMLElement, equipmentId: number): Promise<void> {
    const status = body.createDiv({ cls: 'tn-lm-meta', text: 'Загрузка оборудования…' });
    let links: EquipmentMethodLink[];
    let methods: MobileMethod[];
    try {
      [links, methods] = await Promise.all([
        this.plugin.syncService.listEquipmentMethods(equipmentId),
        this.plugin.syncService.listMethods(),
      ]);
    } catch (e: unknown) {
      status.setText('');
      this.renderRetriableError(body, errorMessage(e), () => {
        body.empty();
        void this.renderCalibrateScreen(body, equipmentId);
      });
      return;
    }
    status.remove();

    const linkedMethods = links
      .map(l => methods.find(m => m.id === l.method_id))
      .filter((m): m is MobileMethod => !!m);

    if (linkedMethods.length === 0) {
      body.createDiv({
        cls: 'tn-lm-error',
        text: 'Оборудование не привязано к методу калибровки. Обратитесь к администратору.',
      });
      return;
    }

    if (linkedMethods.length === 1) {
      this.renderCalibrationForm(body, equipmentId, linkedMethods[0]);
      return;
    }

    body.createEl('h3', { text: 'Выберите метод' });
    const list = body.createDiv({ cls: 'tn-lm-list' });
    for (const m of linkedMethods) {
      const btn = list.createEl('button', {
        text: `${m.code}${m.name ? ' — ' + m.name : ''}`, cls: 'tn-btn tn-btn-ghost tn-lm-mb8',
      });
      btn.addEventListener('click', () => {
        body.empty();
        this.renderCalibrationForm(body, equipmentId, m);
      });
    }
  }

  private renderCalibrationForm(body: HTMLElement, equipmentId: number, method: MobileMethod): void {
    body.createEl('h3', { text: 'Новая запись калибровки' });
    body.createDiv({ cls: 'tn-lm-meta tn-lm-mb8', text: `Метод: ${method.code}${method.name ? ' — ' + method.name : ''}` });

    const attrs: CalibrationAttribute[] = method.calibration_attributes;
    const fields: OperatorFormField[] = method.calibration_operator_form.fields.length > 0
      ? method.calibration_operator_form.fields
      : attrs.map(a => ({ attribute_id: a.id, label: a.name, required: false }));
    const attrById = new Map(attrs.map(a => [a.id, a] as const));

    const values: Record<string, unknown> = {};
    const form = body.createDiv({ cls: 'tn-lm-form' });
    let hasFields = false;
    for (const field of fields) {
      const attr = attrById.get(field.attribute_id);
      if (attr && attr.data_type === 'photo') continue;
      hasFields = true;
      this.renderFormField(form, field, attr?.data_type || 'text', values);
    }
    // БАГ (2026-08-28, живая жалоба пользователя — форма калибровки метода РП
    // пустая на планшете): раньше здесь был return, если у метода нет
    // calibration_attributes — из-за этого условия среды (ниже) и кнопка
    // «Сохранить» тоже никогда не рендерились, хотя по дизайну они ВСЕГДА
    // доступны, независимо от наличия настроенных атрибутов метода (см.
    // комментарий у CALIBRATION_SYSTEM_FIELDS). Теперь — просто заметка, форма
    // продолжает рендериться дальше (env-поля + фото + submit).
    if (!hasFields) {
      body.createDiv({
        cls: 'tn-lm-meta tn-lm-mb8',
        text: 'Для этого метода не настроены дополнительные атрибуты калибровки — доступны только общие поля ниже.',
      });
    }

    // Условия среды при калибровке (2026-08-27) — сервер принимает их как
    // отдельные поля ЛЮБОЙ калибровки, всегда (equipment_ext.go), поэтому
    // показываем без привязки к конфигуратору, в отличие от обычных
    // результатов испытания (там — опционально, см. renderResultScreen).
    const envValues: Record<string, unknown> = {};
    const envForm = body.createDiv({ cls: 'tn-lm-form tn-lm-mb8' });
    for (const s of CALIBRATION_SYSTEM_FIELDS) {
      this.renderFormField(envForm, { attribute_id: s.id, label: s.label, required: false }, s.data_type, envValues);
    }

    let photo: { data: ArrayBuffer; fileName: string } | undefined;
    this.renderPhotoCapturePicker(body, 'Фото к записи калибровки', (captured) => { photo = captured; });

    const errDiv = body.createDiv({ cls: 'tn-lm-error tn-lm-mt8' });
    const submitBtn = body.createEl('button', { text: 'Сохранить запись', cls: 'tn-btn tn-btn-primary tn-lm-mt8' });
    const methodId = method.id;
    submitBtn.addEventListener('click', () => {
      void (async () => {
        errDiv.setText('');
        submitBtn.setAttr('disabled', 'true');
        try {
          const ev = (id: string): string | undefined => envValues[id] === undefined ? undefined : String(envValues[id]);
          await this.plugin.syncService.createEquipmentCalibration(equipmentId, methodId, values, {
            ambTemp: ev('amb_temp'), ambPres: ev('amb_pres'), ambMoist: ev('amb_moist'),
          }, photo);
          new Notice('Запись калибровки сохранена');
          this.screen = { kind: 'home' };
          this.render();
        } catch (e: unknown) {
          errDiv.setText(`Не удалось отправить: ${errorMessage(e)}. Значения сохранены на экране — можно повторить.`);
        } finally {
          submitBtn.removeAttribute('disabled');
        }
      })();
    });
  }

  // ---- Общие помощники ----

  /** Фото результата испытания (photo_before/photo_after заявки) — выбор файла
   * из галереи (без атрибута capture: у Obsidian mobile нет доступа к камере,
   * см. AGENTS.md). Снимок сразу загружается на сервер (POST /file), в форму
   * результатов подставляется готовая ссылка (требование JSON-эндпоинта
   * POST /requests/{id}/results). */
  private renderPhotoUploadPicker(
    container: HTMLElement, label: string, requestId: number, onUploaded: (url: string) => void,
  ): void {
    const row = container.createDiv({ cls: 'tn-lm-photo-row tn-lm-mb8' });
    const btn = row.createEl('button', { text: `🖼 ${label}`, cls: 'tn-btn tn-btn-ghost' });
    const status = row.createDiv({ cls: 'tn-lm-meta' });
    const input = row.createEl('input', {
      attr: { type: 'file', accept: 'image/*' },
    });
    input.addClass('tn-lm-hidden-file-input');
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        status.setText('Загрузка…');
        try {
          const data = await file.arrayBuffer();
          const url = await this.plugin.syncService.uploadFile(data, file.name, requestId);
          onUploaded(url);
          status.empty();
          status.createEl('img', { cls: 'tn-lm-photo-thumb', attr: { src: url } });
        } catch (e: unknown) {
          status.setText(`Ошибка загрузки: ${errorMessage(e)}`);
        }
      })();
    });
  }

  /** Фото к записи калибровки — выбор файла из галереи (без capture, см.
   * renderPhotoUploadPicker); байты держим локально и отправляем ВМЕСТЕ с
   * остальной формой при сохранении (createEquipmentCalibration — один
   * multipart-запрос, без отдельного /file, тот же паттерн, что на десктопе). */
  private renderPhotoCapturePicker(
    container: HTMLElement, label: string, onCaptured: (photo: { data: ArrayBuffer; fileName: string }) => void,
  ): void {
    const row = container.createDiv({ cls: 'tn-lm-photo-row tn-lm-mb8' });
    const btn = row.createEl('button', { text: `🖼 ${label}`, cls: 'tn-btn tn-btn-ghost' });
    const status = row.createDiv({ cls: 'tn-lm-meta' });
    const input = row.createEl('input', {
      attr: { type: 'file', accept: 'image/*' },
    });
    input.addClass('tn-lm-hidden-file-input');
    btn.addEventListener('click', () => input.click());
    input.addEventListener('change', () => {
      void (async () => {
        const file = input.files?.[0];
        if (!file) return;
        const data = await file.arrayBuffer();
        onCaptured({ data, fileName: file.name });
        status.empty();
        status.createEl('img', { cls: 'tn-lm-photo-thumb', attr: { src: URL.createObjectURL(file) } });
      })();
    });
  }

  private renderFormField(
    container: HTMLElement, field: OperatorFormField, dataType: AttributeDataType, values: Record<string, unknown>,
    options?: string[],
  ): void {
    const row = container.createDiv({ cls: 'tn-lm-field' });
    // Для updateFieldVisibility (2026-08-28, WP3c) — находит обёртку поля по
    // attribute_id, чтобы скрыть/показать по условию другого поля.
    row.dataset.attributeId = field.attribute_id;
    row.createEl('label', {
      cls: 'tn-lm-label',
      text: (field.label || field.attribute_id) + (field.required ? ' *' : ''),
    });
    if (field.help_text) row.createDiv({ cls: 'tn-lm-help', text: field.help_text });

    // Дефолт (2026-08-28, WP3c) — однократно при рендере, только если значения
    // ещё нет (не перетирает уже сохранённое при правке существующей серии).
    if (field.default && values[field.attribute_id] === undefined) {
      if (field.default.kind === 'literal') values[field.attribute_id] = field.default.value;
      else if (field.default.kind === 'today' && dataType === 'date') values[field.attribute_id] = todayLocalDateString();
    }

    // "curve" (2026-08-28, WP1) — только у calibration_attributes: набор точек x→y
    // (напр. калибровочная кривая расстояние→тепловой поток метода РП), не одно число —
    // список строк с +/− вместо <input>. Никогда не встречается у обычных атрибутов
    // метода (input_parameters), поэтому results-форма этот путь не задействует.
    if (dataType === 'curve') {
      this.renderCurvePointsField(row, field.attribute_id, values);
      return;
    }

    // select/boolean (2026-08-28, WP3c) — constrained-choice виджет: boolean
    // всегда ['Да','Нет'] (не нужно ничего настраивать в конфигураторе),
    // select — из MethodAttribute.options. Пустой первый option — ничего не
    // подставляется как "выбрано" без явного действия испытателя.
    if (dataType === 'select' || dataType === 'boolean') {
      const opts = dataType === 'boolean' ? ['Да', 'Нет'] : (options || []);
      const select = row.createEl('select', { cls: 'tn-lm-input' });
      select.createEl('option', { attr: { value: '' }, text: '— выбрать —' });
      for (const o of opts) select.createEl('option', { attr: { value: o }, text: o });
      const existingChoice = values[field.attribute_id];
      if (existingChoice !== undefined) select.value = String(existingChoice);
      select.addEventListener('change', () => {
        if (select.value === '') { delete values[field.attribute_id]; return; }
        values[field.attribute_id] = select.value;
      });
      return;
    }

    const attrs: Record<string, string> = { type: 'text' };
    if (dataType === 'int') { attrs.type = 'number'; attrs.step = '1'; }
    else if (dataType === 'float') { attrs.type = 'number'; attrs.step = 'any'; }
    else if (dataType === 'date') attrs.type = 'date';
    else if (dataType === 'time') attrs.type = 'time';
    const input = row.createEl('input', { attr: attrs, cls: 'tn-lm-input' });
    // Предзаполнение при правке существующей серии (2026-08-28, WP3a) — values
    // приходит уже с текущими значениями серии, см. renderResultScreen(seriesNum).
    const existing = values[field.attribute_id];
    if (existing !== undefined) input.value = String(existing);
    input.addEventListener('input', () => {
      const v = input.value;
      if (v === '') { delete values[field.attribute_id]; return; }
      values[field.attribute_id] = (dataType === 'int' || dataType === 'float') ? Number(v) : v;
    });
  }

  /** Список точек калибровочной кривой (2026-08-28, WP1) — мобильный аналог
   * renderCurvePointsField в десктопном lims-view.ts: строка = два числовых поля
   * (x/y) + «−», плюс кнопка «+ Точка». Стартует с двух пустых строк (минимум для
   * линейной интерполяции). Пустые/нечисловые строки не попадают в values при
   * отправке формы — испытателю не нужно чистить недописанные точки. */
  private renderCurvePointsField(container: HTMLElement, attributeId: string, values: Record<string, unknown>): void {
    const rowsEl = container.createDiv();
    const rows: Array<{ x: HTMLInputElement; y: HTMLInputElement }> = [];
    const sync = (): void => {
      const points = rows
        .map(r => ({ x: parseFloat(r.x.value), y: parseFloat(r.y.value) }))
        .filter(p => !Number.isNaN(p.x) && !Number.isNaN(p.y));
      if (points.length > 0) values[attributeId] = points;
      else delete values[attributeId];
    };
    const addRow = (): void => {
      const row = rowsEl.createDiv({ cls: 'tn-lm-flex' });
      const x = row.createEl('input', { attr: { type: 'number', placeholder: 'x' }, cls: 'tn-lm-input' });
      const y = row.createEl('input', { attr: { type: 'number', placeholder: 'y' }, cls: 'tn-lm-input' });
      x.addEventListener('input', sync);
      y.addEventListener('input', sync);
      const rm = row.createEl('button', { text: '−', cls: 'tn-btn tn-btn-ghost' });
      rm.addEventListener('click', () => {
        row.remove();
        const i = rows.findIndex(r => r.x === x);
        if (i >= 0) rows.splice(i, 1);
        sync();
      });
      rows.push({ x, y });
    };
    addRow();
    addRow();
    const addBtn = container.createEl('button', { text: '+ Точка', cls: 'tn-btn tn-btn-ghost tn-lm-mb8' });
    addBtn.addEventListener('click', addRow);
  }

  private renderRetriableError(body: HTMLElement, message: string, retry: () => void): void {
    body.createDiv({ cls: 'tn-lm-error', text: message });
    const retryBtn = body.createEl('button', { text: 'Повторить', cls: 'tn-btn tn-btn-ghost tn-lm-mt8' });
    retryBtn.addEventListener('click', retry);
  }
}

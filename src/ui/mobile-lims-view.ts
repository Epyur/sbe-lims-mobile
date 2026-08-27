import { ItemView, Notice, WorkspaceLeaf } from 'obsidian';
import type SbeLimsMobilePlugin from '../main';
import { errorMessage } from '../../../../.obsidian/plugins/sbe-core/src/utils/errors';
import {
  CALIBRATION_SYSTEM_FIELDS, RESULT_SYSTEM_FIELDS,
} from '../types';
import type {
  AttributeDataType, CalibrationAttribute, EquipmentMethodLink, MobileMethod, OperatorFormField,
} from '../types';

export const MOBILE_LIMS_VIEW_TYPE = 'sbe-lims-mobile-view';

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

  openResult(requestId: number): void {
    this.screen = { kind: 'result', requestId };
    this.render();
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
            this.openResult(found.id);
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

  private async renderResultScreen(body: HTMLElement, requestId: number): Promise<void> {
    const status = body.createDiv({ cls: 'tn-lm-meta', text: 'Загрузка заявки…' });
    let method: MobileMethod | undefined;
    let requestLabel = '';
    try {
      const [request, methods] = await Promise.all([
        this.plugin.syncService.getRequest(requestId),
        this.plugin.syncService.listMethods(),
      ]);
      requestLabel = request.customer_number || request.lab_number || `#${request.id}`;
      method = methods.find(m => m.id === request.method_id);
      if (!method) {
        status.setText('');
        body.createDiv({ cls: 'tn-lm-error', text: 'Метод испытаний этой заявки не найден.' });
        return;
      }
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

    const attrById = new Map(method.input_parameters.map(a => [a.id, a] as const));
    // Системные поля (2026-08-27) — те же id, что requests.report_date/
    // samples_in_date/exp_date/amb_temp/amb_pres/amb_moist; попадают в форму,
    // только если админ явно добавил их в operator_form.fields конфигуратора
    // (см. sbe-lims OPERATOR_FORM_SYSTEM_FIELDS) — значения идут отдельно от
    // values (это колонки requests, не JSONB атрибуты метода).
    const systemById = new Map(RESULT_SYSTEM_FIELDS.map(s => [s.id, s] as const));
    const fields: OperatorFormField[] = method.operator_form.fields.length > 0
      ? method.operator_form.fields
      : method.input_parameters.map(a => ({ attribute_id: a.id, label: a.name, required: false }));

    const values: Record<string, unknown> = {};
    const systemValues: Record<string, unknown> = {};
    const form = body.createDiv({ cls: 'tn-lm-form' });
    let hasFields = false;
    for (const field of fields) {
      const sys = systemById.get(field.attribute_id);
      if (sys) {
        hasFields = true;
        this.renderFormField(form, { ...field, label: field.label || sys.label }, sys.data_type, systemValues);
        continue;
      }
      const attr = attrById.get(field.attribute_id);
      if (attr && attr.data_type === 'photo') continue; // вне scope v1
      hasFields = true;
      this.renderFormField(form, field, attr?.data_type || 'text', values);
    }
    if (!hasFields) {
      body.createDiv({ cls: 'tn-lm-meta', text: 'Для этого метода не настроены поля ввода — обратитесь к администратору.' });
      return;
    }

    let photoBeforeUrl = '';
    let photoAfterUrl = '';
    this.renderPhotoUploadPicker(body, 'Фото до испытания', requestId, (url) => { photoBeforeUrl = url; });
    this.renderPhotoUploadPicker(body, 'Фото после испытания', requestId, (url) => { photoAfterUrl = url; });

    const errDiv = body.createDiv({ cls: 'tn-lm-error tn-lm-mt8' });
    const submitBtn = body.createEl('button', { text: 'Отправить результаты', cls: 'tn-btn tn-btn-primary tn-lm-mt8' });
    const methodId = method.id;
    submitBtn.addEventListener('click', () => {
      void (async () => {
        errDiv.setText('');
        submitBtn.setAttr('disabled', 'true');
        try {
          const sv = (id: string): string | undefined => systemValues[id] === undefined ? undefined : String(systemValues[id]);
          await this.plugin.syncService.saveResult(requestId, methodId, values, {
            photoBefore: photoBeforeUrl, photoAfter: photoAfterUrl,
            reportDate: sv('report_date'), samplesInDate: sv('samples_in_date'), expDate: sv('exp_date'),
            ambTemp: sv('amb_temp'), ambPres: sv('amb_pres'), ambMoist: sv('amb_moist'),
          });
          new Notice('Результаты отправлены');
          this.screen = { kind: 'home' };
          this.render();
        } catch (e: unknown) {
          // Значения на экране НЕ теряются (см. спеку) — просто показываем ошибку
          // и оставляем кнопку доступной для повтора.
          errDiv.setText(`Не удалось отправить: ${errorMessage(e)}. Значения сохранены на экране — можно повторить.`);
        } finally {
          submitBtn.removeAttribute('disabled');
        }
      })();
    });
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
    if (!hasFields) {
      body.createDiv({
        cls: 'tn-lm-meta',
        text: 'Для этого метода не настроены атрибуты калибровки — обратитесь к администратору.',
      });
      return;
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
  ): void {
    const row = container.createDiv({ cls: 'tn-lm-field' });
    row.createEl('label', {
      cls: 'tn-lm-label',
      text: (field.label || field.attribute_id) + (field.required ? ' *' : ''),
    });
    if (field.help_text) row.createDiv({ cls: 'tn-lm-help', text: field.help_text });

    const attrs: Record<string, string> = { type: 'text' };
    if (dataType === 'int') { attrs.type = 'number'; attrs.step = '1'; }
    else if (dataType === 'float') { attrs.type = 'number'; attrs.step = 'any'; }
    else if (dataType === 'date') attrs.type = 'date';
    else if (dataType === 'time') attrs.type = 'time';
    const input = row.createEl('input', { attr: attrs, cls: 'tn-lm-input' });
    input.addEventListener('input', () => {
      const v = input.value;
      if (v === '') { delete values[field.attribute_id]; return; }
      values[field.attribute_id] = (dataType === 'int' || dataType === 'float') ? Number(v) : v;
    });
  }

  private renderRetriableError(body: HTMLElement, message: string, retry: () => void): void {
    body.createDiv({ cls: 'tn-lm-error', text: message });
    const retryBtn = body.createEl('button', { text: 'Повторить', cls: 'tn-btn tn-btn-ghost tn-lm-mt8' });
    retryBtn.addEventListener('click', retry);
  }
}

/** Типы — узкое подмножество полей lab-service, реально нужных мобильному вводу
 * (не общий пакет с sbe-lims — маленькое дублирование дешевле, чем зависимость
 * между репозиториями, см. spec «Границы»). */

// "curve" (2026-08-28, WP1) — только у calibration_attributes: набор точек x→y
// (калибровочная кривая), не одно число, см. mobile-lims-view.ts renderCurvePointsField.
// "select"/"boolean" (2026-08-28, WP3c ч.1) — <select> в форме результатов,
// boolean — тот же рендер с неявным фиксированным списком ['Да','Нет'].
// "event_log" (2026-08-28, WP3c ч.2) — массив {label,seconds}, пишут кнопки
// лога наблюдений (см. MethodOperatorForm.timer).
// "instrument_hash" (2026-09-05) — маркер конфигурации "этому методу нужно
// поле ввода hash прибора"; значение НЕ хранится как values этого атрибута,
// уходит отдельным полем instrument_hash тела запроса, см. mobile-lims-view.ts.
export type AttributeDataType =
  | 'text' | 'int' | 'float' | 'date' | 'time' | 'photo' | 'curve' | 'select' | 'boolean' | 'event_log'
  | 'instrument_hash';

/** Знак сравнения — условная видимость поля формы (2026-08-28, WP3c); тот же
 * каталог, что ComparisonOperator в sbe-lims (классификация), здесь нужен
 * только для visibility.conditions. */
export type ComparisonOperator = '==' | '!=' | '<' | '<=' | '>' | '>=';

export interface OperatorFormField {
  attribute_id: string;
  label?: string;
  required: boolean;
  help_text?: string;
  /** Значение по умолчанию (2026-08-28, WP3c) — без DSL: "literal" — точное
   * значение, "today" — только для data_type="date", сегодняшняя ЛОКАЛЬНАЯ
   * дата устройства. Применяется один раз при рендере, не переопределяет уже
   * существующее значение (правка серии). */
  default?: { kind: 'literal'; value: string } | { kind: 'today' };
  /** Условная видимость (2026-08-28, WP3c) — поле показывается, только если
   * условия истинны (logic="and" — все, "or" — хотя бы одно); field — id
   * ДРУГОГО поля этой же формы. Пересчитывается живо, скрытое поле не
   * попадает в отправляемые values. */
  visibility?: {
    logic: 'and' | 'or';
    conditions: Array<{ field: string; operator: ComparisonOperator; value: string }>;
  };
  /** Рекомендуемые значения (2026-08-29) — кнопки-подсказки под полем, клик
   * подставляет точный текст (поле остаётся свободным вводом, не select). */
  suggestions?: string[];
}

export interface MethodOperatorForm {
  fields: OperatorFormField[];
  /** Таймер формы (2026-08-28, WP3c ч.2; переработано 2026-08-29) — список
   * именованных кнопок, см. sbe-lims types/lims.ts за полным описанием.
   * Ссылается на уже существующие атрибуты метода по id. */
  timer?: {
    buttons: Array<{
      label: string;
      action:
        | { kind: 'capture'; booleanFieldId: string; secondsFieldId: string }
        | { kind: 'log'; attributeId: string };
    }>;
  };
}

/** Атрибут метода (methods.input_parameters) — для формы результатов испытания. */
export interface MethodAttribute {
  id: string;
  name: string;
  data_type: AttributeDataType;
  /** Варианты выбора (2026-08-28, WP3c) — значимо только при data_type="select". */
  options?: string[];
}

/** Атрибут калибровки (methods.calibration_attributes) — для формы журнала калибровки. */
export interface CalibrationAttribute {
  id: string;
  name: string;
  data_type: AttributeDataType;
}

export interface MobileMethod {
  id: number;
  code: string;
  name: string;
  input_parameters: MethodAttribute[];
  operator_form: MethodOperatorForm;
  calibration_attributes: CalibrationAttribute[];
  calibration_operator_form: MethodOperatorForm;
}

export interface MobileRequest {
  id: number;
  method_id: number;
  customer_number: string;
  lab_number: string;
  number_seq: number;
  number_year: number;
  title: string;
  status: string;
}

/** Серия результата испытания (GET /requests/{id}/results, 2026-08-28, WP3a) — узкое
 * подмножество, нужное для списка серий и предзаполнения формы правки (см.
 * mobile-lims-view.ts renderResultListScreen). */
export interface MobileResult {
  id: number;
  request_id: number;
  method_id: number;
  series_num: number;
  values: Record<string, unknown>;
  equipment_id: number;
  is_statistical_row: boolean;
  /** Фоллбэк для day-check WP3b (2026-08-28) — если у серии не заполнено
   * values.exp_date, сравнение "тот же день?" берёт дату этой создания. */
  created_at: string;
}

export interface MobileEquipment {
  id: number;
  code: string;
  name: string;
}

export interface EquipmentMethodLink {
  method_id: number;
  role: 'main' | 'auxiliary';
}

/** Одна строка ВСЕЙ таблицы method_equipment (GET /method-equipment, 2026-08-28, WP1) —
 * в отличие от EquipmentMethodLink (уже привязан к одному equipment_id через URL), здесь
 * equipment_id — часть самой записи: нужно узнать все единицы оборудования КОНКРЕТНОГО
 * метода, а не наоборот. */
export interface MethodEquipmentLink {
  method_id: number;
  equipment_id: number;
  role: 'main' | 'auxiliary';
}

/** Системные поля результатов испытания (2026-08-27) — раньше считались
 * "подставляются сами", теперь испытатель заполняет их вручную, ЕСЛИ админ
 * явно добавил их в operator_form.fields конфигуратора (см. sbe-lims,
 * OPERATOR_FORM_SYSTEM_FIELDS в block-editor.ts — тот же список, id должны
 * совпадать 1:1 с requests.report_date/samples_in_date/exp_date/amb_*).
 * Значения уходят НЕ в values (это отдельные колонки requests) — см.
 * LimsMobileService.saveResult. */
export const RESULT_SYSTEM_FIELDS: Array<{ id: string; label: string; data_type: AttributeDataType }> = [
  { id: 'report_date', label: 'Дата протокола', data_type: 'date' },
  { id: 'samples_in_date', label: 'Дата поступления материала', data_type: 'date' },
  { id: 'exp_date', label: 'Дата эксперимента', data_type: 'date' },
  { id: 'amb_temp', label: 'Температура воздуха при испытании, °C', data_type: 'float' },
  { id: 'amb_pres', label: 'Атмосферное давление при испытании, мм.рт.ст', data_type: 'float' },
  { id: 'amb_moist', label: 'Влажность воздуха при испытании, %', data_type: 'float' },
];

/** Системные поля калибровки — сервер (equipment_ext.go handleCreateEquipmentCalibration)
 * уже принимает amb_temp/amb_pres/amb_moist как отдельные multipart-поля (не
 * часть values) для ЛЮБОЙ калибровки, всегда — в отличие от результатов
 * испытания, это не опционально настраиваемое в конфигураторе, а встроенная
 * часть журнала калибровки (см. sbe-lims lims-view.ts CALIBRATION_SYSTEM_FIELDS). */
export const CALIBRATION_SYSTEM_FIELDS: Array<{ id: string; label: string; data_type: AttributeDataType }> = [
  { id: 'amb_temp', label: 'Температура воздуха в лаборатории', data_type: 'float' },
  { id: 'amb_pres', label: 'Атмосферное давление', data_type: 'float' },
  { id: 'amb_moist', label: 'Влажность воздуха', data_type: 'float' },
];

/** Типы — узкое подмножество полей lab-service, реально нужных мобильному вводу
 * (не общий пакет с sbe-lims — маленькое дублирование дешевле, чем зависимость
 * между репозиториями, см. spec «Границы»). */

export type AttributeDataType = 'text' | 'int' | 'float' | 'date' | 'time' | 'photo';

export interface OperatorFormField {
  attribute_id: string;
  label?: string;
  required: boolean;
  help_text?: string;
}

export interface MethodOperatorForm {
  fields: OperatorFormField[];
}

/** Атрибут метода (methods.input_parameters) — для формы результатов испытания. */
export interface MethodAttribute {
  id: string;
  name: string;
  data_type: AttributeDataType;
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

export interface MobileEquipment {
  id: number;
  code: string;
  name: string;
}

export interface EquipmentMethodLink {
  method_id: number;
  role: 'main' | 'auxiliary';
}

import { requestUrl, RequestUrlParam } from 'obsidian';
import { getService } from '../../../../.obsidian/plugins/sbe-core/src/bridge';
import { errorMessage } from '../../../../.obsidian/plugins/sbe-core/src/utils/errors';
import type {
  EquipmentMethodLink, MethodEquipmentLink, MobileEquipment, MobileMethod, MobileRequest, MobileResult,
} from '../types';

/** Клиент lab-service для мобильного ввода — узкое подмножество вызовов, тот же
 * паттерн, что sbe-lims/src/services/sync.service.ts (getToken через мост ЦУП,
 * assertOk на 401/403, multipart для калибровки). */
export class LimsMobileService {
  private getApiUrl: () => string;

  constructor(getApiUrl: () => string) {
    this.getApiUrl = getApiUrl;
  }

  get baseUrl(): string {
    return this.getApiUrl().trim().replace(/\/+$/, '');
  }

  private async getToken(): Promise<string> {
    const apstore = await getService('sbe-apstore');
    return apstore.auth.getToken('lab');
  }

  async getRequest(id: number): Promise<MobileRequest> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${id}`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    const data = JSON.parse(res.text) as { request: MobileRequest };
    return data.request;
  }

  /** Для ручного резервного поиска по номеру (без сканирования) — весь видимый список. */
  async listRequests(): Promise<MobileRequest[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { requests?: MobileRequest[] };
      return Array.isArray(data.requests) ? data.requests : [];
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе requests:', errorMessage(e));
      return [];
    }
  }

  async listMethods(): Promise<MobileMethod[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/methods`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { methods?: MobileMethod[] };
      return Array.isArray(data.methods) ? data.methods : [];
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе methods:', errorMessage(e));
      return [];
    }
  }

  /** series_num не передаём — сервер сам берёт следующий свободный (saveResultSeries).
   * photoBefore/photoAfter — уже загруженные file_url (см. uploadFile). Системные
   * поля (reportDate/samplesInDate/expDate/ambTemp/ambPres/ambMoist) уходят НЕ в
   * values — сервер пишет их напрямую в колонки requests (см. lab-service
   * updateRequestSystemFields, 2026-08-27); пустая строка = не менять текущее. */
  async saveResult(
    requestId: number, methodId: number, values: Record<string, unknown>,
    extra?: {
      photoBefore?: string; photoAfter?: string;
      reportDate?: string; samplesInDate?: string; expDate?: string;
      ambTemp?: string; ambPres?: string; ambMoist?: string;
      /** На каком экземпляре оборудования выполнено измерение (2026-08-28, WP1) —
       * только когда у метода больше одной единицы "Основного" оборудования, см.
       * mobile-lims-view.ts renderResultScreen/listAllMethodEquipment. */
      equipmentId?: number;
      /** Номер существующей серии — правка на месте (2026-08-28, WP3a): сервер
       * апсертит по (request_id, method_id, series_num), новый эндпоинт не нужен.
       * Не передавать при создании НОВОЙ серии — сервер сам назначит следующий. */
      seriesNum?: number;
      /** Hash данных от внешнего прибора (2026-08-28, WP3d) — испытатель
       * переписывает его с экрана/QR прибора (TDT Reader и т.п.); сервер
       * атомарно заявляет `instrument_result_buffer` по hash и домешивает его
       * values В values ЭТОЙ серии (см. lab-service handleCreateResult/
       * claimInstrumentBuffer — вручную введённое приоритетнее). Одноразовый:
       * повторная отправка того же hash вернёт ошибку "не найден/уже использован". */
      instrumentHash?: string;
    },
  ): Promise<{ series_num: number }> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/results`,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        method_id: methodId, values,
        photo_before: extra?.photoBefore || '', photo_after: extra?.photoAfter || '',
        report_date: extra?.reportDate || '', samples_in_date: extra?.samplesInDate || '', exp_date: extra?.expDate || '',
        amb_temp: extra?.ambTemp || '', amb_pres: extra?.ambPres || '', amb_moist: extra?.ambMoist || '',
        equipment_id: extra?.equipmentId,
        series_num: extra?.seriesNum,
        instrument_hash: extra?.instrumentHash || '',
      }),
    });
    this.assertOk(res);
    // Сервер отдаёт назначенный/сохранённый series_num в теле ответа (см. lab-service
    // results.go handleCreateResult) — нужен вызывающему коду, чтобы после создания
    // НОВОЙ серии (seriesNum не передавался) знать, на какой номер она легла, и не
    // создать вторую новую серию повторным сабмитом того же экрана (2026-08-28, WP3a).
    try {
      const parsed = JSON.parse(res.text) as { series_num?: number };
      return { series_num: parsed.series_num ?? (extra?.seriesNum ?? 0) };
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе saveResult:', errorMessage(e));
      return { series_num: extra?.seriesNum ?? 0 };
    }
  }

  /** Список серий заявки (2026-08-28, WP3a) — для экрана «список серий» перед формой
   * (см. mobile-lims-view.ts renderResultListScreen) и предзаполнения формы правки. */
  async listResults(requestId: number): Promise<MobileResult[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/results`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { results?: MobileResult[] };
      return Array.isArray(data.results) ? data.results : [];
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе results:', errorMessage(e));
      return [];
    }
  }

  /** Удаление серии с перенумерацией последующих (2026-08-28, WP3a) — сервер сам
   * сдвигает series_num всех следующих серий этого метода на −1. */
  async deleteResultSeries(requestId: number, seriesNum: number): Promise<void> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/requests/${requestId}/results/${seriesNum}`,
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
  }

  /** Вся таблица method_equipment одним запросом (2026-08-28, WP1) — нужно узнать,
   * сколько единиц "Основного" оборудования у метода заявки (показывать ли селектор
   * оборудования в форме результатов испытания). */
  async listAllMethodEquipment(): Promise<MethodEquipmentLink[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/method-equipment`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { links?: MethodEquipmentLink[] };
      return Array.isArray(data.links) ? data.links : [];
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе method-equipment:', errorMessage(e));
      return [];
    }
  }

  /** Загружает фото (или любой файл) в S3 через lab-service, возвращает
   * стабильную ссылку (file_url) для подстановки в photo_before/photo_after. */
  async uploadFile(data: ArrayBuffer, fileName: string, requestId: number): Promise<string> {
    const token = await this.getToken();
    const boundary = this.multipartBoundary();
    const body = this.buildMultipart(boundary, { request_id: String(requestId) }, { field: 'file', data, fileName });
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/file`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }, 60000);
    this.assertOk(res);
    const parsed = JSON.parse(res.text) as { file_url?: string };
    if (!parsed.file_url) throw new Error('Сервер не вернул ссылку на загруженный файл');
    return parsed.file_url;
  }

  async listEquipment(): Promise<MobileEquipment[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/equipment`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { equipment?: MobileEquipment[] };
      return Array.isArray(data.equipment) ? data.equipment : [];
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе equipment:', errorMessage(e));
      return [];
    }
  }

  async listEquipmentMethods(equipmentId: number): Promise<EquipmentMethodLink[]> {
    const token = await this.getToken();
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/equipment/${equipmentId}/methods`,
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
    this.assertOk(res);
    try {
      const data = JSON.parse(res.text) as { methods?: EquipmentMethodLink[] };
      return Array.isArray(data.methods) ? data.methods : [];
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не JSON в ответе equipment/methods:', errorMessage(e));
      return [];
    }
  }

  async createEquipmentCalibration(
    equipmentId: number, methodId: number, values: Record<string, unknown>,
    env?: { ambTemp?: string; ambPres?: string; ambMoist?: string },
    photo?: { data: ArrayBuffer; fileName: string },
  ): Promise<void> {
    const token = await this.getToken();
    const boundary = this.multipartBoundary();
    const fields: Record<string, string> = {
      calibrated_at: new Date().toISOString().slice(0, 10),
      method_id: String(methodId),
      values: JSON.stringify(values || {}),
      amb_temp: env?.ambTemp || '', amb_pres: env?.ambPres || '', amb_moist: env?.ambMoist || '',
    };
    const body = this.buildMultipart(
      boundary, fields, photo ? { field: 'file', data: photo.data, fileName: photo.fileName } : undefined,
    );
    const res = await this.request({
      url: `${this.baseUrl}/api/lab/equipment/${equipmentId}/calibrations`,
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body,
    }, 120000);
    this.assertOk(res);
  }

  private multipartBoundary(): string {
    return '----sbe-lims-mobile-' + Date.now().toString(36);
  }

  private buildMultipart(
    boundary: string, fields: Record<string, string>,
    file?: { field: string; data: ArrayBuffer; fileName: string },
  ): ArrayBuffer {
    const enc = new TextEncoder();
    const parts: Uint8Array[] = [];
    for (const [name, value] of Object.entries(fields)) {
      parts.push(enc.encode(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`));
    }
    if (file) {
      parts.push(enc.encode(
        `--${boundary}\r\nContent-Disposition: form-data; name="${file.field}"; filename="${file.fileName}"\r\nContent-Type: application/octet-stream\r\n\r\n`,
      ));
      parts.push(new Uint8Array(file.data));
      parts.push(enc.encode('\r\n'));
    }
    parts.push(enc.encode(`--${boundary}--\r\n`));
    let total = 0;
    for (const p of parts) total += p.byteLength;
    const out = new Uint8Array(total);
    let off = 0;
    for (const p of parts) {
      out.set(p, off);
      off += p.byteLength;
    }
    return out.buffer;
  }

  private assertOk(res: { status: number; text: string }): void {
    if (res.status === 401) throw new Error('Ключ доступа недействителен. Войдите в ЦУП Мобайл (Аккаунт) и повторите.');
    if (res.status === 403) throw new Error('Нет прав доступа к ЛИМС. Обратитесь к администратору лаборатории.');
    if (res.status === 404) throw new Error('Не найдено — проверьте QR или введённый номер.');
    if (res.status !== 200) throw new Error(this.errorText(res) || `Сервер вернул HTTP ${res.status}`);
  }

  private errorText(res: { status: number; text: string }): string {
    if (!res.text) return '';
    try {
      const data = JSON.parse(res.text) as { error?: string };
      return data.error || '';
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: ответ сервера не JSON:', errorMessage(e));
      return '';
    }
  }

  private async request(param: RequestUrlParam, timeoutMs = 30000): Promise<{ status: number; text: string }> {
    let timer: number | undefined;
    try {
      const response = await Promise.race([
        requestUrl({ ...param, throw: false }),
        new Promise<never>((_, reject) => {
          timer = window.setTimeout(
            () => reject(new Error(`Сервер не ответил за ${Math.round(timeoutMs / 1000)} сек`)),
            timeoutMs,
          );
        }),
      ]);
      return { status: response.status, text: response.text };
    } finally {
      if (timer !== undefined) window.clearTimeout(timer);
    }
  }
}

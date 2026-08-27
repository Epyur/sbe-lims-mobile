import { App, Modal } from 'obsidian';
import jsQR from 'jsqr';
import { errorMessage } from '../../../../.obsidian/plugins/sbe-core/src/utils/errors';

/** Встроенный сканер QR (jsQR + getUserMedia) — фолбэк на случай, если
 * obsidian://-диплинк через штатную камеру телефона не срабатывает (не все
 * камеры/сканеры Android предлагают открыть нестандартную схему из QR).
 * Декодирует ТОТ ЖЕ диплинк, что печатает sbe-requests/sbe-lims — просто
 * читает его прямо в плагине, без обращения к внешним приложениям. */
export class QrScannerModal extends Modal {
  private onResult: (data: string) => void;
  private stream: MediaStream | null = null;
  private video: HTMLVideoElement | null = null;
  private canvas: HTMLCanvasElement = document.createElement('canvas');
  private rafId: number | null = null;
  private stopped = false;

  constructor(app: App, onResult: (data: string) => void) {
    super(app);
    this.onResult = onResult;
    this.modalEl.addClass('tn-lm-scanner-modal');
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl('h3', { text: 'Сканирование QR' });
    const statusEl = contentEl.createDiv({ cls: 'tn-lm-meta tn-lm-mb8', text: 'Запрос доступа к камере…' });
    this.video = contentEl.createEl('video', { cls: 'tn-lm-scanner-video' });
    this.video.setAttribute('playsinline', 'true');
    this.video.muted = true;

    const cancelBtn = contentEl.createEl('button', { text: 'Отмена', cls: 'tn-btn tn-btn-ghost tn-lm-mt8' });
    cancelBtn.addEventListener('click', () => this.close());

    if (!navigator.mediaDevices?.getUserMedia) {
      statusEl.setText('Камера недоступна в этом окружении.');
      return;
    }
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      this.video.srcObject = this.stream;
      await this.video.play();
      statusEl.setText('Наведите камеру на QR-код');
      this.loopScan();
    } catch (e: unknown) {
      statusEl.setText(`Камера недоступна: ${errorMessage(e)}`);
    }
  }

  onClose(): void {
    this.stopped = true;
    if (this.rafId !== null) {
      window.cancelAnimationFrame(this.rafId);
      this.rafId = null;
    }
    if (this.stream) {
      for (const track of this.stream.getTracks()) track.stop();
      this.stream = null;
    }
    this.contentEl.empty();
  }

  private loopScan(): void {
    if (this.stopped || !this.video) return;
    if (this.video.readyState === this.video.HAVE_ENOUGH_DATA) {
      const w = this.video.videoWidth;
      const h = this.video.videoHeight;
      if (w > 0 && h > 0) {
        this.canvas.width = w;
        this.canvas.height = h;
        const ctx = this.canvas.getContext('2d');
        if (ctx) {
          ctx.drawImage(this.video, 0, 0, w, h);
          const imageData = ctx.getImageData(0, 0, w, h);
          const code = jsQR(imageData.data, w, h);
          if (code && code.data) {
            const data = code.data;
            this.stopped = true;
            this.onResult(data);
            this.close();
            return;
          }
        }
      }
    }
    this.rafId = window.requestAnimationFrame(() => this.loopScan());
  }
}

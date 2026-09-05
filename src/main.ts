import { App, Notice, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { MOBILE_LIMS_VIEW_TYPE, MobileLimsView } from './ui/mobile-lims-view';
import { LimsMobileService } from './services/lims-mobile.service';
import { getService, publishService, unpublishService } from '../../../.obsidian/plugins/sbe-core/src/bridge';
import { errorMessage } from '../../../.obsidian/plugins/sbe-core/src/utils/errors';
import type { AnnounceUpdateInput, SbeLimsMobileApi } from '../../../.obsidian/plugins/sbe-core/src/types';

/** Заявка в списке «Последние заявки» на главном экране (2026-08-28) — label
 * кэшируется на момент открытия (customer_number/lab_number), не резолвится
 * заново при каждом рендере главного экрана: renderHome синхронный, без
 * сетевых запросов, список должен показываться мгновенно. */
export interface RecentRequest {
  id: number;
  label: string;
}

export interface MobileLimsSettings {
  /** База URL lab-service (JWT берётся из ЦУП/ЦУП Мобайл — sbe-apstore). */
  apiUrl: string;
  lastAnnouncedVersion: string;
  /** Последние заявки, которые открывал испытатель (2026-08-28) — быстрый
   * возврат без повторного ввода номера, см. openResult в mobile-lims-view.ts.
   * Локально на устройстве (не синхронизируется между планшетами — это разумно,
   * "последние" осмысленны именно для конкретного устройства/испытателя за ним). */
  recentRequests: RecentRequest[];
}

const DEFAULT_SETTINGS: MobileLimsSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  lastAnnouncedVersion: '',
  recentRequests: [],
};

/** «ЛИМС Мобайл»: номер заявки/код оборудования (переписанный вручную из QR,
 * который сканирует внешнее приложение телефона — у Obsidian mobile нет
 * доступа к камере) → форма ввода результатов испытания / калибровки
 * оборудования → отправка в lab-service. Чистый потребитель авторизации ЦУП
 * (getService('sbe-apstore')) — своего экрана входа нет, как и у десктопного
 * sbe-lims. */
export default class SbeLimsMobilePlugin extends Plugin {
  settings!: MobileLimsSettings;
  syncService!: LimsMobileService;

  async onload(): Promise<void> {
    await this.loadSettings();
    this.syncService = new LimsMobileService(() => this.settings.apiUrl);

    this.registerView(MOBILE_LIMS_VIEW_TYPE, leaf => new MobileLimsView(leaf, this));

    this.addRibbonIcon('flask-conical', 'ЛИМС Мобайл', () => {
      void this.activateView();
    });

    this.addCommand({
      id: 'open-sbe-lims-mobile',
      name: 'Открыть ЛИМС Мобайл',
      callback: () => {
        void this.activateView();
      },
    });

    this.addSettingTab(new MobileLimsSettingsTab(this.app, this));

    // Публикация в мост window.SBE — без этого мини-магазин sbe-mobile не может
    // найти и открыть плагин («Открыть» вызывает getService('sbe-lims-mobile')),
    // тот же паттерн, что у любого другого SBE-плагина с вьюхой (sbe-lims и т.д.).
    publishService<SbeLimsMobileApi>('sbe-lims-mobile', {
      open: async () => {
        await this.activateView();
      },
    }, {
      version: this.manifest.version,
      name: this.manifest.name,
    });

    this.app.workspace.onLayoutReady(() => {
      void this.announceIfNeeded();
    });
  }

  onunload(): void {
    unpublishService('sbe-lims-mobile');
    this.app.workspace.detachLeavesOfType(MOBILE_LIMS_VIEW_TYPE);
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData() as Partial<MobileLimsSettings>) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data);
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  async activateView(): Promise<MobileLimsView | null> {
    const { workspace } = this.app;
    // Обычная вкладка (как у десктопного sbe-lims: getLeaf(false)) — НЕ правая
    // панель/drawer: getRightLeaf на мобиле всегда находит правый drawer, из-за
    // чего плагин открывался там, а не полноэкранной вкладкой (правка 2026-08-27
    // по прямому запросу пользователя).
    let leaf = workspace.getLeavesOfType(MOBILE_LIMS_VIEW_TYPE).first();
    if (!leaf) {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({ type: MOBILE_LIMS_VIEW_TYPE, active: true });
    }
    workspace.revealLeaf(leaf);
    return leaf.view instanceof MobileLimsView ? leaf.view : null;
  }

  /** Публикует в «Новости» сообщение о своём обновлении — один раз на версию
   * (правило 2026-08-22). Первый запуск ничего не анонсирует. */
  private async announceIfNeeded(): Promise<void> {
    if (this.settings.lastAnnouncedVersion === this.manifest.version) return;
    const firstRun = !this.settings.lastAnnouncedVersion;
    try {
      const apstore = await getService('sbe-apstore');
      if (!apstore.auth.getStatus().authorized) return;
      if (!firstRun) {
        await this.announceUpdate({
          appId: this.manifest.id,
          appName: this.manifest.name,
          version: this.manifest.version,
          summary: 'Поле для ввода кода прибора в форме результатов появляется только для ' +
            'тех методов испытаний, где оно нужно, и теперь показывается именно там, где ' +
            'его разместили в настройках метода, а не всегда в начале формы.',
        });
      }
      this.settings.lastAnnouncedVersion = this.manifest.version;
      await this.saveSettings();
    } catch (e: unknown) {
      console.warn('ЛИМС Мобайл: не удалось опубликовать новость об обновлении:', errorMessage(e));
    }
  }

  private async announceUpdate(input: AnnounceUpdateInput): Promise<void> {
    const apstore = await getService('sbe-apstore');
    await apstore.announceUpdate(input);
  }
}

class MobileLimsSettingsTab extends PluginSettingTab {
  plugin: SbeLimsMobilePlugin;

  constructor(app: App, plugin: SbeLimsMobilePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    new Setting(containerEl).setHeading().setName('Сервер');
    new Setting(containerEl)
      .setName('Адрес сервера (apiUrl)')
      .setDesc('База URL lab-service, например https://epyur.fvds.ru. JWT берётся из ЦУП Мобайл (Аккаунт).')
      .addText(text => text
        .setPlaceholder('https://epyur.fvds.ru')
        .setValue(this.plugin.settings.apiUrl)
        .onChange(async (value) => {
          this.plugin.settings.apiUrl = value.trim();
          await this.plugin.saveSettings();
          new Notice('Сохранено');
        }));
  }
}

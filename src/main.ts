import { App, Notice, ObsidianProtocolData, Plugin, PluginSettingTab, Setting } from 'obsidian';
import { MOBILE_LIMS_VIEW_TYPE, MobileLimsView } from './ui/mobile-lims-view';
import { LimsMobileService } from './services/lims-mobile.service';
import { getService, publishService, unpublishService } from '../../../.obsidian/plugins/sbe-core/src/bridge';
import { errorMessage } from '../../../.obsidian/plugins/sbe-core/src/utils/errors';
import type { AnnounceUpdateInput, SbeLimsMobileApi } from '../../../.obsidian/plugins/sbe-core/src/types';

export interface MobileLimsSettings {
  /** База URL lab-service (JWT берётся из ЦУП/ЦУП Мобайл — sbe-apstore). */
  apiUrl: string;
  lastAnnouncedVersion: string;
}

const DEFAULT_SETTINGS: MobileLimsSettings = {
  apiUrl: 'https://epyur.fvds.ru',
  lastAnnouncedVersion: '',
};

/** «ЛИМС Мобайл»: сканирование QR (obsidian://sbe-lims-mobile) → форма ввода
 * результатов испытания / калибровки оборудования → отправка в lab-service.
 * Чистый потребитель авторизации ЦУП (getService('sbe-apstore')) — своего
 * экрана входа нет, как и у десктопного sbe-lims. */
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

    // obsidian://sbe-lims-mobile?action=result&request=<id>
    // obsidian://sbe-lims-mobile?action=calibrate&equipment=<id>
    this.registerObsidianProtocolHandler('sbe-lims-mobile', (params) => {
      void this.handleDeepLink(params);
    });

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
    let leaf = workspace.getLeavesOfType(MOBILE_LIMS_VIEW_TYPE).first();
    if (!leaf) {
      leaf = workspace.getRightLeaf(false) ?? workspace.getLeaf('tab');
      if (leaf) await leaf.setViewState({ type: MOBILE_LIMS_VIEW_TYPE, active: true });
    }
    if (!leaf) return null;
    workspace.revealLeaf(leaf);
    return leaf.view instanceof MobileLimsView ? leaf.view : null;
  }

  private async handleDeepLink(params: ObsidianProtocolData): Promise<void> {
    const view = await this.activateView();
    if (!view) return;
    if (params.action === 'result' && params.request) {
      view.openResult(Number(params.request));
    } else if (params.action === 'calibrate' && params.equipment) {
      view.openCalibrate(Number(params.equipment));
    }
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
          summary: 'Обновлена мобильная ЛИМС: исправления и улучшения.',
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

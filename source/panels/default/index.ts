import { readFileSync } from 'fs';
import { join } from 'path';
import { PACKAGE_NAME } from '../../constants';
import type { ICameraInfo, ICaptureResult, PreviewMode } from '../../types';

interface IDeviceItem {
    name: string;
    width: number;
    height: number;
    ratio: number;
}

interface IPanelSettings {
    deviceKey: string;
    cameraUuid: string;
    landscape: boolean;
    mode: PreviewMode;
    fps: number;
}

const FPS_OPTIONS = [1, 5, 10, 15, 30];
/** 默认原画质：按设备分辨率出图，不做长边压采样。 */
const CAPTURE_QUALITY = 0.85;
const CAMERA_REFRESH_INTERVAL = 2000;
const MINI_PREVIEW_HIDE_STYLE_ID = 'camera-preview-hide-editor-mini-style';
/** 编辑器小窗：.float-window 内的 .camera-preview；本扩展面板根节点是 game-preview-panel，不会被匹配。 */
const EDITOR_MINI_SELECTORS = ['.float-window[camera]', '.float-window .camera-preview'];
const MINI_PREVIEW_CSS = `
.float-window[camera],
.float-window:has(.camera-preview) {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}
.float-window .camera-preview {
    display: none !important;
    visibility: hidden !important;
}
`;

function getCandidateDocuments(): Document[] {
    const docs: Document[] = [];
    const add = (doc: Document | null | undefined) => {
        if (doc && !docs.includes(doc)) {
            docs.push(doc);
        }
    };
    try {
        add(globalThis.document);
    } catch {
        // ignore
    }
    try {
        add((globalThis as any).parent?.document);
    } catch {
        // ignore
    }
    try {
        add((globalThis as any).top?.document);
    } catch {
        // ignore
    }
    return docs;
}

function injectHideStyle(doc: Document): void {
    let style = doc.getElementById(MINI_PREVIEW_HIDE_STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
        style = doc.createElement('style');
        style.id = MINI_PREVIEW_HIDE_STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
    }
    style.textContent = MINI_PREVIEW_CSS;
}

function removeHideStyle(doc: Document): void {
    doc.getElementById(MINI_PREVIEW_HIDE_STYLE_ID)?.remove();
}

function hideFloatWindowElement(el: Element): void {
    const win = (el.closest?.('.float-window') as HTMLElement | null) || (el as HTMLElement);
    if (!win || !win.classList?.contains('float-window')) {
        // 只动 float-window，避免误伤其它节点
        const nested = el.querySelector?.('.float-window') as HTMLElement | null;
        if (!nested) {
            return;
        }
        hideFloatWindowElement(nested);
        return;
    }
    win.setAttribute('hidden', '');
    win.setAttribute('data-game-preview-suppressed', '1');
    win.style.setProperty('display', 'none', 'important');
    win.style.setProperty('visibility', 'hidden', 'important');
    win.style.setProperty('opacity', '0', 'important');
    win.style.setProperty('pointer-events', 'none', 'important');
}

function restoreFloatWindowElement(el: Element): void {
    const win = (el.classList?.contains('float-window') ? el : el.closest?.('.float-window')) as HTMLElement | null;
    if (!win || win.getAttribute('data-game-preview-suppressed') !== '1') {
        return;
    }
    win.removeAttribute('hidden');
    win.removeAttribute('data-game-preview-suppressed');
    win.style.removeProperty('display');
    win.style.removeProperty('visibility');
    win.style.removeProperty('opacity');
    win.style.removeProperty('pointer-events');
}

function collectElements(result: HTMLElement[][] | HTMLElement[] | void | null): HTMLElement[] {
    if (!result || !Array.isArray(result)) {
        return [];
    }
    const list: HTMLElement[] = [];
    for (const item of result) {
        if (!item) {
            continue;
        }
        if (Array.isArray(item)) {
            for (const el of item) {
                if (el) {
                    list.push(el);
                }
            }
        } else {
            list.push(item as HTMLElement);
        }
    }
    return list;
}

/**
 * @zh 隐藏/恢复场景面板右下角相机小窗。
 * 开启游戏预览时 hidden=true；关闭游戏预览时 hidden=false，交还编辑器正常触发。
 */
async function setEditorMiniPreviewDomHidden(hidden: boolean): Promise<void> {
    const docs = getCandidateDocuments();

    if (hidden) {
        for (const doc of docs) {
            injectHideStyle(doc);
        }
        try {
            await Editor.Panel.close('scene.preview');
        } catch {
            // ignore
        }
    } else {
        for (const doc of docs) {
            removeHideStyle(doc);
            doc.querySelectorAll('.float-window[data-game-preview-suppressed="1"]').forEach((node) => {
                restoreFloatWindowElement(node);
            });
        }
    }

    for (const selector of EDITOR_MINI_SELECTORS) {
        try {
            const queried = await Editor.Panel.querySelector('scene', selector);
            for (const el of collectElements(queried as any)) {
                try {
                    const doc = el.ownerDocument;
                    if (doc) {
                        if (hidden) {
                            injectHideStyle(doc);
                        } else {
                            removeHideStyle(doc);
                        }
                    }
                } catch {
                    // ignore
                }
                if (hidden) {
                    hideFloatWindowElement(el);
                } else {
                    restoreFloatWindowElement(el);
                }
            }
        } catch {
            // ignore
        }

        for (const doc of docs) {
            doc.querySelectorAll(selector).forEach((node) => {
                if (hidden) {
                    hideFloatWindowElement(node);
                } else {
                    restoreFloatWindowElement(node);
                }
            });
        }
    }
}

// 设备管理器不可用时的兜底列表
const FALLBACK_DEVICES: IDeviceItem[] = [
    { name: 'iPhone X', width: 1125, height: 2436, ratio: 3 },
    { name: 'iPhone 6', width: 750, height: 1334, ratio: 2 },
    { name: 'iPad', width: 1536, height: 2048, ratio: 2 },
];

const DEFAULT_SETTINGS: IPanelSettings = {
    deviceKey: '',
    cameraUuid: '',
    landscape: false,
    mode: 'all',
    fps: 5,
};

function translate(key: string): string {
    return Editor.I18n.t(`${PACKAGE_NAME}.${key}`);
}

function escapeHtml(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function getDeviceKey(device: IDeviceItem): string {
    return `${device.name}|${device.width}x${device.height}`;
}

/**
 * @zh ui-button 点击时可能同时抛出 confirm 和 click，两个都监听并做去重，避免依赖具体实现。
 */
function onClick(element: any, handler: () => void): void {
    let lastTime = 0;
    const invoke = () => {
        const now = Date.now();
        if (now - lastTime < 50) {
            return;
        }
        lastTime = now;
        handler();
    };
    element.addEventListener('confirm', invoke);
    element.addEventListener('click', invoke);
}

/**
 * @zh 取值类组件的两种事件都监听，处理函数本身是幂等的。
 */
function onValueChange(element: any, handler: (event: any) => void): void {
    element.addEventListener('change', handler);
    element.addEventListener('confirm', handler);
}

class CameraPreviewPanel {
    private readonly $: Record<string, any>;
    private settings: IPanelSettings = { ...DEFAULT_SETTINGS };
    private devices: IDeviceItem[] = [];
    private cameras: ICameraInfo[] = [];
    private visible = true;
    private sceneReady = false;
    private capturing = false;
    private captureTimer = 0;
    private cameraTimer = 0;
    private stopVersion = 0;
    private readonly onSceneReady = (): void => {
        this.handleSceneReady();
    };
    private readonly onSceneClose = (): void => {
        this.handleSceneClose();
    };
    private readonly onSelectionChange = (): void => {
        // 选中 Camera 时编辑器会尝试弹小窗；事件驱动压制，不再轮询
        if (this.visible) {
            void this.setEditorCameraMiniPreviewHidden(true);
        }
    };

    private hasPreviewFrame(): boolean {
        const preview = this.$.preview as HTMLImageElement;
        const src = preview?.getAttribute?.('src') || '';
        return !!(src && preview.style.visibility !== 'hidden');
    }

    constructor(elements: Record<string, any>) {
        this.$ = elements;
    }

    async init(): Promise<void> {
        this.applyTexts();
        this.bindEvents();
        const message = Editor.Message as any;
        message.addBroadcastListener('scene:ready', this.onSceneReady);
        message.addBroadcastListener('scene:close', this.onSceneClose);
        message.addBroadcastListener('selection:select', this.onSelectionChange);
        await this.loadSettings();
        this.fillFixedSelects();
        await this.refreshDevices();
        this.syncControls();
        // 面板打开即隐藏编辑器相机小窗
        void this.setEditorCameraMiniPreviewHidden(true);
        // 面板可能在场景已就绪后才打开，广播已经错过，主动探测一次
        if (await this.probeSceneReady()) {
            this.handleSceneReady();
        } else {
            this.showPlaceholder(translate('waiting_scene'));
        }
    }

    dispose(): void {
        this.visible = false;
        this.sceneReady = false;
        const message = Editor.Message as any;
        message.removeBroadcastListener('scene:ready', this.onSceneReady);
        message.removeBroadcastListener('scene:close', this.onSceneClose);
        message.removeBroadcastListener('selection:select', this.onSelectionChange);
        this.stopPreviewTimers();
        this.clearPreviewImage();
        void this.setEditorCameraMiniPreviewHidden(false);
        void this.stopScene();
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) {
            this.stopVersion++;
            void this.setEditorCameraMiniPreviewHidden(true);
            if (this.sceneReady) {
                void this.refreshCameras();
                this.restartPreviewTimers();
                void this.capture();
            } else {
                this.showPlaceholder(translate('waiting_scene'));
            }
        } else {
            void this.setEditorCameraMiniPreviewHidden(false);
            void this.stopScene();
        }
    }

    private handleSceneReady(): void {
        this.sceneReady = true;
        if (!this.visible) {
            return;
        }
        void this.setEditorCameraMiniPreviewHidden(true);
        void this.refreshCameras();
        this.restartPreviewTimers();
        void this.capture();
    }

    /**
     * @zh 游戏预览开启时隐藏场景右下角相机小窗；关闭预览后恢复显示。
     * 仅在 show/hide、scene:ready、selection 时触发，不再定时轮询。
     */
    private async setEditorCameraMiniPreviewHidden(hidden: boolean): Promise<void> {
        try {
            Editor.Message.broadcast('camera-preview:set-mini-hidden', hidden);
        } catch {
            // ignore
        }
        await setEditorMiniPreviewDomHidden(hidden);

        try {
            await this.executeSceneScript('setMiniPreviewSuppressed', [hidden]);
        } catch {
            // 场景未就绪时忽略，scene:ready 后会再设一次
        }

        if (hidden && this.visible) {
            try {
                await this.executeSceneScript('hideEditorMiniPreview', []);
            } catch {
                // ignore
            }
        }
    }

    private handleSceneClose(): void {
        this.sceneReady = false;
        this.stopPreviewTimers();
        this.cameras = [];
        if (this.visible) {
            this.showPlaceholder(translate('waiting_scene'));
        }
        void this.stopScene(true);
    }

    private async probeSceneReady(): Promise<boolean> {
        try {
            await this.executeSceneScript('queryCameras', []);
            return true;
        } catch {
            return false;
        }
    }

    private restartPreviewTimers(): void {
        this.restartCaptureTimer();
        window.clearInterval(this.cameraTimer);
        this.cameraTimer = window.setInterval(() => {
            if (this.visible && this.sceneReady) {
                void this.refreshCameras();
            }
        }, CAMERA_REFRESH_INTERVAL);
    }

    private stopPreviewTimers(): void {
        window.clearInterval(this.captureTimer);
        window.clearInterval(this.cameraTimer);
        this.captureTimer = 0;
        this.cameraTimer = 0;
    }

    /**
     * @zh 通知场景进程把相机从预览窗口上摘回去，不预览时不占用任何渲染开销
     */
    private async stopScene(force = false): Promise<void> {
        const stopVersion = ++this.stopVersion;
        while (this.capturing) {
            await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
        }
        if (stopVersion !== this.stopVersion) {
            return;
        }
        // 面板仍可见时默认不 stop（还会继续预览）；场景关闭时强制摘回
        if (!force && this.visible) {
            return;
        }
        await this.executeSceneScript('stop', []).catch(() => {});
    }

    private applyTexts(): void {
        this.$.labelCamera.textContent = translate('camera');
        this.$.labelResolution.textContent = translate('resolution');
        this.$.labelMode.textContent = translate('full_scene');
        this.$.labelFps.textContent = translate('fps');
        this.$.refreshButton.textContent = translate('refresh');
        this.$.rotateButton.textContent = translate('rotate');
        this.$.placeholder.textContent = translate('loading');
    }

    private bindEvents(): void {
        onValueChange(this.$.cameraSelect, (event: any) => {
            this.settings.cameraUuid = String(event.target.value || '');
            void this.saveSettings();
            void this.capture();
        });
        onValueChange(this.$.deviceSelect, (event: any) => {
            this.settings.deviceKey = String(event.target.value || '');
            void this.saveSettings();
            this.updateStatus();
            void this.capture();
        });
        onValueChange(this.$.modeCheckbox, (event: any) => {
            this.settings.mode = event.target.value ? 'all' : 'single';
            this.syncControls();
            void this.saveSettings();
            void this.capture();
        });
        onValueChange(this.$.fpsSelect, (event: any) => {
            this.settings.fps = Number(event.target.value) || DEFAULT_SETTINGS.fps;
            this.restartCaptureTimer();
            void this.saveSettings();
        });
        onClick(this.$.refreshButton, () => {
            void this.refreshDevices();
            void this.refreshCameras();
            void this.capture();
        });
        onClick(this.$.rotateButton, () => {
            this.settings.landscape = !this.settings.landscape;
            void this.saveSettings();
            this.updateStatus();
            void this.capture();
        });
    }

    private async loadSettings(): Promise<void> {
        try {
            const saved = await Editor.Profile.getConfig(PACKAGE_NAME, 'settings', 'local');
            if (saved && typeof saved === 'object') {
                this.settings = { ...DEFAULT_SETTINGS, ...saved };
            }
        } catch (error) {
            console.warn(`[${PACKAGE_NAME}]`, error);
        }
    }

    private async saveSettings(): Promise<void> {
        try {
            await Editor.Profile.setConfig(PACKAGE_NAME, 'settings', { ...this.settings }, 'local');
        } catch (error) {
            console.warn(`[${PACKAGE_NAME}]`, error);
        }
    }

    private fillFixedSelects(): void {
        this.$.fpsSelect.innerHTML = FPS_OPTIONS.map((fps) => `<option value="${fps}">${fps} FPS</option>`).join('');
        this.$.fpsSelect.value = String(this.settings.fps);
        this.$.modeCheckbox.value = this.settings.mode === 'all';
    }

    private async refreshDevices(): Promise<void> {
        let devices: IDeviceItem[] = [];
        try {
            devices = await Editor.Message.request('device', 'query');
        } catch (error) {
            console.warn(`[${PACKAGE_NAME}]`, error);
        }
        if (!Array.isArray(devices)) {
            devices = [];
        }
        devices = devices.filter((device) => device && device.width > 0 && device.height > 0);
        this.devices = devices.length > 0 ? devices : FALLBACK_DEVICES;

        const options = this.devices
            .map((device) => {
                const key = escapeHtml(getDeviceKey(device));
                const label = escapeHtml(`${device.name} (${device.width}x${device.height})`);
                return `<option value="${key}">${label}</option>`;
            })
            .join('');
        this.$.deviceSelect.innerHTML = options;

        if (!this.devices.some((device) => getDeviceKey(device) === this.settings.deviceKey)) {
            this.settings.deviceKey = getDeviceKey(this.devices[0]);
        }
        this.$.deviceSelect.value = this.settings.deviceKey;
        this.updateStatus();
    }

    private async refreshCameras(): Promise<void> {
        if (!this.sceneReady) {
            return;
        }
        let cameras: ICameraInfo[] = [];
        try {
            cameras = await this.executeSceneScript<ICameraInfo[]>('queryCameras', []);
        } catch (error) {
            // 场景还没打开或正在切换时查询会失败，按没有相机处理即可
            cameras = [];
        }
        if (!Array.isArray(cameras)) {
            cameras = [];
        }
        const changed =
            cameras.length !== this.cameras.length ||
            cameras.some((camera, index) => camera.uuid !== this.cameras[index].uuid || camera.path !== this.cameras[index].path);
        this.cameras = cameras;
        if (!changed) {
            return;
        }

        if (cameras.length === 0) {
            this.$.cameraSelect.innerHTML = '';
            this.settings.cameraUuid = '';
            if (this.visible) {
                this.showPlaceholder(translate('no_camera'));
            }
            return;
        }

        this.$.cameraSelect.innerHTML = cameras
            .map((camera) => {
                const suffix = camera.enabled ? '' : ` (${translate('disabled')})`;
                return `<option value="${escapeHtml(camera.uuid)}">${escapeHtml(camera.path || camera.name)}${suffix}</option>`;
            })
            .join('');
        if (!cameras.some((camera) => camera.uuid === this.settings.cameraUuid)) {
            this.settings.cameraUuid = cameras.length > 0 ? cameras[0].uuid : '';
        }
        this.$.cameraSelect.value = this.settings.cameraUuid;
    }

    private syncControls(): void {
        const singleMode = this.settings.mode === 'single';
        if (singleMode) {
            this.$.cameraSelect.removeAttribute('disabled');
        } else {
            this.$.cameraSelect.setAttribute('disabled', '');
        }
    }

    private restartCaptureTimer(): void {
        window.clearInterval(this.captureTimer);
        // 原画质单帧更贵：间隔至少 100ms，且上一帧未完成则自然跳过
        const interval = Math.max(100, Math.round(1000 / this.settings.fps));
        this.captureTimer = window.setInterval(() => {
            void this.capture();
        }, interval);
    }

    private executeSceneScript<T>(method: string, args: any[]): Promise<T> {
        return Editor.Message.request('scene', 'execute-scene-script', {
            name: PACKAGE_NAME,
            method,
            args,
        });
    }

    private currentDevice(): IDeviceItem | null {
        return this.devices.find((device) => getDeviceKey(device) === this.settings.deviceKey) || null;
    }

    private currentResolution(): { width: number; height: number } | null {
        const device = this.currentDevice();
        if (!device) {
            return null;
        }
        return this.settings.landscape
            ? { width: device.height, height: device.width }
            : { width: device.width, height: device.height };
    }

    private clearPreviewImage(): void {
        const preview = this.$.preview as HTMLImageElement;
        if (preview) {
            preview.removeAttribute('src');
        }
    }

    private showPreviewDataUrl(dataUrl: string): void {
        const preview = this.$.preview as HTMLImageElement;
        preview.src = dataUrl;
        preview.style.visibility = 'visible';
        this.$.placeholder.textContent = '';
    }

    private async capture(): Promise<void> {
        if (!this.visible || !this.sceneReady || this.capturing) {
            return;
        }
        const resolution = this.currentResolution();
        if (!resolution) {
            return;
        }
        // 默认原画质：按所选设备分辨率直接出图
        const width = Math.max(1, Math.round(resolution.width));
        const height = Math.max(1, Math.round(resolution.height));

        this.capturing = true;
        try {
            const result = await this.executeSceneScript<ICaptureResult | null>('capture', [
                {
                    mode: this.settings.mode,
                    cameraUuid: this.settings.cameraUuid,
                    width,
                    height,
                    quality: CAPTURE_QUALITY,
                },
            ]);
            if (!this.visible) {
                return;
            }
            if (!result) {
                return;
            }
            if (!result.cameraCount) {
                this.showPlaceholder(translate('no_camera'));
                return;
            }
            if (result.unchanged) {
                this.updateStatus(result);
                return;
            }
            if (!result.dataUrl) {
                if (!this.hasPreviewFrame()) {
                    this.showPlaceholder(translate('no_camera'));
                }
                return;
            }
            this.showPreviewDataUrl(result.dataUrl);
            this.updateStatus(result);
        } catch (error: any) {
            if (this.visible && !this.hasPreviewFrame()) {
                this.showPlaceholder(error && error.message ? error.message : String(error));
            }
        } finally {
            this.capturing = false;
        }
    }

    private showPlaceholder(message: string): void {
        this.clearPreviewImage();
        this.$.preview.style.visibility = 'hidden';
        this.$.placeholder.textContent = message;
    }

    private updateStatus(result?: ICaptureResult): void {
        const resolution = this.currentResolution();
        if (!resolution) {
            this.$.status.textContent = '';
            return;
        }
        const parts = [`${resolution.width} x ${resolution.height}`];
        if (result) {
            parts.push(`${result.width}x${result.height}`);
            parts.push(`${translate('camera')}: ${result.cameraCount}`);
        }
        this.$.status.textContent = parts.join('    ');
    }
}

let currentPanel: CameraPreviewPanel | null = null;

module.exports = Editor.Panel.define({
    listeners: {
        show() {
            currentPanel?.setVisible(true);
        },
        hide() {
            currentPanel?.setVisible(false);
        },
    },
    template: readFileSync(join(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: readFileSync(join(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
    $: {
        labelCamera: '#labelCamera',
        labelResolution: '#labelResolution',
        labelMode: '#labelMode',
        labelFps: '#labelFps',
        cameraSelect: '#cameraSelect',
        deviceSelect: '#deviceSelect',
        refreshButton: '#refreshButton',
        rotateButton: '#rotateButton',
        modeCheckbox: '#modeCheckbox',
        fpsSelect: '#fpsSelect',
        preview: '#preview',
        placeholder: '#placeholder',
        status: '#status',
    },
    methods: {},
    ready() {
        currentPanel = new CameraPreviewPanel(this.$ as Record<string, any>);
        void currentPanel.init();
    },
    beforeClose() {},
    close() {
        currentPanel?.dispose();
        currentPanel = null;
    },
});

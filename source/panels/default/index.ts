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
const RENDER_LIMIT = 1080;
const CAPTURE_QUALITY = 0.8;
const CAMERA_REFRESH_INTERVAL = 2000;

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
    fps: 10,
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

    constructor(elements: Record<string, any>) {
        this.$ = elements;
    }

    async init(): Promise<void> {
        this.applyTexts();
        this.bindEvents();
        const message = Editor.Message as any;
        message.addBroadcastListener('scene:ready', this.onSceneReady);
        message.addBroadcastListener('scene:close', this.onSceneClose);
        await this.loadSettings();
        this.fillFixedSelects();
        await this.refreshDevices();
        this.syncControls();
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
        this.stopPreviewTimers();
        void this.stopScene();
    }

    setVisible(visible: boolean): void {
        this.visible = visible;
        if (visible) {
            this.stopVersion++;
            if (this.sceneReady) {
                void this.refreshCameras();
                void this.capture();
            } else {
                this.showPlaceholder(translate('waiting_scene'));
            }
        } else {
            void this.stopScene();
        }
    }

    private handleSceneReady(): void {
        this.sceneReady = true;
        if (!this.visible) {
            return;
        }
        void this.refreshCameras();
        this.restartPreviewTimers();
        void this.capture();
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
        const interval = Math.max(16, Math.round(1000 / this.settings.fps));
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

    private async capture(): Promise<void> {
        if (!this.visible || !this.sceneReady || this.capturing) {
            return;
        }
        const resolution = this.currentResolution();
        if (!resolution) {
            return;
        }
        // 渲染尺寸按最长边 1080 等比缩放，画面比例与所选分辨率一致
        const scale = Math.min(1, RENDER_LIMIT / Math.max(resolution.width, resolution.height));
        const width = Math.max(1, Math.round(resolution.width * scale));
        const height = Math.max(1, Math.round(resolution.height * scale));

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
            if (!result || !result.dataUrl) {
                this.showPlaceholder(translate('no_camera'));
                return;
            }
            this.$.preview.src = result.dataUrl;
            this.$.preview.style.visibility = 'visible';
            this.$.placeholder.textContent = '';
            this.updateStatus(result);
        } catch (error: any) {
            if (this.visible) {
                this.showPlaceholder(error && error.message ? error.message : String(error));
            }
        } finally {
            this.capturing = false;
        }
    }

    private showPlaceholder(message: string): void {
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

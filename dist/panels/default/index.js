"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const constants_1 = require("../../constants");
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
function getCandidateDocuments() {
    var _a, _b;
    const docs = [];
    const add = (doc) => {
        if (doc && !docs.includes(doc)) {
            docs.push(doc);
        }
    };
    try {
        add(globalThis.document);
    }
    catch (_c) {
        // ignore
    }
    try {
        add((_a = globalThis.parent) === null || _a === void 0 ? void 0 : _a.document);
    }
    catch (_d) {
        // ignore
    }
    try {
        add((_b = globalThis.top) === null || _b === void 0 ? void 0 : _b.document);
    }
    catch (_e) {
        // ignore
    }
    return docs;
}
function injectHideStyle(doc) {
    let style = doc.getElementById(MINI_PREVIEW_HIDE_STYLE_ID);
    if (!style) {
        style = doc.createElement('style');
        style.id = MINI_PREVIEW_HIDE_STYLE_ID;
        (doc.head || doc.documentElement).appendChild(style);
    }
    style.textContent = MINI_PREVIEW_CSS;
}
function removeHideStyle(doc) {
    var _a;
    (_a = doc.getElementById(MINI_PREVIEW_HIDE_STYLE_ID)) === null || _a === void 0 ? void 0 : _a.remove();
}
function hideFloatWindowElement(el) {
    var _a, _b, _c;
    const win = ((_a = el.closest) === null || _a === void 0 ? void 0 : _a.call(el, '.float-window')) || el;
    if (!win || !((_b = win.classList) === null || _b === void 0 ? void 0 : _b.contains('float-window'))) {
        // 只动 float-window，避免误伤其它节点
        const nested = (_c = el.querySelector) === null || _c === void 0 ? void 0 : _c.call(el, '.float-window');
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
function restoreFloatWindowElement(el) {
    var _a, _b;
    const win = (((_a = el.classList) === null || _a === void 0 ? void 0 : _a.contains('float-window')) ? el : (_b = el.closest) === null || _b === void 0 ? void 0 : _b.call(el, '.float-window'));
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
function collectElements(result) {
    if (!result || !Array.isArray(result)) {
        return [];
    }
    const list = [];
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
        }
        else {
            list.push(item);
        }
    }
    return list;
}
/**
 * @zh 隐藏/恢复场景面板右下角相机小窗。
 * 开启游戏预览时 hidden=true；关闭游戏预览时 hidden=false，交还编辑器正常触发。
 */
async function setEditorMiniPreviewDomHidden(hidden) {
    const docs = getCandidateDocuments();
    if (hidden) {
        for (const doc of docs) {
            injectHideStyle(doc);
        }
        try {
            await Editor.Panel.close('scene.preview');
        }
        catch (_a) {
            // ignore
        }
    }
    else {
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
            for (const el of collectElements(queried)) {
                try {
                    const doc = el.ownerDocument;
                    if (doc) {
                        if (hidden) {
                            injectHideStyle(doc);
                        }
                        else {
                            removeHideStyle(doc);
                        }
                    }
                }
                catch (_b) {
                    // ignore
                }
                if (hidden) {
                    hideFloatWindowElement(el);
                }
                else {
                    restoreFloatWindowElement(el);
                }
            }
        }
        catch (_c) {
            // ignore
        }
        for (const doc of docs) {
            doc.querySelectorAll(selector).forEach((node) => {
                if (hidden) {
                    hideFloatWindowElement(node);
                }
                else {
                    restoreFloatWindowElement(node);
                }
            });
        }
    }
}
// 设备管理器不可用时的兜底列表
const FALLBACK_DEVICES = [
    { name: 'iPhone X', width: 1125, height: 2436, ratio: 3 },
    { name: 'iPhone 6', width: 750, height: 1334, ratio: 2 },
    { name: 'iPad', width: 1536, height: 2048, ratio: 2 },
];
const DEFAULT_SETTINGS = {
    deviceKey: '',
    cameraUuid: '',
    landscape: false,
    mode: 'all',
    fps: 5,
};
function translate(key) {
    return Editor.I18n.t(`${constants_1.PACKAGE_NAME}.${key}`);
}
function escapeHtml(text) {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function getDeviceKey(device) {
    return `${device.name}|${device.width}x${device.height}`;
}
/**
 * @zh ui-button 点击时可能同时抛出 confirm 和 click，两个都监听并做去重，避免依赖具体实现。
 */
function onClick(element, handler) {
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
function onValueChange(element, handler) {
    element.addEventListener('change', handler);
    element.addEventListener('confirm', handler);
}
class CameraPreviewPanel {
    hasPreviewFrame() {
        var _a;
        const preview = this.$.preview;
        const src = ((_a = preview === null || preview === void 0 ? void 0 : preview.getAttribute) === null || _a === void 0 ? void 0 : _a.call(preview, 'src')) || '';
        return !!(src && preview.style.visibility !== 'hidden');
    }
    constructor(elements) {
        this.settings = Object.assign({}, DEFAULT_SETTINGS);
        this.devices = [];
        this.cameras = [];
        this.visible = true;
        this.sceneReady = false;
        this.capturing = false;
        this.captureTimer = 0;
        this.cameraTimer = 0;
        this.stopVersion = 0;
        this.onSceneReady = () => {
            this.handleSceneReady();
        };
        this.onSceneClose = () => {
            this.handleSceneClose();
        };
        this.onSelectionChange = () => {
            // 选中 Camera 时编辑器会尝试弹小窗；事件驱动压制，不再轮询
            if (this.visible) {
                void this.setEditorCameraMiniPreviewHidden(true);
            }
        };
        this.$ = elements;
    }
    async init() {
        this.applyTexts();
        this.bindEvents();
        const message = Editor.Message;
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
        }
        else {
            this.showPlaceholder(translate('waiting_scene'));
        }
    }
    dispose() {
        this.visible = false;
        this.sceneReady = false;
        const message = Editor.Message;
        message.removeBroadcastListener('scene:ready', this.onSceneReady);
        message.removeBroadcastListener('scene:close', this.onSceneClose);
        message.removeBroadcastListener('selection:select', this.onSelectionChange);
        this.stopPreviewTimers();
        this.clearPreviewImage();
        void this.setEditorCameraMiniPreviewHidden(false);
        void this.stopScene();
    }
    setVisible(visible) {
        this.visible = visible;
        if (visible) {
            this.stopVersion++;
            void this.setEditorCameraMiniPreviewHidden(true);
            if (this.sceneReady) {
                void this.refreshCameras();
                this.restartPreviewTimers();
                void this.capture();
            }
            else {
                this.showPlaceholder(translate('waiting_scene'));
            }
        }
        else {
            void this.setEditorCameraMiniPreviewHidden(false);
            void this.stopScene();
        }
    }
    handleSceneReady() {
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
    async setEditorCameraMiniPreviewHidden(hidden) {
        try {
            Editor.Message.broadcast('camera-preview:set-mini-hidden', hidden);
        }
        catch (_a) {
            // ignore
        }
        await setEditorMiniPreviewDomHidden(hidden);
        try {
            await this.executeSceneScript('setMiniPreviewSuppressed', [hidden]);
        }
        catch (_b) {
            // 场景未就绪时忽略，scene:ready 后会再设一次
        }
        if (hidden && this.visible) {
            try {
                await this.executeSceneScript('hideEditorMiniPreview', []);
            }
            catch (_c) {
                // ignore
            }
        }
    }
    handleSceneClose() {
        this.sceneReady = false;
        this.stopPreviewTimers();
        this.cameras = [];
        if (this.visible) {
            this.showPlaceholder(translate('waiting_scene'));
        }
        void this.stopScene(true);
    }
    async probeSceneReady() {
        try {
            await this.executeSceneScript('queryCameras', []);
            return true;
        }
        catch (_a) {
            return false;
        }
    }
    restartPreviewTimers() {
        this.restartCaptureTimer();
        window.clearInterval(this.cameraTimer);
        this.cameraTimer = window.setInterval(() => {
            if (this.visible && this.sceneReady) {
                void this.refreshCameras();
            }
        }, CAMERA_REFRESH_INTERVAL);
    }
    stopPreviewTimers() {
        window.clearInterval(this.captureTimer);
        window.clearInterval(this.cameraTimer);
        this.captureTimer = 0;
        this.cameraTimer = 0;
    }
    /**
     * @zh 通知场景进程把相机从预览窗口上摘回去，不预览时不占用任何渲染开销
     */
    async stopScene(force = false) {
        const stopVersion = ++this.stopVersion;
        while (this.capturing) {
            await new Promise((resolve) => window.setTimeout(resolve, 0));
        }
        if (stopVersion !== this.stopVersion) {
            return;
        }
        // 面板仍可见时默认不 stop（还会继续预览）；场景关闭时强制摘回
        if (!force && this.visible) {
            return;
        }
        await this.executeSceneScript('stop', []).catch(() => { });
    }
    applyTexts() {
        this.$.labelCamera.textContent = translate('camera');
        this.$.labelResolution.textContent = translate('resolution');
        this.$.labelMode.textContent = translate('full_scene');
        this.$.labelFps.textContent = translate('fps');
        this.$.refreshButton.textContent = translate('refresh');
        this.$.rotateButton.textContent = translate('rotate');
        this.$.placeholder.textContent = translate('loading');
    }
    bindEvents() {
        onValueChange(this.$.cameraSelect, (event) => {
            this.settings.cameraUuid = String(event.target.value || '');
            void this.saveSettings();
            void this.capture();
        });
        onValueChange(this.$.deviceSelect, (event) => {
            this.settings.deviceKey = String(event.target.value || '');
            void this.saveSettings();
            this.updateStatus();
            void this.capture();
        });
        onValueChange(this.$.modeCheckbox, (event) => {
            this.settings.mode = event.target.value ? 'all' : 'single';
            this.syncControls();
            void this.saveSettings();
            void this.capture();
        });
        onValueChange(this.$.fpsSelect, (event) => {
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
    async loadSettings() {
        try {
            const saved = await Editor.Profile.getConfig(constants_1.PACKAGE_NAME, 'settings', 'local');
            if (saved && typeof saved === 'object') {
                this.settings = Object.assign(Object.assign({}, DEFAULT_SETTINGS), saved);
            }
        }
        catch (error) {
            console.warn(`[${constants_1.PACKAGE_NAME}]`, error);
        }
    }
    async saveSettings() {
        try {
            await Editor.Profile.setConfig(constants_1.PACKAGE_NAME, 'settings', Object.assign({}, this.settings), 'local');
        }
        catch (error) {
            console.warn(`[${constants_1.PACKAGE_NAME}]`, error);
        }
    }
    fillFixedSelects() {
        this.$.fpsSelect.innerHTML = FPS_OPTIONS.map((fps) => `<option value="${fps}">${fps} FPS</option>`).join('');
        this.$.fpsSelect.value = String(this.settings.fps);
        this.$.modeCheckbox.value = this.settings.mode === 'all';
    }
    async refreshDevices() {
        let devices = [];
        try {
            devices = await Editor.Message.request('device', 'query');
        }
        catch (error) {
            console.warn(`[${constants_1.PACKAGE_NAME}]`, error);
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
    async refreshCameras() {
        if (!this.sceneReady) {
            return;
        }
        let cameras = [];
        try {
            cameras = await this.executeSceneScript('queryCameras', []);
        }
        catch (error) {
            // 场景还没打开或正在切换时查询会失败，按没有相机处理即可
            cameras = [];
        }
        if (!Array.isArray(cameras)) {
            cameras = [];
        }
        const changed = cameras.length !== this.cameras.length ||
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
    syncControls() {
        const singleMode = this.settings.mode === 'single';
        if (singleMode) {
            this.$.cameraSelect.removeAttribute('disabled');
        }
        else {
            this.$.cameraSelect.setAttribute('disabled', '');
        }
    }
    restartCaptureTimer() {
        window.clearInterval(this.captureTimer);
        // 原画质单帧更贵：间隔至少 100ms，且上一帧未完成则自然跳过
        const interval = Math.max(100, Math.round(1000 / this.settings.fps));
        this.captureTimer = window.setInterval(() => {
            void this.capture();
        }, interval);
    }
    executeSceneScript(method, args) {
        return Editor.Message.request('scene', 'execute-scene-script', {
            name: constants_1.PACKAGE_NAME,
            method,
            args,
        });
    }
    currentDevice() {
        return this.devices.find((device) => getDeviceKey(device) === this.settings.deviceKey) || null;
    }
    currentResolution() {
        const device = this.currentDevice();
        if (!device) {
            return null;
        }
        return this.settings.landscape
            ? { width: device.height, height: device.width }
            : { width: device.width, height: device.height };
    }
    clearPreviewImage() {
        const preview = this.$.preview;
        if (preview) {
            preview.removeAttribute('src');
        }
    }
    showPreviewDataUrl(dataUrl) {
        const preview = this.$.preview;
        preview.src = dataUrl;
        preview.style.visibility = 'visible';
        this.$.placeholder.textContent = '';
    }
    async capture() {
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
            const result = await this.executeSceneScript('capture', [
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
        }
        catch (error) {
            if (this.visible && !this.hasPreviewFrame()) {
                this.showPlaceholder(error && error.message ? error.message : String(error));
            }
        }
        finally {
            this.capturing = false;
        }
    }
    showPlaceholder(message) {
        this.clearPreviewImage();
        this.$.preview.style.visibility = 'hidden';
        this.$.placeholder.textContent = message;
    }
    updateStatus(result) {
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
let currentPanel = null;
module.exports = Editor.Panel.define({
    listeners: {
        show() {
            currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.setVisible(true);
        },
        hide() {
            currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.setVisible(false);
        },
    },
    template: (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/template/default/index.html'), 'utf-8'),
    style: (0, fs_1.readFileSync)((0, path_1.join)(__dirname, '../../../static/style/default/index.css'), 'utf-8'),
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
        currentPanel = new CameraPreviewPanel(this.$);
        void currentPanel.init();
    },
    beforeClose() { },
    close() {
        currentPanel === null || currentPanel === void 0 ? void 0 : currentPanel.dispose();
        currentPanel = null;
    },
});
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLCtDQUErQztBQWtCL0MsTUFBTSxXQUFXLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDdkMsOEJBQThCO0FBQzlCLE1BQU0sZUFBZSxHQUFHLElBQUksQ0FBQztBQUM3QixNQUFNLHVCQUF1QixHQUFHLElBQUksQ0FBQztBQUNyQyxNQUFNLDBCQUEwQixHQUFHLHVDQUF1QyxDQUFDO0FBQzNFLGlGQUFpRjtBQUNqRixNQUFNLHFCQUFxQixHQUFHLENBQUMsdUJBQXVCLEVBQUUsK0JBQStCLENBQUMsQ0FBQztBQUN6RixNQUFNLGdCQUFnQixHQUFHOzs7Ozs7Ozs7Ozs7Q0FZeEIsQ0FBQztBQUVGLFNBQVMscUJBQXFCOztJQUMxQixNQUFNLElBQUksR0FBZSxFQUFFLENBQUM7SUFDNUIsTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFnQyxFQUFFLEVBQUU7UUFDN0MsSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDN0IsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBQ0YsSUFBSSxDQUFDO1FBQ0QsR0FBRyxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM3QixDQUFDO0lBQUMsV0FBTSxDQUFDO1FBQ0wsU0FBUztJQUNiLENBQUM7SUFDRCxJQUFJLENBQUM7UUFDRCxHQUFHLENBQUMsTUFBQyxVQUFrQixDQUFDLE1BQU0sMENBQUUsUUFBUSxDQUFDLENBQUM7SUFDOUMsQ0FBQztJQUFDLFdBQU0sQ0FBQztRQUNM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LEVBQUUseUNBQXlDLENBQUMsRUFBRSxPQUFPLENBQUM7SUFDeEYsQ0FBQyxFQUFFO1FBQ0MsV0FBVyxFQUFFLGNBQWM7UUFDM0IsZUFBZSxFQUFFLGtCQUFrQjtRQUNuQyxTQUFTLEVBQUUsWUFBWTtRQUN2QixRQUFRLEVBQUUsV0FBVztRQUNyQixZQUFZLEVBQUUsZUFBZTtRQUM3QixZQUFZLEVBQUUsZUFBZTtRQUM3QixhQUFhLEVBQUUsZ0JBQWdCO1FBQy9CLFlBQVksRUFBRSxlQUFlO1FBQzdCLFlBQVksRUFBRSxlQUFlO1FBQzdCLFNBQVMsRUFBRSxZQUFZO1FBQ3ZCLE9BQU8sRUFBRSxVQUFVO1FBQ25CLFdBQVcsRUFBRSxjQUFjO1FBQzNCLE1BQU0sRUFBRSxTQUFTO0tBQ3BCO0lBQ0QsT0FBTyxFQUFFLEVBQUU7SUFDWCxLQUFLO1FBQ0QsWUFBWSxHQUFHLElBQUksa0JBQWtCLENBQUMsSUFBSSxDQUFDLENBQXdCLENBQUMsQ0FBQztRQUNyRSxLQUFLLFlBQVksQ0FBQyxJQUFJLEVBQUUsQ0FBQztJQUM3QixDQUFDO0lBQ0QsV0FBVyxLQUFJLENBQUM7SUFDaEIsS0FBSztRQUNELFlBQVksYUFBWixZQUFZLHVCQUFaLFlBQVksQ0FBRSxPQUFPLEVBQUUsQ0FBQztRQUN4QixZQUFZLEdBQUcsSUFBSSxDQUFDO0lBQ3hCLENBQUM7Q0FDSixDQUFDLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgeyByZWFkRmlsZVN5bmMgfSBmcm9tICdmcyc7XHJcbmltcG9ydCB7IGpvaW4gfSBmcm9tICdwYXRoJztcclxuaW1wb3J0IHsgUEFDS0FHRV9OQU1FIH0gZnJvbSAnLi4vLi4vY29uc3RhbnRzJztcclxuaW1wb3J0IHR5cGUgeyBJQ2FtZXJhSW5mbywgSUNhcHR1cmVSZXN1bHQsIFByZXZpZXdNb2RlIH0gZnJvbSAnLi4vLi4vdHlwZXMnO1xyXG5cclxuaW50ZXJmYWNlIElEZXZpY2VJdGVtIHtcclxuICAgIG5hbWU6IHN0cmluZztcclxuICAgIHdpZHRoOiBudW1iZXI7XHJcbiAgICBoZWlnaHQ6IG51bWJlcjtcclxuICAgIHJhdGlvOiBudW1iZXI7XHJcbn1cclxuXHJcbmludGVyZmFjZSBJUGFuZWxTZXR0aW5ncyB7XHJcbiAgICBkZXZpY2VLZXk6IHN0cmluZztcclxuICAgIGNhbWVyYVV1aWQ6IHN0cmluZztcclxuICAgIGxhbmRzY2FwZTogYm9vbGVhbjtcclxuICAgIG1vZGU6IFByZXZpZXdNb2RlO1xyXG4gICAgZnBzOiBudW1iZXI7XHJcbn1cclxuXHJcbmNvbnN0IEZQU19PUFRJT05TID0gWzEsIDUsIDEwLCAxNSwgMzBdO1xyXG4vKiog6buY6K6k5Y6f55S76LSo77ya5oyJ6K6+5aSH5YiG6L6o546H5Ye65Zu+77yM5LiN5YGa6ZW/6L655Y6L6YeH5qC344CCICovXHJcbmNvbnN0IENBUFRVUkVfUVVBTElUWSA9IDAuODU7XHJcbmNvbnN0IENBTUVSQV9SRUZSRVNIX0lOVEVSVkFMID0gMjAwMDtcclxuY29uc3QgTUlOSV9QUkVWSUVXX0hJREVfU1RZTEVfSUQgPSAnY2FtZXJhLXByZXZpZXctaGlkZS1lZGl0b3ItbWluaS1zdHlsZSc7XHJcbi8qKiDnvJbovpHlmajlsI/nqpfvvJouZmxvYXQtd2luZG93IOWGheeahCAuY2FtZXJhLXByZXZpZXfvvJvmnKzmianlsZXpnaLmnb/moLnoioLngrnmmK8gZ2FtZS1wcmV2aWV3LXBhbmVs77yM5LiN5Lya6KKr5Yy56YWN44CCICovXHJcbmNvbnN0IEVESVRPUl9NSU5JX1NFTEVDVE9SUyA9IFsnLmZsb2F0LXdpbmRvd1tjYW1lcmFdJywgJy5mbG9hdC13aW5kb3cgLmNhbWVyYS1wcmV2aWV3J107XHJcbmNvbnN0IE1JTklfUFJFVklFV19DU1MgPSBgXHJcbi5mbG9hdC13aW5kb3dbY2FtZXJhXSxcclxuLmZsb2F0LXdpbmRvdzpoYXMoLmNhbWVyYS1wcmV2aWV3KSB7XHJcbiAgICBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7XHJcbiAgICB2aXNpYmlsaXR5OiBoaWRkZW4gIWltcG9ydGFudDtcclxuICAgIG9wYWNpdHk6IDAgIWltcG9ydGFudDtcclxuICAgIHBvaW50ZXItZXZlbnRzOiBub25lICFpbXBvcnRhbnQ7XHJcbn1cclxuLmZsb2F0LXdpbmRvdyAuY2FtZXJhLXByZXZpZXcge1xyXG4gICAgZGlzcGxheTogbm9uZSAhaW1wb3J0YW50O1xyXG4gICAgdmlzaWJpbGl0eTogaGlkZGVuICFpbXBvcnRhbnQ7XHJcbn1cclxuYDtcclxuXHJcbmZ1bmN0aW9uIGdldENhbmRpZGF0ZURvY3VtZW50cygpOiBEb2N1bWVudFtdIHtcclxuICAgIGNvbnN0IGRvY3M6IERvY3VtZW50W10gPSBbXTtcclxuICAgIGNvbnN0IGFkZCA9IChkb2M6IERvY3VtZW50IHwgbnVsbCB8IHVuZGVmaW5lZCkgPT4ge1xyXG4gICAgICAgIGlmIChkb2MgJiYgIWRvY3MuaW5jbHVkZXMoZG9jKSkge1xyXG4gICAgICAgICAgICBkb2NzLnB1c2goZG9jKTtcclxuICAgICAgICB9XHJcbiAgICB9O1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBhZGQoZ2xvYmFsVGhpcy5kb2N1bWVudCk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBpZ25vcmVcclxuICAgIH1cclxuICAgIHRyeSB7XHJcbiAgICAgICAgYWRkKChnbG9iYWxUaGlzIGFzIGFueSkucGFyZW50Py5kb2N1bWVudCk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBpZ25vcmVcclxuICAgIH1cclxuICAgIHRyeSB7XHJcbiAgICAgICAgYWRkKChnbG9iYWxUaGlzIGFzIGFueSkudG9wPy5kb2N1bWVudCk7XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBpZ25vcmVcclxuICAgIH1cclxuICAgIHJldHVybiBkb2NzO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpbmplY3RIaWRlU3R5bGUoZG9jOiBEb2N1bWVudCk6IHZvaWQge1xyXG4gICAgbGV0IHN0eWxlID0gZG9jLmdldEVsZW1lbnRCeUlkKE1JTklfUFJFVklFV19ISURFX1NUWUxFX0lEKSBhcyBIVE1MU3R5bGVFbGVtZW50IHwgbnVsbDtcclxuICAgIGlmICghc3R5bGUpIHtcclxuICAgICAgICBzdHlsZSA9IGRvYy5jcmVhdGVFbGVtZW50KCdzdHlsZScpO1xyXG4gICAgICAgIHN0eWxlLmlkID0gTUlOSV9QUkVWSUVXX0hJREVfU1RZTEVfSUQ7XHJcbiAgICAgICAgKGRvYy5oZWFkIHx8IGRvYy5kb2N1bWVudEVsZW1lbnQpLmFwcGVuZENoaWxkKHN0eWxlKTtcclxuICAgIH1cclxuICAgIHN0eWxlLnRleHRDb250ZW50ID0gTUlOSV9QUkVWSUVXX0NTUztcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtb3ZlSGlkZVN0eWxlKGRvYzogRG9jdW1lbnQpOiB2b2lkIHtcclxuICAgIGRvYy5nZXRFbGVtZW50QnlJZChNSU5JX1BSRVZJRVdfSElERV9TVFlMRV9JRCk/LnJlbW92ZSgpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBoaWRlRmxvYXRXaW5kb3dFbGVtZW50KGVsOiBFbGVtZW50KTogdm9pZCB7XHJcbiAgICBjb25zdCB3aW4gPSAoZWwuY2xvc2VzdD8uKCcuZmxvYXQtd2luZG93JykgYXMgSFRNTEVsZW1lbnQgfCBudWxsKSB8fCAoZWwgYXMgSFRNTEVsZW1lbnQpO1xyXG4gICAgaWYgKCF3aW4gfHwgIXdpbi5jbGFzc0xpc3Q/LmNvbnRhaW5zKCdmbG9hdC13aW5kb3cnKSkge1xyXG4gICAgICAgIC8vIOWPquWKqCBmbG9hdC13aW5kb3fvvIzpgb/lhY3or6/kvKTlhbblroPoioLngrlcclxuICAgICAgICBjb25zdCBuZXN0ZWQgPSBlbC5xdWVyeVNlbGVjdG9yPy4oJy5mbG9hdC13aW5kb3cnKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XHJcbiAgICAgICAgaWYgKCFuZXN0ZWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBoaWRlRmxvYXRXaW5kb3dFbGVtZW50KG5lc3RlZCk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgd2luLnNldEF0dHJpYnV0ZSgnaGlkZGVuJywgJycpO1xyXG4gICAgd2luLnNldEF0dHJpYnV0ZSgnZGF0YS1nYW1lLXByZXZpZXctc3VwcHJlc3NlZCcsICcxJyk7XHJcbiAgICB3aW4uc3R5bGUuc2V0UHJvcGVydHkoJ2Rpc3BsYXknLCAnbm9uZScsICdpbXBvcnRhbnQnKTtcclxuICAgIHdpbi5zdHlsZS5zZXRQcm9wZXJ0eSgndmlzaWJpbGl0eScsICdoaWRkZW4nLCAnaW1wb3J0YW50Jyk7XHJcbiAgICB3aW4uc3R5bGUuc2V0UHJvcGVydHkoJ29wYWNpdHknLCAnMCcsICdpbXBvcnRhbnQnKTtcclxuICAgIHdpbi5zdHlsZS5zZXRQcm9wZXJ0eSgncG9pbnRlci1ldmVudHMnLCAnbm9uZScsICdpbXBvcnRhbnQnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzdG9yZUZsb2F0V2luZG93RWxlbWVudChlbDogRWxlbWVudCk6IHZvaWQge1xyXG4gICAgY29uc3Qgd2luID0gKGVsLmNsYXNzTGlzdD8uY29udGFpbnMoJ2Zsb2F0LXdpbmRvdycpID8gZWwgOiBlbC5jbG9zZXN0Py4oJy5mbG9hdC13aW5kb3cnKSkgYXMgSFRNTEVsZW1lbnQgfCBudWxsO1xyXG4gICAgaWYgKCF3aW4gfHwgd2luLmdldEF0dHJpYnV0ZSgnZGF0YS1nYW1lLXByZXZpZXctc3VwcHJlc3NlZCcpICE9PSAnMScpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICB3aW4ucmVtb3ZlQXR0cmlidXRlKCdoaWRkZW4nKTtcclxuICAgIHdpbi5yZW1vdmVBdHRyaWJ1dGUoJ2RhdGEtZ2FtZS1wcmV2aWV3LXN1cHByZXNzZWQnKTtcclxuICAgIHdpbi5zdHlsZS5yZW1vdmVQcm9wZXJ0eSgnZGlzcGxheScpO1xyXG4gICAgd2luLnN0eWxlLnJlbW92ZVByb3BlcnR5KCd2aXNpYmlsaXR5Jyk7XHJcbiAgICB3aW4uc3R5bGUucmVtb3ZlUHJvcGVydHkoJ29wYWNpdHknKTtcclxuICAgIHdpbi5zdHlsZS5yZW1vdmVQcm9wZXJ0eSgncG9pbnRlci1ldmVudHMnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gY29sbGVjdEVsZW1lbnRzKHJlc3VsdDogSFRNTEVsZW1lbnRbXVtdIHwgSFRNTEVsZW1lbnRbXSB8IHZvaWQgfCBudWxsKTogSFRNTEVsZW1lbnRbXSB7XHJcbiAgICBpZiAoIXJlc3VsdCB8fCAhQXJyYXkuaXNBcnJheShyZXN1bHQpKSB7XHJcbiAgICAgICAgcmV0dXJuIFtdO1xyXG4gICAgfVxyXG4gICAgY29uc3QgbGlzdDogSFRNTEVsZW1lbnRbXSA9IFtdO1xyXG4gICAgZm9yIChjb25zdCBpdGVtIG9mIHJlc3VsdCkge1xyXG4gICAgICAgIGlmICghaXRlbSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKEFycmF5LmlzQXJyYXkoaXRlbSkpIHtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBlbCBvZiBpdGVtKSB7XHJcbiAgICAgICAgICAgICAgICBpZiAoZWwpIHtcclxuICAgICAgICAgICAgICAgICAgICBsaXN0LnB1c2goZWwpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgbGlzdC5wdXNoKGl0ZW0gYXMgSFRNTEVsZW1lbnQpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiBsaXN0O1xyXG59XHJcblxyXG4vKipcclxuICogQHpoIOmakOiXjy/mgaLlpI3lnLrmma/pnaLmnb/lj7PkuIvop5Lnm7jmnLrlsI/nqpfjgIJcclxuICog5byA5ZCv5ri45oiP6aKE6KeI5pe2IGhpZGRlbj10cnVl77yb5YWz6Zet5ri45oiP6aKE6KeI5pe2IGhpZGRlbj1mYWxzZe+8jOS6pOi/mOe8lui+keWZqOato+W4uOinpuWPkeOAglxyXG4gKi9cclxuYXN5bmMgZnVuY3Rpb24gc2V0RWRpdG9yTWluaVByZXZpZXdEb21IaWRkZW4oaGlkZGVuOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICBjb25zdCBkb2NzID0gZ2V0Q2FuZGlkYXRlRG9jdW1lbnRzKCk7XHJcblxyXG4gICAgaWYgKGhpZGRlbikge1xyXG4gICAgICAgIGZvciAoY29uc3QgZG9jIG9mIGRvY3MpIHtcclxuICAgICAgICAgICAgaW5qZWN0SGlkZVN0eWxlKGRvYyk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IEVkaXRvci5QYW5lbC5jbG9zZSgnc2NlbmUucHJldmlldycpO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyBpZ25vcmVcclxuICAgICAgICB9XHJcbiAgICB9IGVsc2Uge1xyXG4gICAgICAgIGZvciAoY29uc3QgZG9jIG9mIGRvY3MpIHtcclxuICAgICAgICAgICAgcmVtb3ZlSGlkZVN0eWxlKGRvYyk7XHJcbiAgICAgICAgICAgIGRvYy5xdWVyeVNlbGVjdG9yQWxsKCcuZmxvYXQtd2luZG93W2RhdGEtZ2FtZS1wcmV2aWV3LXN1cHByZXNzZWQ9XCIxXCJdJykuZm9yRWFjaCgobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgcmVzdG9yZUZsb2F0V2luZG93RWxlbWVudChub2RlKTtcclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIGZvciAoY29uc3Qgc2VsZWN0b3Igb2YgRURJVE9SX01JTklfU0VMRUNUT1JTKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3QgcXVlcmllZCA9IGF3YWl0IEVkaXRvci5QYW5lbC5xdWVyeVNlbGVjdG9yKCdzY2VuZScsIHNlbGVjdG9yKTtcclxuICAgICAgICAgICAgZm9yIChjb25zdCBlbCBvZiBjb2xsZWN0RWxlbWVudHMocXVlcmllZCBhcyBhbnkpKSB7XHJcbiAgICAgICAgICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICAgICAgICAgIGNvbnN0IGRvYyA9IGVsLm93bmVyRG9jdW1lbnQ7XHJcbiAgICAgICAgICAgICAgICAgICAgaWYgKGRvYykge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICBpZiAoaGlkZGVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgICAgICBpbmplY3RIaWRlU3R5bGUoZG9jKTtcclxuICAgICAgICAgICAgICAgICAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIHJlbW92ZUhpZGVTdHlsZShkb2MpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgICAgICAgICAgLy8gaWdub3JlXHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBpZiAoaGlkZGVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGlkZUZsb2F0V2luZG93RWxlbWVudChlbCk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3RvcmVGbG9hdFdpbmRvd0VsZW1lbnQoZWwpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIC8vIGlnbm9yZVxyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgZm9yIChjb25zdCBkb2Mgb2YgZG9jcykge1xyXG4gICAgICAgICAgICBkb2MucXVlcnlTZWxlY3RvckFsbChzZWxlY3RvcikuZm9yRWFjaCgobm9kZSkgPT4ge1xyXG4gICAgICAgICAgICAgICAgaWYgKGhpZGRlbikge1xyXG4gICAgICAgICAgICAgICAgICAgIGhpZGVGbG9hdFdpbmRvd0VsZW1lbnQobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgIHJlc3RvcmVGbG9hdFdpbmRvd0VsZW1lbnQobm9kZSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH0pO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuLy8g6K6+5aSH566h55CG5Zmo5LiN5Y+v55So5pe255qE5YWc5bqV5YiX6KGoXHJcbmNvbnN0IEZBTExCQUNLX0RFVklDRVM6IElEZXZpY2VJdGVtW10gPSBbXHJcbiAgICB7IG5hbWU6ICdpUGhvbmUgWCcsIHdpZHRoOiAxMTI1LCBoZWlnaHQ6IDI0MzYsIHJhdGlvOiAzIH0sXHJcbiAgICB7IG5hbWU6ICdpUGhvbmUgNicsIHdpZHRoOiA3NTAsIGhlaWdodDogMTMzNCwgcmF0aW86IDIgfSxcclxuICAgIHsgbmFtZTogJ2lQYWQnLCB3aWR0aDogMTUzNiwgaGVpZ2h0OiAyMDQ4LCByYXRpbzogMiB9LFxyXG5dO1xyXG5cclxuY29uc3QgREVGQVVMVF9TRVRUSU5HUzogSVBhbmVsU2V0dGluZ3MgPSB7XHJcbiAgICBkZXZpY2VLZXk6ICcnLFxyXG4gICAgY2FtZXJhVXVpZDogJycsXHJcbiAgICBsYW5kc2NhcGU6IGZhbHNlLFxyXG4gICAgbW9kZTogJ2FsbCcsXHJcbiAgICBmcHM6IDUsXHJcbn07XHJcblxyXG5mdW5jdGlvbiB0cmFuc2xhdGUoa2V5OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIEVkaXRvci5JMThuLnQoYCR7UEFDS0FHRV9OQU1FfS4ke2tleX1gKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHRleHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpLnJlcGxhY2UoL1wiL2csICcmcXVvdDsnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0RGV2aWNlS2V5KGRldmljZTogSURldmljZUl0ZW0pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGAke2RldmljZS5uYW1lfXwke2RldmljZS53aWR0aH14JHtkZXZpY2UuaGVpZ2h0fWA7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemggdWktYnV0dG9uIOeCueWHu+aXtuWPr+iDveWQjOaXtuaKm+WHuiBjb25maXJtIOWSjCBjbGlja++8jOS4pOS4qumDveebkeWQrOW5tuWBmuWOu+mHje+8jOmBv+WFjeS+nei1luWFt+S9k+WunueOsOOAglxyXG4gKi9cclxuZnVuY3Rpb24gb25DbGljayhlbGVtZW50OiBhbnksIGhhbmRsZXI6ICgpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIGxldCBsYXN0VGltZSA9IDA7XHJcbiAgICBjb25zdCBpbnZva2UgPSAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcclxuICAgICAgICBpZiAobm93IC0gbGFzdFRpbWUgPCA1MCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxhc3RUaW1lID0gbm93O1xyXG4gICAgICAgIGhhbmRsZXIoKTtcclxuICAgIH07XHJcbiAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NvbmZpcm0nLCBpbnZva2UpO1xyXG4gICAgZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGludm9rZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg5Y+W5YC857G757uE5Lu255qE5Lik56eN5LqL5Lu26YO955uR5ZCs77yM5aSE55CG5Ye95pWw5pys6Lqr5piv5bmC562J55qE44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBvblZhbHVlQ2hhbmdlKGVsZW1lbnQ6IGFueSwgaGFuZGxlcjogKGV2ZW50OiBhbnkpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIGVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaGFuZGxlcik7XHJcbiAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NvbmZpcm0nLCBoYW5kbGVyKTtcclxufVxyXG5cclxuY2xhc3MgQ2FtZXJhUHJldmlld1BhbmVsIHtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgJDogUmVjb3JkPHN0cmluZywgYW55PjtcclxuICAgIHByaXZhdGUgc2V0dGluZ3M6IElQYW5lbFNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XHJcbiAgICBwcml2YXRlIGRldmljZXM6IElEZXZpY2VJdGVtW10gPSBbXTtcclxuICAgIHByaXZhdGUgY2FtZXJhczogSUNhbWVyYUluZm9bXSA9IFtdO1xyXG4gICAgcHJpdmF0ZSB2aXNpYmxlID0gdHJ1ZTtcclxuICAgIHByaXZhdGUgc2NlbmVSZWFkeSA9IGZhbHNlO1xyXG4gICAgcHJpdmF0ZSBjYXB0dXJpbmcgPSBmYWxzZTtcclxuICAgIHByaXZhdGUgY2FwdHVyZVRpbWVyID0gMDtcclxuICAgIHByaXZhdGUgY2FtZXJhVGltZXIgPSAwO1xyXG4gICAgcHJpdmF0ZSBzdG9wVmVyc2lvbiA9IDA7XHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IG9uU2NlbmVSZWFkeSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgICB0aGlzLmhhbmRsZVNjZW5lUmVhZHkoKTtcclxuICAgIH07XHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IG9uU2NlbmVDbG9zZSA9ICgpOiB2b2lkID0+IHtcclxuICAgICAgICB0aGlzLmhhbmRsZVNjZW5lQ2xvc2UoKTtcclxuICAgIH07XHJcbiAgICBwcml2YXRlIHJlYWRvbmx5IG9uU2VsZWN0aW9uQ2hhbmdlID0gKCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIC8vIOmAieS4rSBDYW1lcmEg5pe257yW6L6R5Zmo5Lya5bCd6K+V5by55bCP56qX77yb5LqL5Lu26amx5Yqo5Y6L5Yi277yM5LiN5YaN6L2u6K+iXHJcbiAgICAgICAgaWYgKHRoaXMudmlzaWJsZSkge1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4odHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBwcml2YXRlIGhhc1ByZXZpZXdGcmFtZSgpOiBib29sZWFuIHtcclxuICAgICAgICBjb25zdCBwcmV2aWV3ID0gdGhpcy4kLnByZXZpZXcgYXMgSFRNTEltYWdlRWxlbWVudDtcclxuICAgICAgICBjb25zdCBzcmMgPSBwcmV2aWV3Py5nZXRBdHRyaWJ1dGU/Lignc3JjJykgfHwgJyc7XHJcbiAgICAgICAgcmV0dXJuICEhKHNyYyAmJiBwcmV2aWV3LnN0eWxlLnZpc2liaWxpdHkgIT09ICdoaWRkZW4nKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdHJ1Y3RvcihlbGVtZW50czogUmVjb3JkPHN0cmluZywgYW55Pikge1xyXG4gICAgICAgIHRoaXMuJCA9IGVsZW1lbnRzO1xyXG4gICAgfVxyXG5cclxuICAgIGFzeW5jIGluaXQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgdGhpcy5hcHBseVRleHRzKCk7XHJcbiAgICAgICAgdGhpcy5iaW5kRXZlbnRzKCk7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IEVkaXRvci5NZXNzYWdlIGFzIGFueTtcclxuICAgICAgICBtZXNzYWdlLmFkZEJyb2FkY2FzdExpc3RlbmVyKCdzY2VuZTpyZWFkeScsIHRoaXMub25TY2VuZVJlYWR5KTtcclxuICAgICAgICBtZXNzYWdlLmFkZEJyb2FkY2FzdExpc3RlbmVyKCdzY2VuZTpjbG9zZScsIHRoaXMub25TY2VuZUNsb3NlKTtcclxuICAgICAgICBtZXNzYWdlLmFkZEJyb2FkY2FzdExpc3RlbmVyKCdzZWxlY3Rpb246c2VsZWN0JywgdGhpcy5vblNlbGVjdGlvbkNoYW5nZSk7XHJcbiAgICAgICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcclxuICAgICAgICB0aGlzLmZpbGxGaXhlZFNlbGVjdHMoKTtcclxuICAgICAgICBhd2FpdCB0aGlzLnJlZnJlc2hEZXZpY2VzKCk7XHJcbiAgICAgICAgdGhpcy5zeW5jQ29udHJvbHMoKTtcclxuICAgICAgICAvLyDpnaLmnb/miZPlvIDljbPpmpDol4/nvJbovpHlmajnm7jmnLrlsI/nqpdcclxuICAgICAgICB2b2lkIHRoaXMuc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4odHJ1ZSk7XHJcbiAgICAgICAgLy8g6Z2i5p2/5Y+v6IO95Zyo5Zy65pmv5bey5bCx57uq5ZCO5omN5omT5byA77yM5bm/5pKt5bey57uP6ZSZ6L+H77yM5Li75Yqo5o6i5rWL5LiA5qyhXHJcbiAgICAgICAgaWYgKGF3YWl0IHRoaXMucHJvYmVTY2VuZVJlYWR5KCkpIHtcclxuICAgICAgICAgICAgdGhpcy5oYW5kbGVTY2VuZVJlYWR5KCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy5zaG93UGxhY2Vob2xkZXIodHJhbnNsYXRlKCd3YWl0aW5nX3NjZW5lJykpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBkaXNwb3NlKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMudmlzaWJsZSA9IGZhbHNlO1xyXG4gICAgICAgIHRoaXMuc2NlbmVSZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBFZGl0b3IuTWVzc2FnZSBhcyBhbnk7XHJcbiAgICAgICAgbWVzc2FnZS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignc2NlbmU6cmVhZHknLCB0aGlzLm9uU2NlbmVSZWFkeSk7XHJcbiAgICAgICAgbWVzc2FnZS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignc2NlbmU6Y2xvc2UnLCB0aGlzLm9uU2NlbmVDbG9zZSk7XHJcbiAgICAgICAgbWVzc2FnZS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignc2VsZWN0aW9uOnNlbGVjdCcsIHRoaXMub25TZWxlY3Rpb25DaGFuZ2UpO1xyXG4gICAgICAgIHRoaXMuc3RvcFByZXZpZXdUaW1lcnMoKTtcclxuICAgICAgICB0aGlzLmNsZWFyUHJldmlld0ltYWdlKCk7XHJcbiAgICAgICAgdm9pZCB0aGlzLnNldEVkaXRvckNhbWVyYU1pbmlQcmV2aWV3SGlkZGVuKGZhbHNlKTtcclxuICAgICAgICB2b2lkIHRoaXMuc3RvcFNjZW5lKCk7XHJcbiAgICB9XHJcblxyXG4gICAgc2V0VmlzaWJsZSh2aXNpYmxlOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy52aXNpYmxlID0gdmlzaWJsZTtcclxuICAgICAgICBpZiAodmlzaWJsZSkge1xyXG4gICAgICAgICAgICB0aGlzLnN0b3BWZXJzaW9uKys7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5zZXRFZGl0b3JDYW1lcmFNaW5pUHJldmlld0hpZGRlbih0cnVlKTtcclxuICAgICAgICAgICAgaWYgKHRoaXMuc2NlbmVSZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgdm9pZCB0aGlzLnJlZnJlc2hDYW1lcmFzKCk7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnJlc3RhcnRQcmV2aWV3VGltZXJzKCk7XHJcbiAgICAgICAgICAgICAgICB2b2lkIHRoaXMuY2FwdHVyZSgpO1xyXG4gICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5zaG93UGxhY2Vob2xkZXIodHJhbnNsYXRlKCd3YWl0aW5nX3NjZW5lJykpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnNldEVkaXRvckNhbWVyYU1pbmlQcmV2aWV3SGlkZGVuKGZhbHNlKTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnN0b3BTY2VuZSgpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGhhbmRsZVNjZW5lUmVhZHkoKTogdm9pZCB7XHJcbiAgICAgICAgdGhpcy5zY2VuZVJlYWR5ID0gdHJ1ZTtcclxuICAgICAgICBpZiAoIXRoaXMudmlzaWJsZSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZvaWQgdGhpcy5zZXRFZGl0b3JDYW1lcmFNaW5pUHJldmlld0hpZGRlbih0cnVlKTtcclxuICAgICAgICB2b2lkIHRoaXMucmVmcmVzaENhbWVyYXMoKTtcclxuICAgICAgICB0aGlzLnJlc3RhcnRQcmV2aWV3VGltZXJzKCk7XHJcbiAgICAgICAgdm9pZCB0aGlzLmNhcHR1cmUoKTtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEB6aCDmuLjmiI/pooTop4jlvIDlkK/ml7bpmpDol4/lnLrmma/lj7PkuIvop5Lnm7jmnLrlsI/nqpfvvJvlhbPpl63pooTop4jlkI7mgaLlpI3mmL7npLrjgIJcclxuICAgICAqIOS7heWcqCBzaG93L2hpZGXjgIFzY2VuZTpyZWFkeeOAgXNlbGVjdGlvbiDml7bop6blj5HvvIzkuI3lho3lrprml7bova7or6LjgIJcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSBhc3luYyBzZXRFZGl0b3JDYW1lcmFNaW5pUHJldmlld0hpZGRlbihoaWRkZW46IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5icm9hZGNhc3QoJ2NhbWVyYS1wcmV2aWV3OnNldC1taW5pLWhpZGRlbicsIGhpZGRlbik7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIC8vIGlnbm9yZVxyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRFZGl0b3JNaW5pUHJldmlld0RvbUhpZGRlbihoaWRkZW4pO1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0TWluaVByZXZpZXdTdXBwcmVzc2VkJywgW2hpZGRlbl0pO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyDlnLrmma/mnKrlsLHnu6rml7blv73nlaXvvIxzY2VuZTpyZWFkeSDlkI7kvJrlho3orr7kuIDmrKFcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChoaWRkZW4gJiYgdGhpcy52aXNpYmxlKSB7XHJcbiAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICBhd2FpdCB0aGlzLmV4ZWN1dGVTY2VuZVNjcmlwdCgnaGlkZUVkaXRvck1pbmlQcmV2aWV3JywgW10pO1xyXG4gICAgICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgICAgIC8vIGlnbm9yZVxyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgaGFuZGxlU2NlbmVDbG9zZSgpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLnNjZW5lUmVhZHkgPSBmYWxzZTtcclxuICAgICAgICB0aGlzLnN0b3BQcmV2aWV3VGltZXJzKCk7XHJcbiAgICAgICAgdGhpcy5jYW1lcmFzID0gW107XHJcbiAgICAgICAgaWYgKHRoaXMudmlzaWJsZSkge1xyXG4gICAgICAgICAgICB0aGlzLnNob3dQbGFjZWhvbGRlcih0cmFuc2xhdGUoJ3dhaXRpbmdfc2NlbmUnKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHZvaWQgdGhpcy5zdG9wU2NlbmUodHJ1ZSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBwcm9iZVNjZW5lUmVhZHkoKTogUHJvbWlzZTxib29sZWFuPiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgdGhpcy5leGVjdXRlU2NlbmVTY3JpcHQoJ3F1ZXJ5Q2FtZXJhcycsIFtdKTtcclxuICAgICAgICAgICAgcmV0dXJuIHRydWU7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSByZXN0YXJ0UHJldmlld1RpbWVycygpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLnJlc3RhcnRDYXB0dXJlVGltZXIoKTtcclxuICAgICAgICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aGlzLmNhbWVyYVRpbWVyKTtcclxuICAgICAgICB0aGlzLmNhbWVyYVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcclxuICAgICAgICAgICAgaWYgKHRoaXMudmlzaWJsZSAmJiB0aGlzLnNjZW5lUmVhZHkpIHtcclxuICAgICAgICAgICAgICAgIHZvaWQgdGhpcy5yZWZyZXNoQ2FtZXJhcygpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSwgQ0FNRVJBX1JFRlJFU0hfSU5URVJWQUwpO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgc3RvcFByZXZpZXdUaW1lcnMoKTogdm9pZCB7XHJcbiAgICAgICAgd2luZG93LmNsZWFySW50ZXJ2YWwodGhpcy5jYXB0dXJlVGltZXIpO1xyXG4gICAgICAgIHdpbmRvdy5jbGVhckludGVydmFsKHRoaXMuY2FtZXJhVGltZXIpO1xyXG4gICAgICAgIHRoaXMuY2FwdHVyZVRpbWVyID0gMDtcclxuICAgICAgICB0aGlzLmNhbWVyYVRpbWVyID0gMDtcclxuICAgIH1cclxuXHJcbiAgICAvKipcclxuICAgICAqIEB6aCDpgJrnn6XlnLrmma/ov5vnqIvmiornm7jmnLrku47pooTop4jnqpflj6PkuIrmkZjlm57ljrvvvIzkuI3pooTop4jml7bkuI3ljaDnlKjku7vkvZXmuLLmn5PlvIDplIBcclxuICAgICAqL1xyXG4gICAgcHJpdmF0ZSBhc3luYyBzdG9wU2NlbmUoZm9yY2UgPSBmYWxzZSk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGNvbnN0IHN0b3BWZXJzaW9uID0gKyt0aGlzLnN0b3BWZXJzaW9uO1xyXG4gICAgICAgIHdoaWxlICh0aGlzLmNhcHR1cmluZykge1xyXG4gICAgICAgICAgICBhd2FpdCBuZXcgUHJvbWlzZTx2b2lkPigocmVzb2x2ZSkgPT4gd2luZG93LnNldFRpbWVvdXQocmVzb2x2ZSwgMCkpO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoc3RvcFZlcnNpb24gIT09IHRoaXMuc3RvcFZlcnNpb24pIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyDpnaLmnb/ku43lj6/op4Hml7bpu5jorqTkuI0gc3RvcO+8iOi/mOS8mue7p+e7remihOiniO+8ie+8m+WcuuaZr+WFs+mXreaXtuW8uuWItuaRmOWbnlxyXG4gICAgICAgIGlmICghZm9yY2UgJiYgdGhpcy52aXNpYmxlKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgYXdhaXQgdGhpcy5leGVjdXRlU2NlbmVTY3JpcHQoJ3N0b3AnLCBbXSkuY2F0Y2goKCkgPT4ge30pO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXBwbHlUZXh0cygpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLiQubGFiZWxDYW1lcmEudGV4dENvbnRlbnQgPSB0cmFuc2xhdGUoJ2NhbWVyYScpO1xyXG4gICAgICAgIHRoaXMuJC5sYWJlbFJlc29sdXRpb24udGV4dENvbnRlbnQgPSB0cmFuc2xhdGUoJ3Jlc29sdXRpb24nKTtcclxuICAgICAgICB0aGlzLiQubGFiZWxNb2RlLnRleHRDb250ZW50ID0gdHJhbnNsYXRlKCdmdWxsX3NjZW5lJyk7XHJcbiAgICAgICAgdGhpcy4kLmxhYmVsRnBzLnRleHRDb250ZW50ID0gdHJhbnNsYXRlKCdmcHMnKTtcclxuICAgICAgICB0aGlzLiQucmVmcmVzaEJ1dHRvbi50ZXh0Q29udGVudCA9IHRyYW5zbGF0ZSgncmVmcmVzaCcpO1xyXG4gICAgICAgIHRoaXMuJC5yb3RhdGVCdXR0b24udGV4dENvbnRlbnQgPSB0cmFuc2xhdGUoJ3JvdGF0ZScpO1xyXG4gICAgICAgIHRoaXMuJC5wbGFjZWhvbGRlci50ZXh0Q29udGVudCA9IHRyYW5zbGF0ZSgnbG9hZGluZycpO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYmluZEV2ZW50cygpOiB2b2lkIHtcclxuICAgICAgICBvblZhbHVlQ2hhbmdlKHRoaXMuJC5jYW1lcmFTZWxlY3QsIChldmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MuY2FtZXJhVXVpZCA9IFN0cmluZyhldmVudC50YXJnZXQudmFsdWUgfHwgJycpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYXB0dXJlKCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgb25WYWx1ZUNoYW5nZSh0aGlzLiQuZGV2aWNlU2VsZWN0LCAoZXZlbnQ6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICB0aGlzLnNldHRpbmdzLmRldmljZUtleSA9IFN0cmluZyhldmVudC50YXJnZXQudmFsdWUgfHwgJycpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICAgIHRoaXMudXBkYXRlU3RhdHVzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYXB0dXJlKCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgb25WYWx1ZUNoYW5nZSh0aGlzLiQubW9kZUNoZWNrYm94LCAoZXZlbnQ6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICB0aGlzLnNldHRpbmdzLm1vZGUgPSBldmVudC50YXJnZXQudmFsdWUgPyAnYWxsJyA6ICdzaW5nbGUnO1xyXG4gICAgICAgICAgICB0aGlzLnN5bmNDb250cm9scygpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYXB0dXJlKCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgb25WYWx1ZUNoYW5nZSh0aGlzLiQuZnBzU2VsZWN0LCAoZXZlbnQ6IGFueSkgPT4ge1xyXG4gICAgICAgICAgICB0aGlzLnNldHRpbmdzLmZwcyA9IE51bWJlcihldmVudC50YXJnZXQudmFsdWUpIHx8IERFRkFVTFRfU0VUVElOR1MuZnBzO1xyXG4gICAgICAgICAgICB0aGlzLnJlc3RhcnRDYXB0dXJlVGltZXIoKTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnNhdmVTZXR0aW5ncygpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG9uQ2xpY2sodGhpcy4kLnJlZnJlc2hCdXR0b24sICgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnJlZnJlc2hEZXZpY2VzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5yZWZyZXNoQ2FtZXJhcygpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuY2FwdHVyZSgpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgICAgIG9uQ2xpY2sodGhpcy4kLnJvdGF0ZUJ1dHRvbiwgKCkgPT4ge1xyXG4gICAgICAgICAgICB0aGlzLnNldHRpbmdzLmxhbmRzY2FwZSA9ICF0aGlzLnNldHRpbmdzLmxhbmRzY2FwZTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnNhdmVTZXR0aW5ncygpO1xyXG4gICAgICAgICAgICB0aGlzLnVwZGF0ZVN0YXR1cygpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuY2FwdHVyZSgpO1xyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgbG9hZFNldHRpbmdzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHNhdmVkID0gYXdhaXQgRWRpdG9yLlByb2ZpbGUuZ2V0Q29uZmlnKFBBQ0tBR0VfTkFNRSwgJ3NldHRpbmdzJywgJ2xvY2FsJyk7XHJcbiAgICAgICAgICAgIGlmIChzYXZlZCAmJiB0eXBlb2Ygc2F2ZWQgPT09ICdvYmplY3QnKSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTLCAuLi5zYXZlZCB9O1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbJHtQQUNLQUdFX05BTUV9XWAsIGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBzYXZlU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlByb2ZpbGUuc2V0Q29uZmlnKFBBQ0tBR0VfTkFNRSwgJ3NldHRpbmdzJywgeyAuLi50aGlzLnNldHRpbmdzIH0sICdsb2NhbCcpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgWyR7UEFDS0FHRV9OQU1FfV1gLCBlcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgZmlsbEZpeGVkU2VsZWN0cygpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLiQuZnBzU2VsZWN0LmlubmVySFRNTCA9IEZQU19PUFRJT05TLm1hcCgoZnBzKSA9PiBgPG9wdGlvbiB2YWx1ZT1cIiR7ZnBzfVwiPiR7ZnBzfSBGUFM8L29wdGlvbj5gKS5qb2luKCcnKTtcclxuICAgICAgICB0aGlzLiQuZnBzU2VsZWN0LnZhbHVlID0gU3RyaW5nKHRoaXMuc2V0dGluZ3MuZnBzKTtcclxuICAgICAgICB0aGlzLiQubW9kZUNoZWNrYm94LnZhbHVlID0gdGhpcy5zZXR0aW5ncy5tb2RlID09PSAnYWxsJztcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIHJlZnJlc2hEZXZpY2VzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGxldCBkZXZpY2VzOiBJRGV2aWNlSXRlbVtdID0gW107XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgZGV2aWNlcyA9IGF3YWl0IEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ2RldmljZScsICdxdWVyeScpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yKSB7XHJcbiAgICAgICAgICAgIGNvbnNvbGUud2FybihgWyR7UEFDS0FHRV9OQU1FfV1gLCBlcnJvcik7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghQXJyYXkuaXNBcnJheShkZXZpY2VzKSkge1xyXG4gICAgICAgICAgICBkZXZpY2VzID0gW107XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGRldmljZXMgPSBkZXZpY2VzLmZpbHRlcigoZGV2aWNlKSA9PiBkZXZpY2UgJiYgZGV2aWNlLndpZHRoID4gMCAmJiBkZXZpY2UuaGVpZ2h0ID4gMCk7XHJcbiAgICAgICAgdGhpcy5kZXZpY2VzID0gZGV2aWNlcy5sZW5ndGggPiAwID8gZGV2aWNlcyA6IEZBTExCQUNLX0RFVklDRVM7XHJcblxyXG4gICAgICAgIGNvbnN0IG9wdGlvbnMgPSB0aGlzLmRldmljZXNcclxuICAgICAgICAgICAgLm1hcCgoZGV2aWNlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBjb25zdCBrZXkgPSBlc2NhcGVIdG1sKGdldERldmljZUtleShkZXZpY2UpKTtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGxhYmVsID0gZXNjYXBlSHRtbChgJHtkZXZpY2UubmFtZX0gKCR7ZGV2aWNlLndpZHRofXgke2RldmljZS5oZWlnaHR9KWApO1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGA8b3B0aW9uIHZhbHVlPVwiJHtrZXl9XCI+JHtsYWJlbH08L29wdGlvbj5gO1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuam9pbignJyk7XHJcbiAgICAgICAgdGhpcy4kLmRldmljZVNlbGVjdC5pbm5lckhUTUwgPSBvcHRpb25zO1xyXG5cclxuICAgICAgICBpZiAoIXRoaXMuZGV2aWNlcy5zb21lKChkZXZpY2UpID0+IGdldERldmljZUtleShkZXZpY2UpID09PSB0aGlzLnNldHRpbmdzLmRldmljZUtleSkpIHtcclxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5kZXZpY2VLZXkgPSBnZXREZXZpY2VLZXkodGhpcy5kZXZpY2VzWzBdKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy4kLmRldmljZVNlbGVjdC52YWx1ZSA9IHRoaXMuc2V0dGluZ3MuZGV2aWNlS2V5O1xyXG4gICAgICAgIHRoaXMudXBkYXRlU3RhdHVzKCk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyByZWZyZXNoQ2FtZXJhcygpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBpZiAoIXRoaXMuc2NlbmVSZWFkeSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxldCBjYW1lcmFzOiBJQ2FtZXJhSW5mb1tdID0gW107XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY2FtZXJhcyA9IGF3YWl0IHRoaXMuZXhlY3V0ZVNjZW5lU2NyaXB0PElDYW1lcmFJbmZvW10+KCdxdWVyeUNhbWVyYXMnLCBbXSk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgLy8g5Zy65pmv6L+Y5rKh5omT5byA5oiW5q2j5Zyo5YiH5o2i5pe25p+l6K+i5Lya5aSx6LSl77yM5oyJ5rKh5pyJ55u45py65aSE55CG5Y2z5Y+vXHJcbiAgICAgICAgICAgIGNhbWVyYXMgPSBbXTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGNhbWVyYXMpKSB7XHJcbiAgICAgICAgICAgIGNhbWVyYXMgPSBbXTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2hhbmdlZCA9XHJcbiAgICAgICAgICAgIGNhbWVyYXMubGVuZ3RoICE9PSB0aGlzLmNhbWVyYXMubGVuZ3RoIHx8XHJcbiAgICAgICAgICAgIGNhbWVyYXMuc29tZSgoY2FtZXJhLCBpbmRleCkgPT4gY2FtZXJhLnV1aWQgIT09IHRoaXMuY2FtZXJhc1tpbmRleF0udXVpZCB8fCBjYW1lcmEucGF0aCAhPT0gdGhpcy5jYW1lcmFzW2luZGV4XS5wYXRoKTtcclxuICAgICAgICB0aGlzLmNhbWVyYXMgPSBjYW1lcmFzO1xyXG4gICAgICAgIGlmICghY2hhbmdlZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBpZiAoY2FtZXJhcy5sZW5ndGggPT09IDApIHtcclxuICAgICAgICAgICAgdGhpcy4kLmNhbWVyYVNlbGVjdC5pbm5lckhUTUwgPSAnJztcclxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5jYW1lcmFVdWlkID0gJyc7XHJcbiAgICAgICAgICAgIGlmICh0aGlzLnZpc2libGUpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMuc2hvd1BsYWNlaG9sZGVyKHRyYW5zbGF0ZSgnbm9fY2FtZXJhJykpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHRoaXMuJC5jYW1lcmFTZWxlY3QuaW5uZXJIVE1MID0gY2FtZXJhc1xyXG4gICAgICAgICAgICAubWFwKChjYW1lcmEpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHN1ZmZpeCA9IGNhbWVyYS5lbmFibGVkID8gJycgOiBgICgke3RyYW5zbGF0ZSgnZGlzYWJsZWQnKX0pYDtcclxuICAgICAgICAgICAgICAgIHJldHVybiBgPG9wdGlvbiB2YWx1ZT1cIiR7ZXNjYXBlSHRtbChjYW1lcmEudXVpZCl9XCI+JHtlc2NhcGVIdG1sKGNhbWVyYS5wYXRoIHx8IGNhbWVyYS5uYW1lKX0ke3N1ZmZpeH08L29wdGlvbj5gO1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuam9pbignJyk7XHJcbiAgICAgICAgaWYgKCFjYW1lcmFzLnNvbWUoKGNhbWVyYSkgPT4gY2FtZXJhLnV1aWQgPT09IHRoaXMuc2V0dGluZ3MuY2FtZXJhVXVpZCkpIHtcclxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5jYW1lcmFVdWlkID0gY2FtZXJhcy5sZW5ndGggPiAwID8gY2FtZXJhc1swXS51dWlkIDogJyc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRoaXMuJC5jYW1lcmFTZWxlY3QudmFsdWUgPSB0aGlzLnNldHRpbmdzLmNhbWVyYVV1aWQ7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBzeW5jQ29udHJvbHMoKTogdm9pZCB7XHJcbiAgICAgICAgY29uc3Qgc2luZ2xlTW9kZSA9IHRoaXMuc2V0dGluZ3MubW9kZSA9PT0gJ3NpbmdsZSc7XHJcbiAgICAgICAgaWYgKHNpbmdsZU1vZGUpIHtcclxuICAgICAgICAgICAgdGhpcy4kLmNhbWVyYVNlbGVjdC5yZW1vdmVBdHRyaWJ1dGUoJ2Rpc2FibGVkJyk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy4kLmNhbWVyYVNlbGVjdC5zZXRBdHRyaWJ1dGUoJ2Rpc2FibGVkJywgJycpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHJlc3RhcnRDYXB0dXJlVGltZXIoKTogdm9pZCB7XHJcbiAgICAgICAgd2luZG93LmNsZWFySW50ZXJ2YWwodGhpcy5jYXB0dXJlVGltZXIpO1xyXG4gICAgICAgIC8vIOWOn+eUu+i0qOWNleW4p+abtOi0te+8mumXtOmalOiHs+WwkSAxMDBtc++8jOS4lOS4iuS4gOW4p+acquWujOaIkOWImeiHqueEtui3s+i/h1xyXG4gICAgICAgIGNvbnN0IGludGVydmFsID0gTWF0aC5tYXgoMTAwLCBNYXRoLnJvdW5kKDEwMDAgLyB0aGlzLnNldHRpbmdzLmZwcykpO1xyXG4gICAgICAgIHRoaXMuY2FwdHVyZVRpbWVyID0gd2luZG93LnNldEludGVydmFsKCgpID0+IHtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLmNhcHR1cmUoKTtcclxuICAgICAgICB9LCBpbnRlcnZhbCk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBleGVjdXRlU2NlbmVTY3JpcHQ8VD4obWV0aG9kOiBzdHJpbmcsIGFyZ3M6IGFueVtdKTogUHJvbWlzZTxUPiB7XHJcbiAgICAgICAgcmV0dXJuIEVkaXRvci5NZXNzYWdlLnJlcXVlc3QoJ3NjZW5lJywgJ2V4ZWN1dGUtc2NlbmUtc2NyaXB0Jywge1xyXG4gICAgICAgICAgICBuYW1lOiBQQUNLQUdFX05BTUUsXHJcbiAgICAgICAgICAgIG1ldGhvZCxcclxuICAgICAgICAgICAgYXJncyxcclxuICAgICAgICB9KTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGN1cnJlbnREZXZpY2UoKTogSURldmljZUl0ZW0gfCBudWxsIHtcclxuICAgICAgICByZXR1cm4gdGhpcy5kZXZpY2VzLmZpbmQoKGRldmljZSkgPT4gZ2V0RGV2aWNlS2V5KGRldmljZSkgPT09IHRoaXMuc2V0dGluZ3MuZGV2aWNlS2V5KSB8fCBudWxsO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgY3VycmVudFJlc29sdXRpb24oKTogeyB3aWR0aDogbnVtYmVyOyBoZWlnaHQ6IG51bWJlciB9IHwgbnVsbCB7XHJcbiAgICAgICAgY29uc3QgZGV2aWNlID0gdGhpcy5jdXJyZW50RGV2aWNlKCk7XHJcbiAgICAgICAgaWYgKCFkZXZpY2UpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHJldHVybiB0aGlzLnNldHRpbmdzLmxhbmRzY2FwZVxyXG4gICAgICAgICAgICA/IHsgd2lkdGg6IGRldmljZS5oZWlnaHQsIGhlaWdodDogZGV2aWNlLndpZHRoIH1cclxuICAgICAgICAgICAgOiB7IHdpZHRoOiBkZXZpY2Uud2lkdGgsIGhlaWdodDogZGV2aWNlLmhlaWdodCB9O1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgY2xlYXJQcmV2aWV3SW1hZ2UoKTogdm9pZCB7XHJcbiAgICAgICAgY29uc3QgcHJldmlldyA9IHRoaXMuJC5wcmV2aWV3IGFzIEhUTUxJbWFnZUVsZW1lbnQ7XHJcbiAgICAgICAgaWYgKHByZXZpZXcpIHtcclxuICAgICAgICAgICAgcHJldmlldy5yZW1vdmVBdHRyaWJ1dGUoJ3NyYycpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHNob3dQcmV2aWV3RGF0YVVybChkYXRhVXJsOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgICAgICBjb25zdCBwcmV2aWV3ID0gdGhpcy4kLnByZXZpZXcgYXMgSFRNTEltYWdlRWxlbWVudDtcclxuICAgICAgICBwcmV2aWV3LnNyYyA9IGRhdGFVcmw7XHJcbiAgICAgICAgcHJldmlldy5zdHlsZS52aXNpYmlsaXR5ID0gJ3Zpc2libGUnO1xyXG4gICAgICAgIHRoaXMuJC5wbGFjZWhvbGRlci50ZXh0Q29udGVudCA9ICcnO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgY2FwdHVyZSgpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICBpZiAoIXRoaXMudmlzaWJsZSB8fCAhdGhpcy5zY2VuZVJlYWR5IHx8IHRoaXMuY2FwdHVyaW5nKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgcmVzb2x1dGlvbiA9IHRoaXMuY3VycmVudFJlc29sdXRpb24oKTtcclxuICAgICAgICBpZiAoIXJlc29sdXRpb24pIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICAvLyDpu5jorqTljp/nlLvotKjvvJrmjInmiYDpgInorr7lpIfliIbovqjnjofnm7TmjqXlh7rlm75cclxuICAgICAgICBjb25zdCB3aWR0aCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQocmVzb2x1dGlvbi53aWR0aCkpO1xyXG4gICAgICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQocmVzb2x1dGlvbi5oZWlnaHQpKTtcclxuXHJcbiAgICAgICAgdGhpcy5jYXB0dXJpbmcgPSB0cnVlO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IHJlc3VsdCA9IGF3YWl0IHRoaXMuZXhlY3V0ZVNjZW5lU2NyaXB0PElDYXB0dXJlUmVzdWx0IHwgbnVsbD4oJ2NhcHR1cmUnLCBbXHJcbiAgICAgICAgICAgICAgICB7XHJcbiAgICAgICAgICAgICAgICAgICAgbW9kZTogdGhpcy5zZXR0aW5ncy5tb2RlLFxyXG4gICAgICAgICAgICAgICAgICAgIGNhbWVyYVV1aWQ6IHRoaXMuc2V0dGluZ3MuY2FtZXJhVXVpZCxcclxuICAgICAgICAgICAgICAgICAgICB3aWR0aCxcclxuICAgICAgICAgICAgICAgICAgICBoZWlnaHQsXHJcbiAgICAgICAgICAgICAgICAgICAgcXVhbGl0eTogQ0FQVFVSRV9RVUFMSVRZLFxyXG4gICAgICAgICAgICAgICAgfSxcclxuICAgICAgICAgICAgXSk7XHJcbiAgICAgICAgICAgIGlmICghdGhpcy52aXNpYmxlKSB7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBpZiAoIXJlc3VsdC5jYW1lcmFDb3VudCkge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5zaG93UGxhY2Vob2xkZXIodHJhbnNsYXRlKCdub19jYW1lcmEnKSk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKHJlc3VsdC51bmNoYW5nZWQpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMudXBkYXRlU3RhdHVzKHJlc3VsdCk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgaWYgKCFyZXN1bHQuZGF0YVVybCkge1xyXG4gICAgICAgICAgICAgICAgaWYgKCF0aGlzLmhhc1ByZXZpZXdGcmFtZSgpKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgdGhpcy5zaG93UGxhY2Vob2xkZXIodHJhbnNsYXRlKCdub19jYW1lcmEnKSk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgdGhpcy5zaG93UHJldmlld0RhdGFVcmwocmVzdWx0LmRhdGFVcmwpO1xyXG4gICAgICAgICAgICB0aGlzLnVwZGF0ZVN0YXR1cyhyZXN1bHQpO1xyXG4gICAgICAgIH0gY2F0Y2ggKGVycm9yOiBhbnkpIHtcclxuICAgICAgICAgICAgaWYgKHRoaXMudmlzaWJsZSAmJiAhdGhpcy5oYXNQcmV2aWV3RnJhbWUoKSkge1xyXG4gICAgICAgICAgICAgICAgdGhpcy5zaG93UGxhY2Vob2xkZXIoZXJyb3IgJiYgZXJyb3IubWVzc2FnZSA/IGVycm9yLm1lc3NhZ2UgOiBTdHJpbmcoZXJyb3IpKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gZmluYWxseSB7XHJcbiAgICAgICAgICAgIHRoaXMuY2FwdHVyaW5nID0gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgc2hvd1BsYWNlaG9sZGVyKG1lc3NhZ2U6IHN0cmluZyk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMuY2xlYXJQcmV2aWV3SW1hZ2UoKTtcclxuICAgICAgICB0aGlzLiQucHJldmlldy5zdHlsZS52aXNpYmlsaXR5ID0gJ2hpZGRlbic7XHJcbiAgICAgICAgdGhpcy4kLnBsYWNlaG9sZGVyLnRleHRDb250ZW50ID0gbWVzc2FnZTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHVwZGF0ZVN0YXR1cyhyZXN1bHQ/OiBJQ2FwdHVyZVJlc3VsdCk6IHZvaWQge1xyXG4gICAgICAgIGNvbnN0IHJlc29sdXRpb24gPSB0aGlzLmN1cnJlbnRSZXNvbHV0aW9uKCk7XHJcbiAgICAgICAgaWYgKCFyZXNvbHV0aW9uKSB7XHJcbiAgICAgICAgICAgIHRoaXMuJC5zdGF0dXMudGV4dENvbnRlbnQgPSAnJztcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwYXJ0cyA9IFtgJHtyZXNvbHV0aW9uLndpZHRofSB4ICR7cmVzb2x1dGlvbi5oZWlnaHR9YF07XHJcbiAgICAgICAgaWYgKHJlc3VsdCkge1xyXG4gICAgICAgICAgICBwYXJ0cy5wdXNoKGAke3Jlc3VsdC53aWR0aH14JHtyZXN1bHQuaGVpZ2h0fWApO1xyXG4gICAgICAgICAgICBwYXJ0cy5wdXNoKGAke3RyYW5zbGF0ZSgnY2FtZXJhJyl9OiAke3Jlc3VsdC5jYW1lcmFDb3VudH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy4kLnN0YXR1cy50ZXh0Q29udGVudCA9IHBhcnRzLmpvaW4oJyAgICAnKTtcclxuICAgIH1cclxufVxyXG5cclxubGV0IGN1cnJlbnRQYW5lbDogQ2FtZXJhUHJldmlld1BhbmVsIHwgbnVsbCA9IG51bGw7XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IEVkaXRvci5QYW5lbC5kZWZpbmUoe1xyXG4gICAgbGlzdGVuZXJzOiB7XHJcbiAgICAgICAgc2hvdygpIHtcclxuICAgICAgICAgICAgY3VycmVudFBhbmVsPy5zZXRWaXNpYmxlKHRydWUpO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgaGlkZSgpIHtcclxuICAgICAgICAgICAgY3VycmVudFBhbmVsPy5zZXRWaXNpYmxlKGZhbHNlKTtcclxuICAgICAgICB9LFxyXG4gICAgfSxcclxuICAgIHRlbXBsYXRlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksICd1dGYtOCcpLFxyXG4gICAgc3R5bGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy9zdHlsZS9kZWZhdWx0L2luZGV4LmNzcycpLCAndXRmLTgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBsYWJlbENhbWVyYTogJyNsYWJlbENhbWVyYScsXHJcbiAgICAgICAgbGFiZWxSZXNvbHV0aW9uOiAnI2xhYmVsUmVzb2x1dGlvbicsXHJcbiAgICAgICAgbGFiZWxNb2RlOiAnI2xhYmVsTW9kZScsXHJcbiAgICAgICAgbGFiZWxGcHM6ICcjbGFiZWxGcHMnLFxyXG4gICAgICAgIGNhbWVyYVNlbGVjdDogJyNjYW1lcmFTZWxlY3QnLFxyXG4gICAgICAgIGRldmljZVNlbGVjdDogJyNkZXZpY2VTZWxlY3QnLFxyXG4gICAgICAgIHJlZnJlc2hCdXR0b246ICcjcmVmcmVzaEJ1dHRvbicsXHJcbiAgICAgICAgcm90YXRlQnV0dG9uOiAnI3JvdGF0ZUJ1dHRvbicsXHJcbiAgICAgICAgbW9kZUNoZWNrYm94OiAnI21vZGVDaGVja2JveCcsXHJcbiAgICAgICAgZnBzU2VsZWN0OiAnI2Zwc1NlbGVjdCcsXHJcbiAgICAgICAgcHJldmlldzogJyNwcmV2aWV3JyxcclxuICAgICAgICBwbGFjZWhvbGRlcjogJyNwbGFjZWhvbGRlcicsXHJcbiAgICAgICAgc3RhdHVzOiAnI3N0YXR1cycsXHJcbiAgICB9LFxyXG4gICAgbWV0aG9kczoge30sXHJcbiAgICByZWFkeSgpIHtcclxuICAgICAgICBjdXJyZW50UGFuZWwgPSBuZXcgQ2FtZXJhUHJldmlld1BhbmVsKHRoaXMuJCBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KTtcclxuICAgICAgICB2b2lkIGN1cnJlbnRQYW5lbC5pbml0KCk7XHJcbiAgICB9LFxyXG4gICAgYmVmb3JlQ2xvc2UoKSB7fSxcclxuICAgIGNsb3NlKCkge1xyXG4gICAgICAgIGN1cnJlbnRQYW5lbD8uZGlzcG9zZSgpO1xyXG4gICAgICAgIGN1cnJlbnRQYW5lbCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19
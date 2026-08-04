"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
const fs_1 = require("fs");
const path_1 = require("path");
const constants_1 = require("../../constants");
const FPS_OPTIONS = [1, 5, 10, 15, 30];
const RENDER_LIMIT = 1080;
const CAPTURE_QUALITY = 0.8;
const CAMERA_REFRESH_INTERVAL = 2000;
const MINI_PREVIEW_HIDE_STYLE_ID = 'camera-preview-hide-editor-mini-style';
const MINI_PREVIEW_HIDE_INTERVAL = 250;
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
    fps: 10,
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
        this.miniPreviewHideTimer = 0;
        this.stopVersion = 0;
        this.onSceneReady = () => {
            this.handleSceneReady();
        };
        this.onSceneClose = () => {
            this.handleSceneClose();
        };
        this.onSelectionChange = () => {
            // 选中 Camera 时编辑器会尝试弹小窗；压制 API + DOM 兜底，不影响游戏预览 capture
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
     * 场景侧拦截 MiniPreview.handleSelect，避免选中 Camera 时打断游戏预览渲染。
     */
    async setEditorCameraMiniPreviewHidden(hidden) {
        // 先停掉定时器，避免 close 时又被下一拍重新藏起来
        window.clearInterval(this.miniPreviewHideTimer);
        this.miniPreviewHideTimer = 0;
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
            // DOM 兜底：个别版本仍会闪一下小窗；场景侧只做轻量 ensure，不再每帧 destroy
            this.miniPreviewHideTimer = window.setInterval(() => {
                if (!this.visible) {
                    return;
                }
                try {
                    Editor.Message.broadcast('camera-preview:set-mini-hidden', true);
                }
                catch (_a) {
                    // ignore
                }
                void setEditorMiniPreviewDomHidden(true);
                void this.executeSceneScript('hideEditorMiniPreview', []).catch(() => { });
            }, MINI_PREVIEW_HIDE_INTERVAL);
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
        window.clearInterval(this.miniPreviewHideTimer);
        this.captureTimer = 0;
        this.cameraTimer = 0;
        this.miniPreviewHideTimer = 0;
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
        const interval = Math.max(16, Math.round(1000 / this.settings.fps));
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
    async capture() {
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
            if (!result || !result.dataUrl) {
                // 选中 Camera 时编辑器可能短暂干扰；已有画面则保留，避免闪成空白
                if (!this.hasPreviewFrame()) {
                    this.showPlaceholder(translate('no_camera'));
                }
                return;
            }
            this.$.preview.src = result.dataUrl;
            this.$.preview.style.visibility = 'visible';
            this.$.placeholder.textContent = '';
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
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5kZXguanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi8uLi8uLi9zb3VyY2UvcGFuZWxzL2RlZmF1bHQvaW5kZXgudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7QUFBQSwyQkFBa0M7QUFDbEMsK0JBQTRCO0FBQzVCLCtDQUErQztBQWtCL0MsTUFBTSxXQUFXLEdBQUcsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxFQUFFLEVBQUUsRUFBRSxFQUFFLEVBQUUsRUFBRSxDQUFDLENBQUM7QUFDdkMsTUFBTSxZQUFZLEdBQUcsSUFBSSxDQUFDO0FBQzFCLE1BQU0sZUFBZSxHQUFHLEdBQUcsQ0FBQztBQUM1QixNQUFNLHVCQUF1QixHQUFHLElBQUksQ0FBQztBQUNyQyxNQUFNLDBCQUEwQixHQUFHLHVDQUF1QyxDQUFDO0FBQzNFLE1BQU0sMEJBQTBCLEdBQUcsR0FBRyxDQUFDO0FBQ3ZDLGlGQUFpRjtBQUNqRixNQUFNLHFCQUFxQixHQUFHLENBQUMsdUJBQXVCLEVBQUUsK0JBQStCLENBQUMsQ0FBQztBQUN6RixNQUFNLGdCQUFnQixHQUFHOzs7Ozs7Ozs7Ozs7Q0FZeEIsQ0FBQztBQUVGLFNBQVMscUJBQXFCOztJQUMxQixNQUFNLElBQUksR0FBZSxFQUFFLENBQUM7SUFDNUIsTUFBTSxHQUFHLEdBQUcsQ0FBQyxHQUFnQyxFQUFFLEVBQUU7UUFDN0MsSUFBSSxHQUFHLElBQUksQ0FBQyxJQUFJLENBQUMsUUFBUSxDQUFDLEdBQUcsQ0FBQyxFQUFFLENBQUM7WUFDN0IsSUFBSSxDQUFDLElBQUksQ0FBQyxHQUFHLENBQUMsQ0FBQztRQUNuQixDQUFDO0lBQ0wsQ0FBQyxDQUFDO0lBQ0YsSUFBSSxDQUFDO1FBQ0QsR0FBRyxDQUFDLFVBQVUsQ0FBQyxRQUFRLENBQUMsQ0FBQztJQUM3QixDQUFDO0lBQUMsV0FBTSxDQUFDO1FBQ0wsU0FBUztJQUNiLENBQUM7SUFDRCxJQUFJLENBQUM7UUFDRCxHQUFHLENBQUMsTUFBQyxVQUFrQixDQUFDLE1BQU0s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QixZQUFZLEVBQUUsZUFBZTtRQUM3QixZQUFZLEVBQUUsZUFBZTtRQUM3QixTQUFTLEVBQUUsWUFBWTtRQUN2QixPQUFPLEVBQUUsVUFBVTtRQUNuQixXQUFXLEVBQUUsY0FBYztRQUMzQixNQUFNLEVBQUUsU0FBUztLQUNwQjtJQUNELE9BQU8sRUFBRSxFQUFFO0lBQ1gsS0FBSztRQUNELFlBQVksR0FBRyxJQUFJLGtCQUFrQixDQUFDLElBQUksQ0FBQyxDQUF3QixDQUFDLENBQUM7UUFDckUsS0FBSyxZQUFZLENBQUMsSUFBSSxFQUFFLENBQUM7SUFDN0IsQ0FBQztJQUNELFdBQVcsS0FBSSxDQUFDO0lBQ2hCLEtBQUs7UUFDRCxZQUFZLGFBQVosWUFBWSx1QkFBWixZQUFZLENBQUUsT0FBTyxFQUFFLENBQUM7UUFDeEIsWUFBWSxHQUFHLElBQUksQ0FBQztJQUN4QixDQUFDO0NBQ0osQ0FBQyxDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0IHsgcmVhZEZpbGVTeW5jIH0gZnJvbSAnZnMnO1xyXG5pbXBvcnQgeyBqb2luIH0gZnJvbSAncGF0aCc7XHJcbmltcG9ydCB7IFBBQ0tBR0VfTkFNRSB9IGZyb20gJy4uLy4uL2NvbnN0YW50cyc7XHJcbmltcG9ydCB0eXBlIHsgSUNhbWVyYUluZm8sIElDYXB0dXJlUmVzdWx0LCBQcmV2aWV3TW9kZSB9IGZyb20gJy4uLy4uL3R5cGVzJztcclxuXHJcbmludGVyZmFjZSBJRGV2aWNlSXRlbSB7XHJcbiAgICBuYW1lOiBzdHJpbmc7XHJcbiAgICB3aWR0aDogbnVtYmVyO1xyXG4gICAgaGVpZ2h0OiBudW1iZXI7XHJcbiAgICByYXRpbzogbnVtYmVyO1xyXG59XHJcblxyXG5pbnRlcmZhY2UgSVBhbmVsU2V0dGluZ3Mge1xyXG4gICAgZGV2aWNlS2V5OiBzdHJpbmc7XHJcbiAgICBjYW1lcmFVdWlkOiBzdHJpbmc7XHJcbiAgICBsYW5kc2NhcGU6IGJvb2xlYW47XHJcbiAgICBtb2RlOiBQcmV2aWV3TW9kZTtcclxuICAgIGZwczogbnVtYmVyO1xyXG59XHJcblxyXG5jb25zdCBGUFNfT1BUSU9OUyA9IFsxLCA1LCAxMCwgMTUsIDMwXTtcclxuY29uc3QgUkVOREVSX0xJTUlUID0gMTA4MDtcclxuY29uc3QgQ0FQVFVSRV9RVUFMSVRZID0gMC44O1xyXG5jb25zdCBDQU1FUkFfUkVGUkVTSF9JTlRFUlZBTCA9IDIwMDA7XHJcbmNvbnN0IE1JTklfUFJFVklFV19ISURFX1NUWUxFX0lEID0gJ2NhbWVyYS1wcmV2aWV3LWhpZGUtZWRpdG9yLW1pbmktc3R5bGUnO1xyXG5jb25zdCBNSU5JX1BSRVZJRVdfSElERV9JTlRFUlZBTCA9IDI1MDtcclxuLyoqIOe8lui+keWZqOWwj+eql++8mi5mbG9hdC13aW5kb3cg5YaF55qEIC5jYW1lcmEtcHJldmlld++8m+acrOaJqeWxlemdouadv+agueiKgueCueaYryBnYW1lLXByZXZpZXctcGFuZWzvvIzkuI3kvJrooqvljLnphY3jgIIgKi9cclxuY29uc3QgRURJVE9SX01JTklfU0VMRUNUT1JTID0gWycuZmxvYXQtd2luZG93W2NhbWVyYV0nLCAnLmZsb2F0LXdpbmRvdyAuY2FtZXJhLXByZXZpZXcnXTtcclxuY29uc3QgTUlOSV9QUkVWSUVXX0NTUyA9IGBcclxuLmZsb2F0LXdpbmRvd1tjYW1lcmFdLFxyXG4uZmxvYXQtd2luZG93OmhhcyguY2FtZXJhLXByZXZpZXcpIHtcclxuICAgIGRpc3BsYXk6IG5vbmUgIWltcG9ydGFudDtcclxuICAgIHZpc2liaWxpdHk6IGhpZGRlbiAhaW1wb3J0YW50O1xyXG4gICAgb3BhY2l0eTogMCAhaW1wb3J0YW50O1xyXG4gICAgcG9pbnRlci1ldmVudHM6IG5vbmUgIWltcG9ydGFudDtcclxufVxyXG4uZmxvYXQtd2luZG93IC5jYW1lcmEtcHJldmlldyB7XHJcbiAgICBkaXNwbGF5OiBub25lICFpbXBvcnRhbnQ7XHJcbiAgICB2aXNpYmlsaXR5OiBoaWRkZW4gIWltcG9ydGFudDtcclxufVxyXG5gO1xyXG5cclxuZnVuY3Rpb24gZ2V0Q2FuZGlkYXRlRG9jdW1lbnRzKCk6IERvY3VtZW50W10ge1xyXG4gICAgY29uc3QgZG9jczogRG9jdW1lbnRbXSA9IFtdO1xyXG4gICAgY29uc3QgYWRkID0gKGRvYzogRG9jdW1lbnQgfCBudWxsIHwgdW5kZWZpbmVkKSA9PiB7XHJcbiAgICAgICAgaWYgKGRvYyAmJiAhZG9jcy5pbmNsdWRlcyhkb2MpKSB7XHJcbiAgICAgICAgICAgIGRvY3MucHVzaChkb2MpO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICB0cnkge1xyXG4gICAgICAgIGFkZChnbG9iYWxUaGlzLmRvY3VtZW50KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGlnbm9yZVxyXG4gICAgfVxyXG4gICAgdHJ5IHtcclxuICAgICAgICBhZGQoKGdsb2JhbFRoaXMgYXMgYW55KS5wYXJlbnQ/LmRvY3VtZW50KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGlnbm9yZVxyXG4gICAgfVxyXG4gICAgdHJ5IHtcclxuICAgICAgICBhZGQoKGdsb2JhbFRoaXMgYXMgYW55KS50b3A/LmRvY3VtZW50KTtcclxuICAgIH0gY2F0Y2gge1xyXG4gICAgICAgIC8vIGlnbm9yZVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIGRvY3M7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGluamVjdEhpZGVTdHlsZShkb2M6IERvY3VtZW50KTogdm9pZCB7XHJcbiAgICBsZXQgc3R5bGUgPSBkb2MuZ2V0RWxlbWVudEJ5SWQoTUlOSV9QUkVWSUVXX0hJREVfU1RZTEVfSUQpIGFzIEhUTUxTdHlsZUVsZW1lbnQgfCBudWxsO1xyXG4gICAgaWYgKCFzdHlsZSkge1xyXG4gICAgICAgIHN0eWxlID0gZG9jLmNyZWF0ZUVsZW1lbnQoJ3N0eWxlJyk7XHJcbiAgICAgICAgc3R5bGUuaWQgPSBNSU5JX1BSRVZJRVdfSElERV9TVFlMRV9JRDtcclxuICAgICAgICAoZG9jLmhlYWQgfHwgZG9jLmRvY3VtZW50RWxlbWVudCkuYXBwZW5kQ2hpbGQoc3R5bGUpO1xyXG4gICAgfVxyXG4gICAgc3R5bGUudGV4dENvbnRlbnQgPSBNSU5JX1BSRVZJRVdfQ1NTO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZW1vdmVIaWRlU3R5bGUoZG9jOiBEb2N1bWVudCk6IHZvaWQge1xyXG4gICAgZG9jLmdldEVsZW1lbnRCeUlkKE1JTklfUFJFVklFV19ISURFX1NUWUxFX0lEKT8ucmVtb3ZlKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGhpZGVGbG9hdFdpbmRvd0VsZW1lbnQoZWw6IEVsZW1lbnQpOiB2b2lkIHtcclxuICAgIGNvbnN0IHdpbiA9IChlbC5jbG9zZXN0Py4oJy5mbG9hdC13aW5kb3cnKSBhcyBIVE1MRWxlbWVudCB8IG51bGwpIHx8IChlbCBhcyBIVE1MRWxlbWVudCk7XHJcbiAgICBpZiAoIXdpbiB8fCAhd2luLmNsYXNzTGlzdD8uY29udGFpbnMoJ2Zsb2F0LXdpbmRvdycpKSB7XHJcbiAgICAgICAgLy8g5Y+q5YqoIGZsb2F0LXdpbmRvd++8jOmBv+WFjeivr+S8pOWFtuWug+iKgueCuVxyXG4gICAgICAgIGNvbnN0IG5lc3RlZCA9IGVsLnF1ZXJ5U2VsZWN0b3I/LignLmZsb2F0LXdpbmRvdycpIGFzIEhUTUxFbGVtZW50IHwgbnVsbDtcclxuICAgICAgICBpZiAoIW5lc3RlZCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGhpZGVGbG9hdFdpbmRvd0VsZW1lbnQobmVzdGVkKTtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICB3aW4uc2V0QXR0cmlidXRlKCdoaWRkZW4nLCAnJyk7XHJcbiAgICB3aW4uc2V0QXR0cmlidXRlKCdkYXRhLWdhbWUtcHJldmlldy1zdXBwcmVzc2VkJywgJzEnKTtcclxuICAgIHdpbi5zdHlsZS5zZXRQcm9wZXJ0eSgnZGlzcGxheScsICdub25lJywgJ2ltcG9ydGFudCcpO1xyXG4gICAgd2luLnN0eWxlLnNldFByb3BlcnR5KCd2aXNpYmlsaXR5JywgJ2hpZGRlbicsICdpbXBvcnRhbnQnKTtcclxuICAgIHdpbi5zdHlsZS5zZXRQcm9wZXJ0eSgnb3BhY2l0eScsICcwJywgJ2ltcG9ydGFudCcpO1xyXG4gICAgd2luLnN0eWxlLnNldFByb3BlcnR5KCdwb2ludGVyLWV2ZW50cycsICdub25lJywgJ2ltcG9ydGFudCcpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXN0b3JlRmxvYXRXaW5kb3dFbGVtZW50KGVsOiBFbGVtZW50KTogdm9pZCB7XHJcbiAgICBjb25zdCB3aW4gPSAoZWwuY2xhc3NMaXN0Py5jb250YWlucygnZmxvYXQtd2luZG93JykgPyBlbCA6IGVsLmNsb3Nlc3Q/LignLmZsb2F0LXdpbmRvdycpKSBhcyBIVE1MRWxlbWVudCB8IG51bGw7XHJcbiAgICBpZiAoIXdpbiB8fCB3aW4uZ2V0QXR0cmlidXRlKCdkYXRhLWdhbWUtcHJldmlldy1zdXBwcmVzc2VkJykgIT09ICcxJykge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHdpbi5yZW1vdmVBdHRyaWJ1dGUoJ2hpZGRlbicpO1xyXG4gICAgd2luLnJlbW92ZUF0dHJpYnV0ZSgnZGF0YS1nYW1lLXByZXZpZXctc3VwcHJlc3NlZCcpO1xyXG4gICAgd2luLnN0eWxlLnJlbW92ZVByb3BlcnR5KCdkaXNwbGF5Jyk7XHJcbiAgICB3aW4uc3R5bGUucmVtb3ZlUHJvcGVydHkoJ3Zpc2liaWxpdHknKTtcclxuICAgIHdpbi5zdHlsZS5yZW1vdmVQcm9wZXJ0eSgnb3BhY2l0eScpO1xyXG4gICAgd2luLnN0eWxlLnJlbW92ZVByb3BlcnR5KCdwb2ludGVyLWV2ZW50cycpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBjb2xsZWN0RWxlbWVudHMocmVzdWx0OiBIVE1MRWxlbWVudFtdW10gfCBIVE1MRWxlbWVudFtdIHwgdm9pZCB8IG51bGwpOiBIVE1MRWxlbWVudFtdIHtcclxuICAgIGlmICghcmVzdWx0IHx8ICFBcnJheS5pc0FycmF5KHJlc3VsdCkpIHtcclxuICAgICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcbiAgICBjb25zdCBsaXN0OiBIVE1MRWxlbWVudFtdID0gW107XHJcbiAgICBmb3IgKGNvbnN0IGl0ZW0gb2YgcmVzdWx0KSB7XHJcbiAgICAgICAgaWYgKCFpdGVtKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoQXJyYXkuaXNBcnJheShpdGVtKSkge1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGVsIG9mIGl0ZW0pIHtcclxuICAgICAgICAgICAgICAgIGlmIChlbCkge1xyXG4gICAgICAgICAgICAgICAgICAgIGxpc3QucHVzaChlbCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICBsaXN0LnB1c2goaXRlbSBhcyBIVE1MRWxlbWVudCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG4gICAgcmV0dXJuIGxpc3Q7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg6ZqQ6JePL+aBouWkjeWcuuaZr+mdouadv+WPs+S4i+inkuebuOacuuWwj+eql+OAglxyXG4gKiDlvIDlkK/muLjmiI/pooTop4jml7YgaGlkZGVuPXRydWXvvJvlhbPpl63muLjmiI/pooTop4jml7YgaGlkZGVuPWZhbHNl77yM5Lqk6L+Y57yW6L6R5Zmo5q2j5bi46Kem5Y+R44CCXHJcbiAqL1xyXG5hc3luYyBmdW5jdGlvbiBzZXRFZGl0b3JNaW5pUHJldmlld0RvbUhpZGRlbihoaWRkZW46IGJvb2xlYW4pOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgIGNvbnN0IGRvY3MgPSBnZXRDYW5kaWRhdGVEb2N1bWVudHMoKTtcclxuXHJcbiAgICBpZiAoaGlkZGVuKSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBkb2Mgb2YgZG9jcykge1xyXG4gICAgICAgICAgICBpbmplY3RIaWRlU3R5bGUoZG9jKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgYXdhaXQgRWRpdG9yLlBhbmVsLmNsb3NlKCdzY2VuZS5wcmV2aWV3Jyk7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIC8vIGlnbm9yZVxyXG4gICAgICAgIH1cclxuICAgIH0gZWxzZSB7XHJcbiAgICAgICAgZm9yIChjb25zdCBkb2Mgb2YgZG9jcykge1xyXG4gICAgICAgICAgICByZW1vdmVIaWRlU3R5bGUoZG9jKTtcclxuICAgICAgICAgICAgZG9jLnF1ZXJ5U2VsZWN0b3JBbGwoJy5mbG9hdC13aW5kb3dbZGF0YS1nYW1lLXByZXZpZXctc3VwcHJlc3NlZD1cIjFcIl0nKS5mb3JFYWNoKChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICByZXN0b3JlRmxvYXRXaW5kb3dFbGVtZW50KG5vZGUpO1xyXG4gICAgICAgICAgICB9KTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgZm9yIChjb25zdCBzZWxlY3RvciBvZiBFRElUT1JfTUlOSV9TRUxFQ1RPUlMpIHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCBxdWVyaWVkID0gYXdhaXQgRWRpdG9yLlBhbmVsLnF1ZXJ5U2VsZWN0b3IoJ3NjZW5lJywgc2VsZWN0b3IpO1xyXG4gICAgICAgICAgICBmb3IgKGNvbnN0IGVsIG9mIGNvbGxlY3RFbGVtZW50cyhxdWVyaWVkIGFzIGFueSkpIHtcclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgY29uc3QgZG9jID0gZWwub3duZXJEb2N1bWVudDtcclxuICAgICAgICAgICAgICAgICAgICBpZiAoZG9jKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIGlmIChoaWRkZW4pIHtcclxuICAgICAgICAgICAgICAgICAgICAgICAgICAgIGluamVjdEhpZGVTdHlsZShkb2MpO1xyXG4gICAgICAgICAgICAgICAgICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICAgICAgICAgICAgICAgICAgcmVtb3ZlSGlkZVN0eWxlKGRvYyk7XHJcbiAgICAgICAgICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgICAgICAgICAvLyBpZ25vcmVcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIGlmIChoaWRkZW4pIHtcclxuICAgICAgICAgICAgICAgICAgICBoaWRlRmxvYXRXaW5kb3dFbGVtZW50KGVsKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdG9yZUZsb2F0V2luZG93RWxlbWVudChlbCk7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgLy8gaWdub3JlXHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBmb3IgKGNvbnN0IGRvYyBvZiBkb2NzKSB7XHJcbiAgICAgICAgICAgIGRvYy5xdWVyeVNlbGVjdG9yQWxsKHNlbGVjdG9yKS5mb3JFYWNoKChub2RlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBpZiAoaGlkZGVuKSB7XHJcbiAgICAgICAgICAgICAgICAgICAgaGlkZUZsb2F0V2luZG93RWxlbWVudChub2RlKTtcclxuICAgICAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICAgICAgcmVzdG9yZUZsb2F0V2luZG93RWxlbWVudChub2RlKTtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgfSk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG4vLyDorr7lpIfnrqHnkIblmajkuI3lj6/nlKjml7bnmoTlhZzlupXliJfooahcclxuY29uc3QgRkFMTEJBQ0tfREVWSUNFUzogSURldmljZUl0ZW1bXSA9IFtcclxuICAgIHsgbmFtZTogJ2lQaG9uZSBYJywgd2lkdGg6IDExMjUsIGhlaWdodDogMjQzNiwgcmF0aW86IDMgfSxcclxuICAgIHsgbmFtZTogJ2lQaG9uZSA2Jywgd2lkdGg6IDc1MCwgaGVpZ2h0OiAxMzM0LCByYXRpbzogMiB9LFxyXG4gICAgeyBuYW1lOiAnaVBhZCcsIHdpZHRoOiAxNTM2LCBoZWlnaHQ6IDIwNDgsIHJhdGlvOiAyIH0sXHJcbl07XHJcblxyXG5jb25zdCBERUZBVUxUX1NFVFRJTkdTOiBJUGFuZWxTZXR0aW5ncyA9IHtcclxuICAgIGRldmljZUtleTogJycsXHJcbiAgICBjYW1lcmFVdWlkOiAnJyxcclxuICAgIGxhbmRzY2FwZTogZmFsc2UsXHJcbiAgICBtb2RlOiAnYWxsJyxcclxuICAgIGZwczogMTAsXHJcbn07XHJcblxyXG5mdW5jdGlvbiB0cmFuc2xhdGUoa2V5OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIEVkaXRvci5JMThuLnQoYCR7UEFDS0FHRV9OQU1FfS4ke2tleX1gKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZXNjYXBlSHRtbCh0ZXh0OiBzdHJpbmcpOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIHRleHQucmVwbGFjZSgvJi9nLCAnJmFtcDsnKS5yZXBsYWNlKC88L2csICcmbHQ7JykucmVwbGFjZSgvPi9nLCAnJmd0OycpLnJlcGxhY2UoL1wiL2csICcmcXVvdDsnKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0RGV2aWNlS2V5KGRldmljZTogSURldmljZUl0ZW0pOiBzdHJpbmcge1xyXG4gICAgcmV0dXJuIGAke2RldmljZS5uYW1lfXwke2RldmljZS53aWR0aH14JHtkZXZpY2UuaGVpZ2h0fWA7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemggdWktYnV0dG9uIOeCueWHu+aXtuWPr+iDveWQjOaXtuaKm+WHuiBjb25maXJtIOWSjCBjbGlja++8jOS4pOS4qumDveebkeWQrOW5tuWBmuWOu+mHje+8jOmBv+WFjeS+nei1luWFt+S9k+WunueOsOOAglxyXG4gKi9cclxuZnVuY3Rpb24gb25DbGljayhlbGVtZW50OiBhbnksIGhhbmRsZXI6ICgpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIGxldCBsYXN0VGltZSA9IDA7XHJcbiAgICBjb25zdCBpbnZva2UgPSAoKSA9PiB7XHJcbiAgICAgICAgY29uc3Qgbm93ID0gRGF0ZS5ub3coKTtcclxuICAgICAgICBpZiAobm93IC0gbGFzdFRpbWUgPCA1MCkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGxhc3RUaW1lID0gbm93O1xyXG4gICAgICAgIGhhbmRsZXIoKTtcclxuICAgIH07XHJcbiAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NvbmZpcm0nLCBpbnZva2UpO1xyXG4gICAgZWxlbWVudC5hZGRFdmVudExpc3RlbmVyKCdjbGljaycsIGludm9rZSk7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg5Y+W5YC857G757uE5Lu255qE5Lik56eN5LqL5Lu26YO955uR5ZCs77yM5aSE55CG5Ye95pWw5pys6Lqr5piv5bmC562J55qE44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBvblZhbHVlQ2hhbmdlKGVsZW1lbnQ6IGFueSwgaGFuZGxlcjogKGV2ZW50OiBhbnkpID0+IHZvaWQpOiB2b2lkIHtcclxuICAgIGVsZW1lbnQuYWRkRXZlbnRMaXN0ZW5lcignY2hhbmdlJywgaGFuZGxlcik7XHJcbiAgICBlbGVtZW50LmFkZEV2ZW50TGlzdGVuZXIoJ2NvbmZpcm0nLCBoYW5kbGVyKTtcclxufVxyXG5cclxuY2xhc3MgQ2FtZXJhUHJldmlld1BhbmVsIHtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgJDogUmVjb3JkPHN0cmluZywgYW55PjtcclxuICAgIHByaXZhdGUgc2V0dGluZ3M6IElQYW5lbFNldHRpbmdzID0geyAuLi5ERUZBVUxUX1NFVFRJTkdTIH07XHJcbiAgICBwcml2YXRlIGRldmljZXM6IElEZXZpY2VJdGVtW10gPSBbXTtcclxuICAgIHByaXZhdGUgY2FtZXJhczogSUNhbWVyYUluZm9bXSA9IFtdO1xyXG4gICAgcHJpdmF0ZSB2aXNpYmxlID0gdHJ1ZTtcclxuICAgIHByaXZhdGUgc2NlbmVSZWFkeSA9IGZhbHNlO1xyXG4gICAgcHJpdmF0ZSBjYXB0dXJpbmcgPSBmYWxzZTtcclxuICAgIHByaXZhdGUgY2FwdHVyZVRpbWVyID0gMDtcclxuICAgIHByaXZhdGUgY2FtZXJhVGltZXIgPSAwO1xyXG4gICAgcHJpdmF0ZSBtaW5pUHJldmlld0hpZGVUaW1lciA9IDA7XHJcbiAgICBwcml2YXRlIHN0b3BWZXJzaW9uID0gMDtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgb25TY2VuZVJlYWR5ID0gKCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIHRoaXMuaGFuZGxlU2NlbmVSZWFkeSgpO1xyXG4gICAgfTtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgb25TY2VuZUNsb3NlID0gKCk6IHZvaWQgPT4ge1xyXG4gICAgICAgIHRoaXMuaGFuZGxlU2NlbmVDbG9zZSgpO1xyXG4gICAgfTtcclxuICAgIHByaXZhdGUgcmVhZG9ubHkgb25TZWxlY3Rpb25DaGFuZ2UgPSAoKTogdm9pZCA9PiB7XHJcbiAgICAgICAgLy8g6YCJ5LitIENhbWVyYSDml7bnvJbovpHlmajkvJrlsJ3or5XlvLnlsI/nqpfvvJvljovliLYgQVBJICsgRE9NIOWFnOW6le+8jOS4jeW9seWTjea4uOaIj+mihOiniCBjYXB0dXJlXHJcbiAgICAgICAgaWYgKHRoaXMudmlzaWJsZSkge1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4odHJ1ZSk7XHJcbiAgICAgICAgfVxyXG4gICAgfTtcclxuXHJcbiAgICBwcml2YXRlIGhhc1ByZXZpZXdGcmFtZSgpOiBib29sZWFuIHtcclxuICAgICAgICBjb25zdCBwcmV2aWV3ID0gdGhpcy4kLnByZXZpZXcgYXMgSFRNTEltYWdlRWxlbWVudDtcclxuICAgICAgICBjb25zdCBzcmMgPSBwcmV2aWV3Py5nZXRBdHRyaWJ1dGU/Lignc3JjJykgfHwgJyc7XHJcbiAgICAgICAgcmV0dXJuICEhKHNyYyAmJiBwcmV2aWV3LnN0eWxlLnZpc2liaWxpdHkgIT09ICdoaWRkZW4nKTtcclxuICAgIH1cclxuXHJcbiAgICBjb25zdHJ1Y3RvcihlbGVtZW50czogUmVjb3JkPHN0cmluZywgYW55Pikge1xyXG4gICAgICAgIHRoaXMuJCA9IGVsZW1lbnRzO1xyXG4gICAgfVxyXG5cclxuICAgIGFzeW5jIGluaXQoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgdGhpcy5hcHBseVRleHRzKCk7XHJcbiAgICAgICAgdGhpcy5iaW5kRXZlbnRzKCk7XHJcbiAgICAgICAgY29uc3QgbWVzc2FnZSA9IEVkaXRvci5NZXNzYWdlIGFzIGFueTtcclxuICAgICAgICBtZXNzYWdlLmFkZEJyb2FkY2FzdExpc3RlbmVyKCdzY2VuZTpyZWFkeScsIHRoaXMub25TY2VuZVJlYWR5KTtcclxuICAgICAgICBtZXNzYWdlLmFkZEJyb2FkY2FzdExpc3RlbmVyKCdzY2VuZTpjbG9zZScsIHRoaXMub25TY2VuZUNsb3NlKTtcclxuICAgICAgICBtZXNzYWdlLmFkZEJyb2FkY2FzdExpc3RlbmVyKCdzZWxlY3Rpb246c2VsZWN0JywgdGhpcy5vblNlbGVjdGlvbkNoYW5nZSk7XHJcbiAgICAgICAgYXdhaXQgdGhpcy5sb2FkU2V0dGluZ3MoKTtcclxuICAgICAgICB0aGlzLmZpbGxGaXhlZFNlbGVjdHMoKTtcclxuICAgICAgICBhd2FpdCB0aGlzLnJlZnJlc2hEZXZpY2VzKCk7XHJcbiAgICAgICAgdGhpcy5zeW5jQ29udHJvbHMoKTtcclxuICAgICAgICAvLyDpnaLmnb/miZPlvIDljbPpmpDol4/nvJbovpHlmajnm7jmnLrlsI/nqpdcclxuICAgICAgICB2b2lkIHRoaXMuc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4odHJ1ZSk7XHJcbiAgICAgICAgLy8g6Z2i5p2/5Y+v6IO95Zyo5Zy65pmv5bey5bCx57uq5ZCO5omN5omT5byA77yM5bm/5pKt5bey57uP6ZSZ6L+H77yM5Li75Yqo5o6i5rWL5LiA5qyhXHJcbiAgICAgICAgaWYgKGF3YWl0IHRoaXMucHJvYmVTY2VuZVJlYWR5KCkpIHtcclxuICAgICAgICAgICAgdGhpcy5oYW5kbGVTY2VuZVJlYWR5KCk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy5zaG93UGxhY2Vob2xkZXIodHJhbnNsYXRlKCd3YWl0aW5nX3NjZW5lJykpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBkaXNwb3NlKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMudmlzaWJsZSA9IGZhbHNlO1xyXG4gICAgICAgIHRoaXMuc2NlbmVSZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgIGNvbnN0IG1lc3NhZ2UgPSBFZGl0b3IuTWVzc2FnZSBhcyBhbnk7XHJcbiAgICAgICAgbWVzc2FnZS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignc2NlbmU6cmVhZHknLCB0aGlzLm9uU2NlbmVSZWFkeSk7XHJcbiAgICAgICAgbWVzc2FnZS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignc2NlbmU6Y2xvc2UnLCB0aGlzLm9uU2NlbmVDbG9zZSk7XHJcbiAgICAgICAgbWVzc2FnZS5yZW1vdmVCcm9hZGNhc3RMaXN0ZW5lcignc2VsZWN0aW9uOnNlbGVjdCcsIHRoaXMub25TZWxlY3Rpb25DaGFuZ2UpO1xyXG4gICAgICAgIHRoaXMuc3RvcFByZXZpZXdUaW1lcnMoKTtcclxuICAgICAgICB2b2lkIHRoaXMuc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4oZmFsc2UpO1xyXG4gICAgICAgIHZvaWQgdGhpcy5zdG9wU2NlbmUoKTtcclxuICAgIH1cclxuXHJcbiAgICBzZXRWaXNpYmxlKHZpc2libGU6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgICAgICB0aGlzLnZpc2libGUgPSB2aXNpYmxlO1xyXG4gICAgICAgIGlmICh2aXNpYmxlKSB7XHJcbiAgICAgICAgICAgIHRoaXMuc3RvcFZlcnNpb24rKztcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnNldEVkaXRvckNhbWVyYU1pbmlQcmV2aWV3SGlkZGVuKHRydWUpO1xyXG4gICAgICAgICAgICBpZiAodGhpcy5zY2VuZVJlYWR5KSB7XHJcbiAgICAgICAgICAgICAgICB2b2lkIHRoaXMucmVmcmVzaENhbWVyYXMoKTtcclxuICAgICAgICAgICAgICAgIHZvaWQgdGhpcy5jYXB0dXJlKCk7XHJcbiAgICAgICAgICAgIH0gZWxzZSB7XHJcbiAgICAgICAgICAgICAgICB0aGlzLnNob3dQbGFjZWhvbGRlcih0cmFuc2xhdGUoJ3dhaXRpbmdfc2NlbmUnKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGVsc2Uge1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4oZmFsc2UpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc3RvcFNjZW5lKCk7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgaGFuZGxlU2NlbmVSZWFkeSgpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLnNjZW5lUmVhZHkgPSB0cnVlO1xyXG4gICAgICAgIGlmICghdGhpcy52aXNpYmxlKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgdm9pZCB0aGlzLnNldEVkaXRvckNhbWVyYU1pbmlQcmV2aWV3SGlkZGVuKHRydWUpO1xyXG4gICAgICAgIHZvaWQgdGhpcy5yZWZyZXNoQ2FtZXJhcygpO1xyXG4gICAgICAgIHRoaXMucmVzdGFydFByZXZpZXdUaW1lcnMoKTtcclxuICAgICAgICB2b2lkIHRoaXMuY2FwdHVyZSgpO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQHpoIOa4uOaIj+mihOiniOW8gOWQr+aXtumakOiXj+WcuuaZr+WPs+S4i+inkuebuOacuuWwj+eql++8m+WFs+mXremihOiniOWQjuaBouWkjeaYvuekuuOAglxyXG4gICAgICog5Zy65pmv5L6n5oum5oiqIE1pbmlQcmV2aWV3LmhhbmRsZVNlbGVjdO+8jOmBv+WFjemAieS4rSBDYW1lcmEg5pe25omT5pat5ri45oiP6aKE6KeI5riy5p+T44CCXHJcbiAgICAgKi9cclxuICAgIHByaXZhdGUgYXN5bmMgc2V0RWRpdG9yQ2FtZXJhTWluaVByZXZpZXdIaWRkZW4oaGlkZGVuOiBib29sZWFuKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgLy8g5YWI5YGc5o6J5a6a5pe25Zmo77yM6YG/5YWNIGNsb3NlIOaXtuWPiOiiq+S4i+S4gOaLjemHjeaWsOiXj+i1t+adpVxyXG4gICAgICAgIHdpbmRvdy5jbGVhckludGVydmFsKHRoaXMubWluaVByZXZpZXdIaWRlVGltZXIpO1xyXG4gICAgICAgIHRoaXMubWluaVByZXZpZXdIaWRlVGltZXIgPSAwO1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBFZGl0b3IuTWVzc2FnZS5icm9hZGNhc3QoJ2NhbWVyYS1wcmV2aWV3OnNldC1taW5pLWhpZGRlbicsIGhpZGRlbik7XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIC8vIGlnbm9yZVxyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCBzZXRFZGl0b3JNaW5pUHJldmlld0RvbUhpZGRlbihoaWRkZW4pO1xyXG5cclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmV4ZWN1dGVTY2VuZVNjcmlwdCgnc2V0TWluaVByZXZpZXdTdXBwcmVzc2VkJywgW2hpZGRlbl0pO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyDlnLrmma/mnKrlsLHnu6rml7blv73nlaXvvIxzY2VuZTpyZWFkeSDlkI7kvJrlho3orr7kuIDmrKFcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGlmIChoaWRkZW4gJiYgdGhpcy52aXNpYmxlKSB7XHJcbiAgICAgICAgICAgIC8vIERPTSDlhZzlupXvvJrkuKrliKvniYjmnKzku43kvJrpl6rkuIDkuIvlsI/nqpfvvJvlnLrmma/kvqflj6rlgZrovbvph48gZW5zdXJl77yM5LiN5YaN5q+P5binIGRlc3Ryb3lcclxuICAgICAgICAgICAgdGhpcy5taW5pUHJldmlld0hpZGVUaW1lciA9IHdpbmRvdy5zZXRJbnRlcnZhbCgoKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBpZiAoIXRoaXMudmlzaWJsZSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgICAgICAgICAgRWRpdG9yLk1lc3NhZ2UuYnJvYWRjYXN0KCdjYW1lcmEtcHJldmlldzpzZXQtbWluaS1oaWRkZW4nLCB0cnVlKTtcclxuICAgICAgICAgICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAgICAgICAgIC8vIGlnbm9yZVxyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgdm9pZCBzZXRFZGl0b3JNaW5pUHJldmlld0RvbUhpZGRlbih0cnVlKTtcclxuICAgICAgICAgICAgICAgIHZvaWQgdGhpcy5leGVjdXRlU2NlbmVTY3JpcHQoJ2hpZGVFZGl0b3JNaW5pUHJldmlldycsIFtdKS5jYXRjaCgoKSA9PiB7fSk7XHJcbiAgICAgICAgICAgIH0sIE1JTklfUFJFVklFV19ISURFX0lOVEVSVkFMKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBoYW5kbGVTY2VuZUNsb3NlKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMuc2NlbmVSZWFkeSA9IGZhbHNlO1xyXG4gICAgICAgIHRoaXMuc3RvcFByZXZpZXdUaW1lcnMoKTtcclxuICAgICAgICB0aGlzLmNhbWVyYXMgPSBbXTtcclxuICAgICAgICBpZiAodGhpcy52aXNpYmxlKSB7XHJcbiAgICAgICAgICAgIHRoaXMuc2hvd1BsYWNlaG9sZGVyKHRyYW5zbGF0ZSgnd2FpdGluZ19zY2VuZScpKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdm9pZCB0aGlzLnN0b3BTY2VuZSh0cnVlKTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIHByb2JlU2NlbmVSZWFkeSgpOiBQcm9taXNlPGJvb2xlYW4+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCB0aGlzLmV4ZWN1dGVTY2VuZVNjcmlwdCgncXVlcnlDYW1lcmFzJywgW10pO1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9IGNhdGNoIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHJlc3RhcnRQcmV2aWV3VGltZXJzKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMucmVzdGFydENhcHR1cmVUaW1lcigpO1xyXG4gICAgICAgIHdpbmRvdy5jbGVhckludGVydmFsKHRoaXMuY2FtZXJhVGltZXIpO1xyXG4gICAgICAgIHRoaXMuY2FtZXJhVGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xyXG4gICAgICAgICAgICBpZiAodGhpcy52aXNpYmxlICYmIHRoaXMuc2NlbmVSZWFkeSkge1xyXG4gICAgICAgICAgICAgICAgdm9pZCB0aGlzLnJlZnJlc2hDYW1lcmFzKCk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9LCBDQU1FUkFfUkVGUkVTSF9JTlRFUlZBTCk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBzdG9wUHJldmlld1RpbWVycygpOiB2b2lkIHtcclxuICAgICAgICB3aW5kb3cuY2xlYXJJbnRlcnZhbCh0aGlzLmNhcHR1cmVUaW1lcik7XHJcbiAgICAgICAgd2luZG93LmNsZWFySW50ZXJ2YWwodGhpcy5jYW1lcmFUaW1lcik7XHJcbiAgICAgICAgd2luZG93LmNsZWFySW50ZXJ2YWwodGhpcy5taW5pUHJldmlld0hpZGVUaW1lcik7XHJcbiAgICAgICAgdGhpcy5jYXB0dXJlVGltZXIgPSAwO1xyXG4gICAgICAgIHRoaXMuY2FtZXJhVGltZXIgPSAwO1xyXG4gICAgICAgIHRoaXMubWluaVByZXZpZXdIaWRlVGltZXIgPSAwO1xyXG4gICAgfVxyXG5cclxuICAgIC8qKlxyXG4gICAgICogQHpoIOmAmuefpeWcuuaZr+i/m+eoi+aKiuebuOacuuS7jumihOiniOeql+WPo+S4iuaRmOWbnuWOu++8jOS4jemihOiniOaXtuS4jeWNoOeUqOS7u+S9lea4suafk+W8gOmUgFxyXG4gICAgICovXHJcbiAgICBwcml2YXRlIGFzeW5jIHN0b3BTY2VuZShmb3JjZSA9IGZhbHNlKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgY29uc3Qgc3RvcFZlcnNpb24gPSArK3RoaXMuc3RvcFZlcnNpb247XHJcbiAgICAgICAgd2hpbGUgKHRoaXMuY2FwdHVyaW5nKSB7XHJcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB3aW5kb3cuc2V0VGltZW91dChyZXNvbHZlLCAwKSk7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmIChzdG9wVmVyc2lvbiAhPT0gdGhpcy5zdG9wVmVyc2lvbikge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIOmdouadv+S7jeWPr+ingeaXtum7mOiupOS4jSBzdG9w77yI6L+Y5Lya57un57ut6aKE6KeI77yJ77yb5Zy65pmv5YWz6Zet5pe25by65Yi25pGY5ZueXHJcbiAgICAgICAgaWYgKCFmb3JjZSAmJiB0aGlzLnZpc2libGUpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBhd2FpdCB0aGlzLmV4ZWN1dGVTY2VuZVNjcmlwdCgnc3RvcCcsIFtdKS5jYXRjaCgoKSA9PiB7fSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhcHBseVRleHRzKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMuJC5sYWJlbENhbWVyYS50ZXh0Q29udGVudCA9IHRyYW5zbGF0ZSgnY2FtZXJhJyk7XHJcbiAgICAgICAgdGhpcy4kLmxhYmVsUmVzb2x1dGlvbi50ZXh0Q29udGVudCA9IHRyYW5zbGF0ZSgncmVzb2x1dGlvbicpO1xyXG4gICAgICAgIHRoaXMuJC5sYWJlbE1vZGUudGV4dENvbnRlbnQgPSB0cmFuc2xhdGUoJ2Z1bGxfc2NlbmUnKTtcclxuICAgICAgICB0aGlzLiQubGFiZWxGcHMudGV4dENvbnRlbnQgPSB0cmFuc2xhdGUoJ2ZwcycpO1xyXG4gICAgICAgIHRoaXMuJC5yZWZyZXNoQnV0dG9uLnRleHRDb250ZW50ID0gdHJhbnNsYXRlKCdyZWZyZXNoJyk7XHJcbiAgICAgICAgdGhpcy4kLnJvdGF0ZUJ1dHRvbi50ZXh0Q29udGVudCA9IHRyYW5zbGF0ZSgncm90YXRlJyk7XHJcbiAgICAgICAgdGhpcy4kLnBsYWNlaG9sZGVyLnRleHRDb250ZW50ID0gdHJhbnNsYXRlKCdsb2FkaW5nJyk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBiaW5kRXZlbnRzKCk6IHZvaWQge1xyXG4gICAgICAgIG9uVmFsdWVDaGFuZ2UodGhpcy4kLmNhbWVyYVNlbGVjdCwgKGV2ZW50OiBhbnkpID0+IHtcclxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5jYW1lcmFVdWlkID0gU3RyaW5nKGV2ZW50LnRhcmdldC52YWx1ZSB8fCAnJyk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLmNhcHR1cmUoKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBvblZhbHVlQ2hhbmdlKHRoaXMuJC5kZXZpY2VTZWxlY3QsIChldmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MuZGV2aWNlS2V5ID0gU3RyaW5nKGV2ZW50LnRhcmdldC52YWx1ZSB8fCAnJyk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgICAgdGhpcy51cGRhdGVTdGF0dXMoKTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLmNhcHR1cmUoKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBvblZhbHVlQ2hhbmdlKHRoaXMuJC5tb2RlQ2hlY2tib3gsIChldmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MubW9kZSA9IGV2ZW50LnRhcmdldC52YWx1ZSA/ICdhbGwnIDogJ3NpbmdsZSc7XHJcbiAgICAgICAgICAgIHRoaXMuc3luY0NvbnRyb2xzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5zYXZlU2V0dGluZ3MoKTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLmNhcHR1cmUoKTtcclxuICAgICAgICB9KTtcclxuICAgICAgICBvblZhbHVlQ2hhbmdlKHRoaXMuJC5mcHNTZWxlY3QsIChldmVudDogYW55KSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MuZnBzID0gTnVtYmVyKGV2ZW50LnRhcmdldC52YWx1ZSkgfHwgREVGQVVMVF9TRVRUSU5HUy5mcHM7XHJcbiAgICAgICAgICAgIHRoaXMucmVzdGFydENhcHR1cmVUaW1lcigpO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgb25DbGljayh0aGlzLiQucmVmcmVzaEJ1dHRvbiwgKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMucmVmcmVzaERldmljZXMoKTtcclxuICAgICAgICAgICAgdm9pZCB0aGlzLnJlZnJlc2hDYW1lcmFzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYXB0dXJlKCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICAgICAgb25DbGljayh0aGlzLiQucm90YXRlQnV0dG9uLCAoKSA9PiB7XHJcbiAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MubGFuZHNjYXBlID0gIXRoaXMuc2V0dGluZ3MubGFuZHNjYXBlO1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuc2F2ZVNldHRpbmdzKCk7XHJcbiAgICAgICAgICAgIHRoaXMudXBkYXRlU3RhdHVzKCk7XHJcbiAgICAgICAgICAgIHZvaWQgdGhpcy5jYXB0dXJlKCk7XHJcbiAgICAgICAgfSk7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBsb2FkU2V0dGluZ3MoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgY29uc3Qgc2F2ZWQgPSBhd2FpdCBFZGl0b3IuUHJvZmlsZS5nZXRDb25maWcoUEFDS0FHRV9OQU1FLCAnc2V0dGluZ3MnLCAnbG9jYWwnKTtcclxuICAgICAgICAgICAgaWYgKHNhdmVkICYmIHR5cGVvZiBzYXZlZCA9PT0gJ29iamVjdCcpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMuc2V0dGluZ3MgPSB7IC4uLkRFRkFVTFRfU0VUVElOR1MsIC4uLnNhdmVkIH07XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICBjb25zb2xlLndhcm4oYFske1BBQ0tBR0VfTkFNRX1dYCwgZXJyb3IpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIHNhdmVTZXR0aW5ncygpOiBQcm9taXNlPHZvaWQ+IHtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBhd2FpdCBFZGl0b3IuUHJvZmlsZS5zZXRDb25maWcoUEFDS0FHRV9OQU1FLCAnc2V0dGluZ3MnLCB7IC4uLnRoaXMuc2V0dGluZ3MgfSwgJ2xvY2FsJyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbJHtQQUNLQUdFX05BTUV9XWAsIGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBmaWxsRml4ZWRTZWxlY3RzKCk6IHZvaWQge1xyXG4gICAgICAgIHRoaXMuJC5mcHNTZWxlY3QuaW5uZXJIVE1MID0gRlBTX09QVElPTlMubWFwKChmcHMpID0+IGA8b3B0aW9uIHZhbHVlPVwiJHtmcHN9XCI+JHtmcHN9IEZQUzwvb3B0aW9uPmApLmpvaW4oJycpO1xyXG4gICAgICAgIHRoaXMuJC5mcHNTZWxlY3QudmFsdWUgPSBTdHJpbmcodGhpcy5zZXR0aW5ncy5mcHMpO1xyXG4gICAgICAgIHRoaXMuJC5tb2RlQ2hlY2tib3gudmFsdWUgPSB0aGlzLnNldHRpbmdzLm1vZGUgPT09ICdhbGwnO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgYXN5bmMgcmVmcmVzaERldmljZXMoKTogUHJvbWlzZTx2b2lkPiB7XHJcbiAgICAgICAgbGV0IGRldmljZXM6IElEZXZpY2VJdGVtW10gPSBbXTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBkZXZpY2VzID0gYXdhaXQgRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnZGV2aWNlJywgJ3F1ZXJ5Jyk7XHJcbiAgICAgICAgfSBjYXRjaCAoZXJyb3IpIHtcclxuICAgICAgICAgICAgY29uc29sZS53YXJuKGBbJHtQQUNLQUdFX05BTUV9XWAsIGVycm9yKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFBcnJheS5pc0FycmF5KGRldmljZXMpKSB7XHJcbiAgICAgICAgICAgIGRldmljZXMgPSBbXTtcclxuICAgICAgICB9XHJcbiAgICAgICAgZGV2aWNlcyA9IGRldmljZXMuZmlsdGVyKChkZXZpY2UpID0+IGRldmljZSAmJiBkZXZpY2Uud2lkdGggPiAwICYmIGRldmljZS5oZWlnaHQgPiAwKTtcclxuICAgICAgICB0aGlzLmRldmljZXMgPSBkZXZpY2VzLmxlbmd0aCA+IDAgPyBkZXZpY2VzIDogRkFMTEJBQ0tfREVWSUNFUztcclxuXHJcbiAgICAgICAgY29uc3Qgb3B0aW9ucyA9IHRoaXMuZGV2aWNlc1xyXG4gICAgICAgICAgICAubWFwKChkZXZpY2UpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IGtleSA9IGVzY2FwZUh0bWwoZ2V0RGV2aWNlS2V5KGRldmljZSkpO1xyXG4gICAgICAgICAgICAgICAgY29uc3QgbGFiZWwgPSBlc2NhcGVIdG1sKGAke2RldmljZS5uYW1lfSAoJHtkZXZpY2Uud2lkdGh9eCR7ZGV2aWNlLmhlaWdodH0pYCk7XHJcbiAgICAgICAgICAgICAgICByZXR1cm4gYDxvcHRpb24gdmFsdWU9XCIke2tleX1cIj4ke2xhYmVsfTwvb3B0aW9uPmA7XHJcbiAgICAgICAgICAgIH0pXHJcbiAgICAgICAgICAgIC5qb2luKCcnKTtcclxuICAgICAgICB0aGlzLiQuZGV2aWNlU2VsZWN0LmlubmVySFRNTCA9IG9wdGlvbnM7XHJcblxyXG4gICAgICAgIGlmICghdGhpcy5kZXZpY2VzLnNvbWUoKGRldmljZSkgPT4gZ2V0RGV2aWNlS2V5KGRldmljZSkgPT09IHRoaXMuc2V0dGluZ3MuZGV2aWNlS2V5KSkge1xyXG4gICAgICAgICAgICB0aGlzLnNldHRpbmdzLmRldmljZUtleSA9IGdldERldmljZUtleSh0aGlzLmRldmljZXNbMF0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICB0aGlzLiQuZGV2aWNlU2VsZWN0LnZhbHVlID0gdGhpcy5zZXR0aW5ncy5kZXZpY2VLZXk7XHJcbiAgICAgICAgdGhpcy51cGRhdGVTdGF0dXMoKTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGFzeW5jIHJlZnJlc2hDYW1lcmFzKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGlmICghdGhpcy5zY2VuZVJlYWR5KSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgbGV0IGNhbWVyYXM6IElDYW1lcmFJbmZvW10gPSBbXTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjYW1lcmFzID0gYXdhaXQgdGhpcy5leGVjdXRlU2NlbmVTY3JpcHQ8SUNhbWVyYUluZm9bXT4oJ3F1ZXJ5Q2FtZXJhcycsIFtdKTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcikge1xyXG4gICAgICAgICAgICAvLyDlnLrmma/ov5jmsqHmiZPlvIDmiJbmraPlnKjliIfmjaLml7bmn6Xor6LkvJrlpLHotKXvvIzmjInmsqHmnInnm7jmnLrlpITnkIbljbPlj69cclxuICAgICAgICAgICAgY2FtZXJhcyA9IFtdO1xyXG4gICAgICAgIH1cclxuICAgICAgICBpZiAoIUFycmF5LmlzQXJyYXkoY2FtZXJhcykpIHtcclxuICAgICAgICAgICAgY2FtZXJhcyA9IFtdO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBjaGFuZ2VkID1cclxuICAgICAgICAgICAgY2FtZXJhcy5sZW5ndGggIT09IHRoaXMuY2FtZXJhcy5sZW5ndGggfHxcclxuICAgICAgICAgICAgY2FtZXJhcy5zb21lKChjYW1lcmEsIGluZGV4KSA9PiBjYW1lcmEudXVpZCAhPT0gdGhpcy5jYW1lcmFzW2luZGV4XS51dWlkIHx8IGNhbWVyYS5wYXRoICE9PSB0aGlzLmNhbWVyYXNbaW5kZXhdLnBhdGgpO1xyXG4gICAgICAgIHRoaXMuY2FtZXJhcyA9IGNhbWVyYXM7XHJcbiAgICAgICAgaWYgKCFjaGFuZ2VkKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIHRoaXMuJC5jYW1lcmFTZWxlY3QuaW5uZXJIVE1MID0gY2FtZXJhc1xyXG4gICAgICAgICAgICAubWFwKChjYW1lcmEpID0+IHtcclxuICAgICAgICAgICAgICAgIGNvbnN0IHN1ZmZpeCA9IGNhbWVyYS5lbmFibGVkID8gJycgOiBgICgke3RyYW5zbGF0ZSgnZGlzYWJsZWQnKX0pYDtcclxuICAgICAgICAgICAgICAgIHJldHVybiBgPG9wdGlvbiB2YWx1ZT1cIiR7ZXNjYXBlSHRtbChjYW1lcmEudXVpZCl9XCI+JHtlc2NhcGVIdG1sKGNhbWVyYS5wYXRoIHx8IGNhbWVyYS5uYW1lKX0ke3N1ZmZpeH08L29wdGlvbj5gO1xyXG4gICAgICAgICAgICB9KVxyXG4gICAgICAgICAgICAuam9pbignJyk7XHJcbiAgICAgICAgaWYgKCFjYW1lcmFzLnNvbWUoKGNhbWVyYSkgPT4gY2FtZXJhLnV1aWQgPT09IHRoaXMuc2V0dGluZ3MuY2FtZXJhVXVpZCkpIHtcclxuICAgICAgICAgICAgdGhpcy5zZXR0aW5ncy5jYW1lcmFVdWlkID0gY2FtZXJhcy5sZW5ndGggPiAwID8gY2FtZXJhc1swXS51dWlkIDogJyc7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRoaXMuJC5jYW1lcmFTZWxlY3QudmFsdWUgPSB0aGlzLnNldHRpbmdzLmNhbWVyYVV1aWQ7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBzeW5jQ29udHJvbHMoKTogdm9pZCB7XHJcbiAgICAgICAgY29uc3Qgc2luZ2xlTW9kZSA9IHRoaXMuc2V0dGluZ3MubW9kZSA9PT0gJ3NpbmdsZSc7XHJcbiAgICAgICAgaWYgKHNpbmdsZU1vZGUpIHtcclxuICAgICAgICAgICAgdGhpcy4kLmNhbWVyYVNlbGVjdC5yZW1vdmVBdHRyaWJ1dGUoJ2Rpc2FibGVkJyk7XHJcbiAgICAgICAgfSBlbHNlIHtcclxuICAgICAgICAgICAgdGhpcy4kLmNhbWVyYVNlbGVjdC5zZXRBdHRyaWJ1dGUoJ2Rpc2FibGVkJywgJycpO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHJlc3RhcnRDYXB0dXJlVGltZXIoKTogdm9pZCB7XHJcbiAgICAgICAgd2luZG93LmNsZWFySW50ZXJ2YWwodGhpcy5jYXB0dXJlVGltZXIpO1xyXG4gICAgICAgIGNvbnN0IGludGVydmFsID0gTWF0aC5tYXgoMTYsIE1hdGgucm91bmQoMTAwMCAvIHRoaXMuc2V0dGluZ3MuZnBzKSk7XHJcbiAgICAgICAgdGhpcy5jYXB0dXJlVGltZXIgPSB3aW5kb3cuc2V0SW50ZXJ2YWwoKCkgPT4ge1xyXG4gICAgICAgICAgICB2b2lkIHRoaXMuY2FwdHVyZSgpO1xyXG4gICAgICAgIH0sIGludGVydmFsKTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIGV4ZWN1dGVTY2VuZVNjcmlwdDxUPihtZXRob2Q6IHN0cmluZywgYXJnczogYW55W10pOiBQcm9taXNlPFQ+IHtcclxuICAgICAgICByZXR1cm4gRWRpdG9yLk1lc3NhZ2UucmVxdWVzdCgnc2NlbmUnLCAnZXhlY3V0ZS1zY2VuZS1zY3JpcHQnLCB7XHJcbiAgICAgICAgICAgIG5hbWU6IFBBQ0tBR0VfTkFNRSxcclxuICAgICAgICAgICAgbWV0aG9kLFxyXG4gICAgICAgICAgICBhcmdzLFxyXG4gICAgICAgIH0pO1xyXG4gICAgfVxyXG5cclxuICAgIHByaXZhdGUgY3VycmVudERldmljZSgpOiBJRGV2aWNlSXRlbSB8IG51bGwge1xyXG4gICAgICAgIHJldHVybiB0aGlzLmRldmljZXMuZmluZCgoZGV2aWNlKSA9PiBnZXREZXZpY2VLZXkoZGV2aWNlKSA9PT0gdGhpcy5zZXR0aW5ncy5kZXZpY2VLZXkpIHx8IG51bGw7XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBjdXJyZW50UmVzb2x1dGlvbigpOiB7IHdpZHRoOiBudW1iZXI7IGhlaWdodDogbnVtYmVyIH0gfCBudWxsIHtcclxuICAgICAgICBjb25zdCBkZXZpY2UgPSB0aGlzLmN1cnJlbnREZXZpY2UoKTtcclxuICAgICAgICBpZiAoIWRldmljZSkge1xyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHRoaXMuc2V0dGluZ3MubGFuZHNjYXBlXHJcbiAgICAgICAgICAgID8geyB3aWR0aDogZGV2aWNlLmhlaWdodCwgaGVpZ2h0OiBkZXZpY2Uud2lkdGggfVxyXG4gICAgICAgICAgICA6IHsgd2lkdGg6IGRldmljZS53aWR0aCwgaGVpZ2h0OiBkZXZpY2UuaGVpZ2h0IH07XHJcbiAgICB9XHJcblxyXG4gICAgcHJpdmF0ZSBhc3luYyBjYXB0dXJlKCk6IFByb21pc2U8dm9pZD4ge1xyXG4gICAgICAgIGlmICghdGhpcy52aXNpYmxlIHx8ICF0aGlzLnNjZW5lUmVhZHkgfHwgdGhpcy5jYXB0dXJpbmcpIHtcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCByZXNvbHV0aW9uID0gdGhpcy5jdXJyZW50UmVzb2x1dGlvbigpO1xyXG4gICAgICAgIGlmICghcmVzb2x1dGlvbikge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIC8vIOa4suafk+WwuuWvuOaMieacgOmVv+i+uSAxMDgwIOetieavlOe8qeaUvu+8jOeUu+mdouavlOS+i+S4juaJgOmAieWIhui+qOeOh+S4gOiHtFxyXG4gICAgICAgIGNvbnN0IHNjYWxlID0gTWF0aC5taW4oMSwgUkVOREVSX0xJTUlUIC8gTWF0aC5tYXgocmVzb2x1dGlvbi53aWR0aCwgcmVzb2x1dGlvbi5oZWlnaHQpKTtcclxuICAgICAgICBjb25zdCB3aWR0aCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQocmVzb2x1dGlvbi53aWR0aCAqIHNjYWxlKSk7XHJcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChyZXNvbHV0aW9uLmhlaWdodCAqIHNjYWxlKSk7XHJcblxyXG4gICAgICAgIHRoaXMuY2FwdHVyaW5nID0gdHJ1ZTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICBjb25zdCByZXN1bHQgPSBhd2FpdCB0aGlzLmV4ZWN1dGVTY2VuZVNjcmlwdDxJQ2FwdHVyZVJlc3VsdCB8IG51bGw+KCdjYXB0dXJlJywgW1xyXG4gICAgICAgICAgICAgICAge1xyXG4gICAgICAgICAgICAgICAgICAgIG1vZGU6IHRoaXMuc2V0dGluZ3MubW9kZSxcclxuICAgICAgICAgICAgICAgICAgICBjYW1lcmFVdWlkOiB0aGlzLnNldHRpbmdzLmNhbWVyYVV1aWQsXHJcbiAgICAgICAgICAgICAgICAgICAgd2lkdGgsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIHF1YWxpdHk6IENBUFRVUkVfUVVBTElUWSxcclxuICAgICAgICAgICAgICAgIH0sXHJcbiAgICAgICAgICAgIF0pO1xyXG4gICAgICAgICAgICBpZiAoIXRoaXMudmlzaWJsZSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmICghcmVzdWx0IHx8ICFyZXN1bHQuZGF0YVVybCkge1xyXG4gICAgICAgICAgICAgICAgLy8g6YCJ5LitIENhbWVyYSDml7bnvJbovpHlmajlj6/og73nn63mmoLlubLmibDvvJvlt7LmnInnlLvpnaLliJnkv53nlZnvvIzpgb/lhY3pl6rmiJDnqbrnmb1cclxuICAgICAgICAgICAgICAgIGlmICghdGhpcy5oYXNQcmV2aWV3RnJhbWUoKSkge1xyXG4gICAgICAgICAgICAgICAgICAgIHRoaXMuc2hvd1BsYWNlaG9sZGVyKHRyYW5zbGF0ZSgnbm9fY2FtZXJhJykpO1xyXG4gICAgICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHRoaXMuJC5wcmV2aWV3LnNyYyA9IHJlc3VsdC5kYXRhVXJsO1xyXG4gICAgICAgICAgICB0aGlzLiQucHJldmlldy5zdHlsZS52aXNpYmlsaXR5ID0gJ3Zpc2libGUnO1xyXG4gICAgICAgICAgICB0aGlzLiQucGxhY2Vob2xkZXIudGV4dENvbnRlbnQgPSAnJztcclxuICAgICAgICAgICAgdGhpcy51cGRhdGVTdGF0dXMocmVzdWx0KTtcclxuICAgICAgICB9IGNhdGNoIChlcnJvcjogYW55KSB7XHJcbiAgICAgICAgICAgIGlmICh0aGlzLnZpc2libGUgJiYgIXRoaXMuaGFzUHJldmlld0ZyYW1lKCkpIHtcclxuICAgICAgICAgICAgICAgIHRoaXMuc2hvd1BsYWNlaG9sZGVyKGVycm9yICYmIGVycm9yLm1lc3NhZ2UgPyBlcnJvci5tZXNzYWdlIDogU3RyaW5nKGVycm9yKSk7XHJcbiAgICAgICAgICAgIH1cclxuICAgICAgICB9IGZpbmFsbHkge1xyXG4gICAgICAgICAgICB0aGlzLmNhcHR1cmluZyA9IGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHNob3dQbGFjZWhvbGRlcihtZXNzYWdlOiBzdHJpbmcpOiB2b2lkIHtcclxuICAgICAgICB0aGlzLiQucHJldmlldy5zdHlsZS52aXNpYmlsaXR5ID0gJ2hpZGRlbic7XHJcbiAgICAgICAgdGhpcy4kLnBsYWNlaG9sZGVyLnRleHRDb250ZW50ID0gbWVzc2FnZTtcclxuICAgIH1cclxuXHJcbiAgICBwcml2YXRlIHVwZGF0ZVN0YXR1cyhyZXN1bHQ/OiBJQ2FwdHVyZVJlc3VsdCk6IHZvaWQge1xyXG4gICAgICAgIGNvbnN0IHJlc29sdXRpb24gPSB0aGlzLmN1cnJlbnRSZXNvbHV0aW9uKCk7XHJcbiAgICAgICAgaWYgKCFyZXNvbHV0aW9uKSB7XHJcbiAgICAgICAgICAgIHRoaXMuJC5zdGF0dXMudGV4dENvbnRlbnQgPSAnJztcclxuICAgICAgICAgICAgcmV0dXJuO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBwYXJ0cyA9IFtgJHtyZXNvbHV0aW9uLndpZHRofSB4ICR7cmVzb2x1dGlvbi5oZWlnaHR9YF07XHJcbiAgICAgICAgaWYgKHJlc3VsdCkge1xyXG4gICAgICAgICAgICBwYXJ0cy5wdXNoKGAke3RyYW5zbGF0ZSgnY2FtZXJhJyl9OiAke3Jlc3VsdC5jYW1lcmFDb3VudH1gKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdGhpcy4kLnN0YXR1cy50ZXh0Q29udGVudCA9IHBhcnRzLmpvaW4oJyAgICAnKTtcclxuICAgIH1cclxufVxyXG5cclxubGV0IGN1cnJlbnRQYW5lbDogQ2FtZXJhUHJldmlld1BhbmVsIHwgbnVsbCA9IG51bGw7XHJcblxyXG5tb2R1bGUuZXhwb3J0cyA9IEVkaXRvci5QYW5lbC5kZWZpbmUoe1xyXG4gICAgbGlzdGVuZXJzOiB7XHJcbiAgICAgICAgc2hvdygpIHtcclxuICAgICAgICAgICAgY3VycmVudFBhbmVsPy5zZXRWaXNpYmxlKHRydWUpO1xyXG4gICAgICAgIH0sXHJcbiAgICAgICAgaGlkZSgpIHtcclxuICAgICAgICAgICAgY3VycmVudFBhbmVsPy5zZXRWaXNpYmxlKGZhbHNlKTtcclxuICAgICAgICB9LFxyXG4gICAgfSxcclxuICAgIHRlbXBsYXRlOiByZWFkRmlsZVN5bmMoam9pbihfX2Rpcm5hbWUsICcuLi8uLi8uLi9zdGF0aWMvdGVtcGxhdGUvZGVmYXVsdC9pbmRleC5odG1sJyksICd1dGYtOCcpLFxyXG4gICAgc3R5bGU6IHJlYWRGaWxlU3luYyhqb2luKF9fZGlybmFtZSwgJy4uLy4uLy4uL3N0YXRpYy9zdHlsZS9kZWZhdWx0L2luZGV4LmNzcycpLCAndXRmLTgnKSxcclxuICAgICQ6IHtcclxuICAgICAgICBsYWJlbENhbWVyYTogJyNsYWJlbENhbWVyYScsXHJcbiAgICAgICAgbGFiZWxSZXNvbHV0aW9uOiAnI2xhYmVsUmVzb2x1dGlvbicsXHJcbiAgICAgICAgbGFiZWxNb2RlOiAnI2xhYmVsTW9kZScsXHJcbiAgICAgICAgbGFiZWxGcHM6ICcjbGFiZWxGcHMnLFxyXG4gICAgICAgIGNhbWVyYVNlbGVjdDogJyNjYW1lcmFTZWxlY3QnLFxyXG4gICAgICAgIGRldmljZVNlbGVjdDogJyNkZXZpY2VTZWxlY3QnLFxyXG4gICAgICAgIHJlZnJlc2hCdXR0b246ICcjcmVmcmVzaEJ1dHRvbicsXHJcbiAgICAgICAgcm90YXRlQnV0dG9uOiAnI3JvdGF0ZUJ1dHRvbicsXHJcbiAgICAgICAgbW9kZUNoZWNrYm94OiAnI21vZGVDaGVja2JveCcsXHJcbiAgICAgICAgZnBzU2VsZWN0OiAnI2Zwc1NlbGVjdCcsXHJcbiAgICAgICAgcHJldmlldzogJyNwcmV2aWV3JyxcclxuICAgICAgICBwbGFjZWhvbGRlcjogJyNwbGFjZWhvbGRlcicsXHJcbiAgICAgICAgc3RhdHVzOiAnI3N0YXR1cycsXHJcbiAgICB9LFxyXG4gICAgbWV0aG9kczoge30sXHJcbiAgICByZWFkeSgpIHtcclxuICAgICAgICBjdXJyZW50UGFuZWwgPSBuZXcgQ2FtZXJhUHJldmlld1BhbmVsKHRoaXMuJCBhcyBSZWNvcmQ8c3RyaW5nLCBhbnk+KTtcclxuICAgICAgICB2b2lkIGN1cnJlbnRQYW5lbC5pbml0KCk7XHJcbiAgICB9LFxyXG4gICAgYmVmb3JlQ2xvc2UoKSB7fSxcclxuICAgIGNsb3NlKCkge1xyXG4gICAgICAgIGN1cnJlbnRQYW5lbD8uZGlzcG9zZSgpO1xyXG4gICAgICAgIGN1cnJlbnRQYW5lbCA9IG51bGw7XHJcbiAgICB9LFxyXG59KTtcclxuIl19
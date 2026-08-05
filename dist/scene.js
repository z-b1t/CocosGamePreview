"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.methods = void 0;
exports.load = load;
exports.unload = unload;
require("./engine-path");
const cc_1 = require("cc");
let renderTexture = null;
let encodeCanvas = null;
let encodeImageData = null;
let pixelBuffer = null;
/** 上一帧像素副本，用于跳过无变化时的 JPEG 编码与 IPC。 */
let lastFramePixels = null;
/** 仅用于预览的临时相机节点，绝不改动场景里原有 Camera 的渲染目标。 */
let previewNodes = [];
/** 与 previewNodes 一一对应的源相机 uuid，用于判断是否需要重建。 */
let previewSourceUuids = [];
let healThrottleUntil = 0;
const EDITOR_CAMERA_NODE_NAMES = new Set(['Editor Scene Background', 'Scene Gizmo Camera']);
const PREVIEW_NODE_NAME = '__CameraPreviewProxy__';
function isRendererReady() {
    const root = cc_1.director.root;
    return !!(root === null || root === void 0 ? void 0 : root.mainWindow) && !!root.pipeline && root.device.swapchainFormat !== cc_1.gfx.Format.UNKNOWN;
}
function getTempWindow() {
    var _a, _b;
    return (_b = (_a = cc_1.director.root) === null || _a === void 0 ? void 0 : _a.tempWindow) !== null && _b !== void 0 ? _b : null;
}
/**
 * @zh 编辑期游戏相机会挂在 root.tempWindow 上。
 * 旧版本插件若把相机摘成 window=null，这里尽量补回，避免编辑器相机小窗持续报错。
 */
function healGameCameraWindows() {
    const tempWindow = getTempWindow();
    if (!tempWindow) {
        return;
    }
    for (const component of getSceneCameras()) {
        if (component.targetTexture) {
            continue;
        }
        const camera = component.camera;
        if (!camera) {
            continue;
        }
        try {
            if (!camera.window) {
                camera.changeTargetWindow(tempWindow);
            }
        }
        catch (_a) {
            // 忽略个别已销毁相机
        }
    }
}
function getSceneCameras() {
    const scene = cc_1.director.getScene();
    if (!scene) {
        return [];
    }
    return scene
        .getComponentsInChildren(cc_1.Camera)
        .filter((camera) => {
        if (EDITOR_CAMERA_NODE_NAMES.has(camera.node.name)) {
            return false;
        }
        if (camera.node.name === PREVIEW_NODE_NAME) {
            return false;
        }
        return true;
    });
}
function getNodePath(node) {
    const names = [];
    let current = node;
    while (current && current.parent) {
        names.unshift(current.name);
        current = current.parent;
    }
    return names.join('/');
}
function setPreviewCamerasEnabled(enabled) {
    for (const node of previewNodes) {
        if (!node.isValid) {
            continue;
        }
        const camera = node.getComponent(cc_1.Camera);
        if (camera) {
            camera.enabled = enabled;
        }
    }
}
function destroyPreviewCameras() {
    for (const node of previewNodes) {
        try {
            if (node.isValid) {
                const camera = node.getComponent(cc_1.Camera);
                if (camera) {
                    camera.targetTexture = null;
                }
                node.destroy();
            }
        }
        catch (_a) {
            // 场景切换时节点可能已失效
        }
    }
    previewNodes = [];
    previewSourceUuids = [];
}
function ensureRenderTexture(width, height) {
    if (!renderTexture) {
        const texture = new cc_1.RenderTexture();
        texture.reset({ width, height });
        renderTexture = texture;
    }
    else if (renderTexture.width !== width || renderTexture.height !== height) {
        destroyPreviewCameras();
        renderTexture.resize(width, height);
    }
    return renderTexture;
}
function destroyRenderTexture() {
    destroyPreviewCameras();
    if (!renderTexture) {
        return;
    }
    renderTexture.destroy();
    renderTexture = null;
}
function ensureEncodeCanvas(width, height) {
    if (!encodeCanvas) {
        encodeCanvas = document.createElement('canvas');
    }
    if (encodeCanvas.width !== width || encodeCanvas.height !== height) {
        encodeCanvas.width = width;
        encodeCanvas.height = height;
        encodeImageData = null;
    }
    return encodeCanvas;
}
function ensurePixelBuffer(size) {
    if (!pixelBuffer || pixelBuffer.length !== size) {
        pixelBuffer = new Uint8Array(size);
    }
    return pixelBuffer;
}
function copyCameraSettings(source, target) {
    target.priority = source.priority;
    target.visibility = source.visibility;
    target.clearFlags = source.clearFlags;
    target.clearColor = new cc_1.Color(source.clearColor.r, source.clearColor.g, source.clearColor.b, source.clearColor.a);
    target.clearDepth = source.clearDepth;
    target.clearStencil = source.clearStencil;
    target.projection = source.projection;
    target.fovAxis = source.fovAxis;
    target.fov = source.fov;
    target.orthoHeight = source.orthoHeight;
    target.near = source.near;
    target.far = source.far;
    target.aperture = source.aperture;
    target.shutter = source.shutter;
    target.iso = source.iso;
    const rect = source.rect;
    target.rect = new cc_1.Rect(rect.x, rect.y, rect.width, rect.height);
}
function syncProxyNode(source, node) {
    node.layer = source.node.layer;
    node.setWorldPosition(source.node.worldPosition);
    node.setWorldRotation(source.node.worldRotation);
    node.setWorldScale(source.node.worldScale);
    const camera = node.getComponent(cc_1.Camera);
    if (camera) {
        copyCameraSettings(source, camera);
        camera.targetTexture = renderTexture;
    }
}
/**
 * @zh 创建与源相机同姿态/同参数的临时 Camera，只把它们的 targetTexture 指到预览贴图。
 * 这样完全不调用场景相机的 changeTargetWindow，编辑器相机小窗不会被抢走。
 */
function createPreviewCameras(sources, texture) {
    var _a;
    destroyPreviewCameras();
    const scene = cc_1.director.getScene();
    if (!scene) {
        return 0;
    }
    for (const source of sources) {
        if (!source.isValid || !((_a = source.node) === null || _a === void 0 ? void 0 : _a.isValid)) {
            continue;
        }
        const node = new cc_1.Node(PREVIEW_NODE_NAME);
        node.hideFlags |= cc_1.CCObject.Flags.DontSave | cc_1.CCObject.Flags.HideInHierarchy;
        node.layer = source.node.layer;
        scene.addChild(node);
        node.setWorldPosition(source.node.worldPosition);
        node.setWorldRotation(source.node.worldRotation);
        node.setWorldScale(source.node.worldScale);
        const camera = node.addComponent(cc_1.Camera);
        copyCameraSettings(source, camera);
        camera.targetTexture = texture;
        camera.enabled = false;
        previewNodes.push(node);
        previewSourceUuids.push(source.node.uuid);
    }
    return previewNodes.length;
}
function sourceListMatches(sources) {
    var _a;
    if (sources.length !== previewSourceUuids.length || sources.length !== previewNodes.length) {
        return false;
    }
    for (let i = 0; i < sources.length; i++) {
        if (!sources[i].isValid || sources[i].node.uuid !== previewSourceUuids[i]) {
            return false;
        }
        if (!((_a = previewNodes[i]) === null || _a === void 0 ? void 0 : _a.isValid)) {
            return false;
        }
    }
    return true;
}
function ensurePreviewCameras(sources, texture) {
    if (sourceListMatches(sources)) {
        for (let i = 0; i < sources.length; i++) {
            syncProxyNode(sources[i], previewNodes[i]);
        }
        return previewNodes.length;
    }
    return createPreviewCameras(sources, texture);
}
function resolveTargets(options) {
    const cameras = getSceneCameras();
    if (options.mode === 'single') {
        const target = cameras.find((camera) => camera.node.uuid === options.cameraUuid);
        return target ? [target] : [];
    }
    return cameras
        .filter((camera) => camera.enabledInHierarchy && !camera.targetTexture)
        .sort((a, b) => a.priority - b.priority);
}
function requestRepaint() {
    var _a, _b;
    const editorScene = globalThis.cce;
    (_b = (_a = editorScene === null || editorScene === void 0 ? void 0 : editorScene.Engine) === null || _a === void 0 ? void 0 : _a.repaintInEditMode) === null || _b === void 0 ? void 0 : _b.call(_a);
}
const MINI_PREVIEW_PATCH_KEY = '__gamePreviewMiniPatch__';
/** 游戏预览开启期间压制编辑器 MiniPreview，避免选中 Camera 时抢渲染/打断 capture。 */
let miniPreviewSuppressed = false;
/** 压制期间记录选中的节点，关闭游戏预览后用于恢复小窗。 */
let suppressedSelectUuid = null;
/**
 * @zh 拿到编辑器内置的相机小窗（MiniPreview）管理器。
 */
function getEditorMiniPreview() {
    var _a, _b, _c, _d, _e;
    const cce = globalThis.cce;
    if (!cce) {
        return null;
    }
    const fromFacade = (_c = (_b = (_a = cce.SceneFacadeManager) === null || _a === void 0 ? void 0 : _a.getCurrentFacade) === null || _b === void 0 ? void 0 : _b.call(_a)) === null || _c === void 0 ? void 0 : _c._miniPreviewMgr;
    if (fromFacade) {
        return fromFacade;
    }
    return ((_d = cce.Preview) === null || _d === void 0 ? void 0 : _d.miniPreview) || ((_e = cce.previewMgr) === null || _e === void 0 ? void 0 : _e.miniPreview) || null;
}
/**
 * @zh 清掉 MiniPreview 已创建的预览节点，不调用 handleUnselect（避免误伤层级选中）。
 */
function clearMiniPreviewNodes(mini) {
    try {
        const curr = mini.currNode;
        if (curr === null || curr === void 0 ? void 0 : curr.uuid) {
            suppressedSelectUuid = curr.uuid;
        }
    }
    catch (_a) {
        // ignore
    }
    try {
        const nodes = mini.previewNodes;
        if (!nodes) {
            return;
        }
        const values = nodes instanceof Map
            ? Array.from(nodes.values())
            : Array.isArray(nodes)
                ? [...nodes]
                : Object.values(nodes);
        for (const value of values) {
            const camera = (value === null || value === void 0 ? void 0 : value.cameraComponent) || (value === null || value === void 0 ? void 0 : value.camera) || value;
            if (camera && typeof mini.removePreviewNode === 'function') {
                mini.removePreviewNode(camera);
            }
        }
    }
    catch (_b) {
        // ignore
    }
}
function patchMiniPreview(mini) {
    if (mini[MINI_PREVIEW_PATCH_KEY]) {
        return;
    }
    const originalHandleSelect = typeof mini.handleSelect === 'function'
        ? mini.handleSelect.bind(mini)
        : null;
    const originalCreatePreviewNode = typeof mini.createPreviewNode === 'function'
        ? mini.createPreviewNode.bind(mini)
        : null;
    mini[MINI_PREVIEW_PATCH_KEY] = {
        handleSelect: originalHandleSelect,
        createPreviewNode: originalCreatePreviewNode,
    };
    mini.handleSelect = (uuid) => {
        if (uuid) {
            suppressedSelectUuid = uuid;
        }
    };
    mini.createPreviewNode = () => null;
}
function unpatchMiniPreview(mini) {
    const original = mini[MINI_PREVIEW_PATCH_KEY];
    if (!original) {
        return;
    }
    if (original.handleSelect) {
        mini.handleSelect = original.handleSelect;
    }
    if (original.createPreviewNode) {
        mini.createPreviewNode = original.createPreviewNode;
    }
    delete mini[MINI_PREVIEW_PATCH_KEY];
}
/**
 * @zh 游戏预览开启时压制编辑器相机小窗；关闭后恢复并由编辑器按当前选中重新弹出。
 */
function setEditorMiniPreviewSuppressed(suppressed) {
    var _a;
    miniPreviewSuppressed = suppressed;
    const mini = getEditorMiniPreview();
    if (!mini) {
        return;
    }
    if (suppressed) {
        patchMiniPreview(mini);
        clearMiniPreviewNodes(mini);
        return;
    }
    unpatchMiniPreview(mini);
    const uuid = suppressedSelectUuid || ((_a = mini.currNode) === null || _a === void 0 ? void 0 : _a.uuid) || null;
    suppressedSelectUuid = null;
    if (uuid && typeof mini.handleSelect === 'function') {
        try {
            mini.handleSelect(uuid);
        }
        catch (_b) {
            // ignore
        }
    }
}
/**
 * @zh 确保压制状态仍生效（场景重载后面具实例可能换新），并清掉已弹出的小窗。
 */
function hideEditorMiniPreview() {
    if (!miniPreviewSuppressed) {
        return;
    }
    const mini = getEditorMiniPreview();
    if (!mini) {
        return;
    }
    patchMiniPreview(mini);
    clearMiniPreviewNodes(mini);
}
function encodeToDataUrl(pixels, width, height, quality) {
    const canvas = ensureEncodeCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
        return '';
    }
    if (!encodeImageData || encodeImageData.width !== width || encodeImageData.height !== height) {
        encodeImageData = context.createImageData(width, height);
    }
    const imageData = encodeImageData;
    const rowBytes = width * 4;
    const dst = imageData.data;
    for (let row = 0; row < height; row++) {
        const start = (height - row - 1) * rowBytes;
        dst.set(pixels.subarray(start, start + rowBytes), row * rowBytes);
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/jpeg', quality);
}
function pixelsUnchanged(pixels) {
    if (!lastFramePixels || lastFramePixels.length !== pixels.length) {
        return false;
    }
    const prev = lastFramePixels;
    // 8MB 量级逐字节比较远比 JPEG 编码便宜
    for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] !== prev[i]) {
            return false;
        }
    }
    return true;
}
function rememberFramePixels(pixels) {
    if (!lastFramePixels || lastFramePixels.length !== pixels.length) {
        lastFramePixels = new Uint8Array(pixels.length);
    }
    lastFramePixels.set(pixels);
}
function maybeHealGameCameras() {
    const now = Date.now();
    if (now < healThrottleUntil) {
        return;
    }
    healThrottleUntil = now + 2000;
    healGameCameraWindows();
}
function clearSession() {
    setPreviewCamerasEnabled(false);
    destroyPreviewCameras();
    destroyRenderTexture();
    pixelBuffer = null;
    lastFramePixels = null;
    encodeImageData = null;
}
exports.methods = {
    queryCameras() {
        return getSceneCameras().map((camera) => ({
            uuid: camera.node.uuid,
            name: camera.node.name,
            path: getNodePath(camera.node),
            priority: camera.priority,
            enabled: camera.enabledInHierarchy,
        }));
    },
    /**
     * @zh 游戏预览开关时调用：开启则拦截 MiniPreview 创建小窗；关闭则恢复。
     */
    setMiniPreviewSuppressed(suppressed) {
        setEditorMiniPreviewSuppressed(!!suppressed);
    },
    /** 确保压制仍生效并清掉已弹出的小窗（选中 Camera 后的兜底）。 */
    hideEditorMiniPreview() {
        hideEditorMiniPreview();
    },
    /**
     * @zh 常驻代理相机 + 单次 repaint 读回。帧间禁用代理相机，避免拖拽场景时每帧多画一路。
     */
    async capture(options) {
        if (!isRendererReady()) {
            return null;
        }
        maybeHealGameCameras();
        const width = Math.max(1, Math.round(options.width));
        const height = Math.max(1, Math.round(options.height));
        const targets = resolveTargets(options);
        if (targets.length === 0) {
            clearSession();
            return null;
        }
        const texture = ensureRenderTexture(width, height);
        if (!texture.window) {
            return null;
        }
        const cameraCount = ensurePreviewCameras(targets, texture);
        if (cameraCount === 0) {
            return null;
        }
        setPreviewCamerasEnabled(true);
        try {
            await new Promise((resolve) => {
                cc_1.director.once(cc_1.Director.EVENT_AFTER_DRAW, resolve);
                requestRepaint();
            });
            const pixels = ensurePixelBuffer(width * height * 4);
            texture.readPixels(0, 0, width, height, pixels);
            // 场景静止时跳过 JPEG + 大字符串 IPC（CPU 大头），GPU 读回仍保留以保证内容变更能检出
            if (pixelsUnchanged(pixels)) {
                return {
                    unchanged: true,
                    width,
                    height,
                    cameraCount,
                };
            }
            rememberFramePixels(pixels);
            return {
                dataUrl: encodeToDataUrl(pixels, width, height, options.quality),
                width,
                height,
                cameraCount,
            };
        }
        finally {
            // 帧间关掉代理相机，不销毁；不再二次 repaint，避免拖死场景编辑器
            setPreviewCamerasEnabled(false);
        }
    },
    stop() {
        clearSession();
        healGameCameraWindows();
        requestRepaint();
    },
};
function load() {
    healGameCameraWindows();
}
function unload() {
    setEditorMiniPreviewSuppressed(false);
    clearSession();
    healGameCameraWindows();
    encodeCanvas = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBNGhCQSxvQkFFQztBQUVELHdCQUtDO0FBcmlCRCx5QkFBdUI7QUFDdkIsMkJBQWlHO0FBR2pHLElBQUksYUFBYSxHQUF5QixJQUFJLENBQUM7QUFDL0MsSUFBSSxZQUFZLEdBQTZCLElBQUksQ0FBQztBQUNsRCxJQUFJLGVBQWUsR0FBcUIsSUFBSSxDQUFDO0FBQzdDLElBQUksV0FBVyxHQUFzQixJQUFJLENBQUM7QUFDMUMsc0NBQXNDO0FBQ3RDLElBQUksZUFBZSxHQUFzQixJQUFJLENBQUM7QUFDOUMsMkNBQTJDO0FBQzNDLElBQUksWUFBWSxHQUFXLEVBQUUsQ0FBQztBQUM5QiwrQ0FBK0M7QUFDL0MsSUFBSSxrQkFBa0IsR0FBYSxFQUFFLENBQUM7QUFDdEMsSUFBSSxpQkFBaUIsR0FBRyxDQUFDLENBQUM7QUFFMUIsTUFBTSx3QkFBd0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLHlCQUF5QixFQUFFLG9CQUFvQixDQUFDLENBQUMsQ0FBQztBQUM1RixNQUFNLGlCQUFpQixHQUFHLHdCQUF3QixDQUFDO0FBRW5ELFNBQVMsZUFBZTtJQUNwQixNQUFNLElBQUksR0FBRyxhQUFRLENBQUMsSUFBSSxDQUFDO0lBQzNCLE9BQU8sQ0FBQyxDQUFDLENBQUEsSUFBSSxhQUFKLElBQUksdUJBQUosSUFBSSxDQUFFLFVBQVUsQ0FBQSxJQUFJLENBQUMsQ0FBQyxJQUFJLENBQUMsUUFBUSxJQUFJLElBQUksQ0FBQyxNQUFNLENBQUMsZUFBZSxLQUFLLFFBQUcsQ0FBQyxNQUFNLENBQUMsT0FBTyxDQUFDO0FBQ3ZHLENBQUM7QUFFRCxTQUFTLGFBQWE7O0lBQ2xCLE9BQU8sTUFBQSxNQUFDLGFBQVEsQ0FBQyxJQUFZLDBDQUFFLFVBQVUsbUNBQUksSUFBSSxDQUFDO0FBQ3RELENBQUM7QUFFRDs7O0dBR0c7QUFD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QUN0QyxZQUFZLEVBQUUsQ0FBQztJQUNmLHFCQUFxQixFQUFFLENBQUM7SUFDeEIsWUFBWSxHQUFHLElBQUksQ0FBQztBQUN4QixDQUFDIiwic291cmNlc0NvbnRlbnQiOlsiaW1wb3J0ICcuL2VuZ2luZS1wYXRoJztcclxuaW1wb3J0IHsgQ0NPYmplY3QsIENhbWVyYSwgQ29sb3IsIERpcmVjdG9yLCBOb2RlLCBSZWN0LCBSZW5kZXJUZXh0dXJlLCBkaXJlY3RvciwgZ2Z4IH0gZnJvbSAnY2MnO1xyXG5pbXBvcnQgdHlwZSB7IElDYW1lcmFJbmZvLCBJQ2FwdHVyZU9wdGlvbnMsIElDYXB0dXJlUmVzdWx0IH0gZnJvbSAnLi90eXBlcyc7XHJcblxyXG5sZXQgcmVuZGVyVGV4dHVyZTogUmVuZGVyVGV4dHVyZSB8IG51bGwgPSBudWxsO1xyXG5sZXQgZW5jb2RlQ2FudmFzOiBIVE1MQ2FudmFzRWxlbWVudCB8IG51bGwgPSBudWxsO1xyXG5sZXQgZW5jb2RlSW1hZ2VEYXRhOiBJbWFnZURhdGEgfCBudWxsID0gbnVsbDtcclxubGV0IHBpeGVsQnVmZmVyOiBVaW50OEFycmF5IHwgbnVsbCA9IG51bGw7XHJcbi8qKiDkuIrkuIDluKflg4/ntKDlia/mnKzvvIznlKjkuo7ot7Pov4fml6Dlj5jljJbml7bnmoQgSlBFRyDnvJbnoIHkuI4gSVBD44CCICovXHJcbmxldCBsYXN0RnJhbWVQaXhlbHM6IFVpbnQ4QXJyYXkgfCBudWxsID0gbnVsbDtcclxuLyoqIOS7heeUqOS6jumihOiniOeahOS4tOaXtuebuOacuuiKgueCue+8jOe7neS4jeaUueWKqOWcuuaZr+mHjOWOn+aciSBDYW1lcmEg55qE5riy5p+T55uu5qCH44CCICovXHJcbmxldCBwcmV2aWV3Tm9kZXM6IE5vZGVbXSA9IFtdO1xyXG4vKiog5LiOIHByZXZpZXdOb2RlcyDkuIDkuIDlr7nlupTnmoTmupDnm7jmnLogdXVpZO+8jOeUqOS6juWIpOaWreaYr+WQpumcgOimgemHjeW7uuOAgiAqL1xyXG5sZXQgcHJldmlld1NvdXJjZVV1aWRzOiBzdHJpbmdbXSA9IFtdO1xyXG5sZXQgaGVhbFRocm90dGxlVW50aWwgPSAwO1xyXG5cclxuY29uc3QgRURJVE9SX0NBTUVSQV9OT0RFX05BTUVTID0gbmV3IFNldChbJ0VkaXRvciBTY2VuZSBCYWNrZ3JvdW5kJywgJ1NjZW5lIEdpem1vIENhbWVyYSddKTtcclxuY29uc3QgUFJFVklFV19OT0RFX05BTUUgPSAnX19DYW1lcmFQcmV2aWV3UHJveHlfXyc7XHJcblxyXG5mdW5jdGlvbiBpc1JlbmRlcmVyUmVhZHkoKTogYm9vbGVhbiB7XHJcbiAgICBjb25zdCByb290ID0gZGlyZWN0b3Iucm9vdDtcclxuICAgIHJldHVybiAhIXJvb3Q/Lm1haW5XaW5kb3cgJiYgISFyb290LnBpcGVsaW5lICYmIHJvb3QuZGV2aWNlLnN3YXBjaGFpbkZvcm1hdCAhPT0gZ2Z4LkZvcm1hdC5VTktOT1dOO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRUZW1wV2luZG93KCk6IGFueSB8IG51bGwge1xyXG4gICAgcmV0dXJuIChkaXJlY3Rvci5yb290IGFzIGFueSk/LnRlbXBXaW5kb3cgPz8gbnVsbDtcclxufVxyXG5cclxuLyoqXHJcbiAqIEB6aCDnvJbovpHmnJ/muLjmiI/nm7jmnLrkvJrmjILlnKggcm9vdC50ZW1wV2luZG93IOS4iuOAglxyXG4gKiDml6fniYjmnKzmj5Lku7boi6Xmiornm7jmnLrmkZjmiJAgd2luZG93PW51bGzvvIzov5nph4zlsL3ph4/ooaXlm57vvIzpgb/lhY3nvJbovpHlmajnm7jmnLrlsI/nqpfmjIHnu63miqXplJnjgIJcclxuICovXHJcbmZ1bmN0aW9uIGhlYWxHYW1lQ2FtZXJhV2luZG93cygpOiB2b2lkIHtcclxuICAgIGNvbnN0IHRlbXBXaW5kb3cgPSBnZXRUZW1wV2luZG93KCk7XHJcbiAgICBpZiAoIXRlbXBXaW5kb3cpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICBmb3IgKGNvbnN0IGNvbXBvbmVudCBvZiBnZXRTY2VuZUNhbWVyYXMoKSkge1xyXG4gICAgICAgIGlmIChjb21wb25lbnQudGFyZ2V0VGV4dHVyZSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgY2FtZXJhID0gY29tcG9uZW50LmNhbWVyYTtcclxuICAgICAgICBpZiAoIWNhbWVyYSkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgaWYgKCFjYW1lcmEud2luZG93KSB7XHJcbiAgICAgICAgICAgICAgICBjYW1lcmEuY2hhbmdlVGFyZ2V0V2luZG93KHRlbXBXaW5kb3cpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIC8vIOW/veeVpeS4quWIq+W3sumUgOavgeebuOaculxyXG4gICAgICAgIH1cclxuICAgIH1cclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0U2NlbmVDYW1lcmFzKCk6IENhbWVyYVtdIHtcclxuICAgIGNvbnN0IHNjZW5lID0gZGlyZWN0b3IuZ2V0U2NlbmUoKTtcclxuICAgIGlmICghc2NlbmUpIHtcclxuICAgICAgICByZXR1cm4gW107XHJcbiAgICB9XHJcbiAgICByZXR1cm4gc2NlbmVcclxuICAgICAgICAuZ2V0Q29tcG9uZW50c0luQ2hpbGRyZW4oQ2FtZXJhKVxyXG4gICAgICAgIC5maWx0ZXIoKGNhbWVyYSkgPT4ge1xyXG4gICAgICAgICAgICBpZiAoRURJVE9SX0NBTUVSQV9OT0RFX05BTUVTLmhhcyhjYW1lcmEubm9kZS5uYW1lKSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIGlmIChjYW1lcmEubm9kZS5uYW1lID09PSBQUkVWSUVXX05PREVfTkFNRSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgICAgIHJldHVybiB0cnVlO1xyXG4gICAgICAgIH0pO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXROb2RlUGF0aChub2RlOiBOb2RlKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgbGV0IGN1cnJlbnQ6IE5vZGUgfCBudWxsID0gbm9kZTtcclxuICAgIHdoaWxlIChjdXJyZW50ICYmIGN1cnJlbnQucGFyZW50KSB7XHJcbiAgICAgICAgbmFtZXMudW5zaGlmdChjdXJyZW50Lm5hbWUpO1xyXG4gICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBuYW1lcy5qb2luKCcvJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldFByZXZpZXdDYW1lcmFzRW5hYmxlZChlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcHJldmlld05vZGVzKSB7XHJcbiAgICAgICAgaWYgKCFub2RlLmlzVmFsaWQpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNhbWVyYSA9IG5vZGUuZ2V0Q29tcG9uZW50KENhbWVyYSk7XHJcbiAgICAgICAgaWYgKGNhbWVyYSkge1xyXG4gICAgICAgICAgICBjYW1lcmEuZW5hYmxlZCA9IGVuYWJsZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBkZXN0cm95UHJldmlld0NhbWVyYXMoKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcHJldmlld05vZGVzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgaWYgKG5vZGUuaXNWYWxpZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2FtZXJhID0gbm9kZS5nZXRDb21wb25lbnQoQ2FtZXJhKTtcclxuICAgICAgICAgICAgICAgIGlmIChjYW1lcmEpIHtcclxuICAgICAgICAgICAgICAgICAgICBjYW1lcmEudGFyZ2V0VGV4dHVyZSA9IG51bGw7XHJcbiAgICAgICAgICAgICAgICB9XHJcbiAgICAgICAgICAgICAgICBub2RlLmRlc3Ryb3koKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyDlnLrmma/liIfmjaLml7boioLngrnlj6/og73lt7LlpLHmlYhcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICBwcmV2aWV3Tm9kZXMgPSBbXTtcclxuICAgIHByZXZpZXdTb3VyY2VVdWlkcyA9IFtdO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVSZW5kZXJUZXh0dXJlKHdpZHRoOiBudW1iZXIsIGhlaWdodDogbnVtYmVyKTogUmVuZGVyVGV4dHVyZSB7XHJcbiAgICBpZiAoIXJlbmRlclRleHR1cmUpIHtcclxuICAgICAgICBjb25zdCB0ZXh0dXJlID0gbmV3IFJlbmRlclRleHR1cmUoKTtcclxuICAgICAgICB0ZXh0dXJlLnJlc2V0KHsgd2lkdGgsIGhlaWdodCB9KTtcclxuICAgICAgICByZW5kZXJUZXh0dXJlID0gdGV4dHVyZTtcclxuICAgIH0gZWxzZSBpZiAocmVuZGVyVGV4dHVyZS53aWR0aCAhPT0gd2lkdGggfHwgcmVuZGVyVGV4dHVyZS5oZWlnaHQgIT09IGhlaWdodCkge1xyXG4gICAgICAgIGRlc3Ryb3lQcmV2aWV3Q2FtZXJhcygpO1xyXG4gICAgICAgIHJlbmRlclRleHR1cmUucmVzaXplKHdpZHRoLCBoZWlnaHQpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHJlbmRlclRleHR1cmU7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGRlc3Ryb3lSZW5kZXJUZXh0dXJlKCk6IHZvaWQge1xyXG4gICAgZGVzdHJveVByZXZpZXdDYW1lcmFzKCk7XHJcbiAgICBpZiAoIXJlbmRlclRleHR1cmUpIHtcclxuICAgICAgICByZXR1cm47XHJcbiAgICB9XHJcbiAgICByZW5kZXJUZXh0dXJlLmRlc3Ryb3koKTtcclxuICAgIHJlbmRlclRleHR1cmUgPSBudWxsO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVFbmNvZGVDYW52YXMod2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiBIVE1MQ2FudmFzRWxlbWVudCB7XHJcbiAgICBpZiAoIWVuY29kZUNhbnZhcykge1xyXG4gICAgICAgIGVuY29kZUNhbnZhcyA9IGRvY3VtZW50LmNyZWF0ZUVsZW1lbnQoJ2NhbnZhcycpO1xyXG4gICAgfVxyXG4gICAgaWYgKGVuY29kZUNhbnZhcy53aWR0aCAhPT0gd2lkdGggfHwgZW5jb2RlQ2FudmFzLmhlaWdodCAhPT0gaGVpZ2h0KSB7XHJcbiAgICAgICAgZW5jb2RlQ2FudmFzLndpZHRoID0gd2lkdGg7XHJcbiAgICAgICAgZW5jb2RlQ2FudmFzLmhlaWdodCA9IGhlaWdodDtcclxuICAgICAgICBlbmNvZGVJbWFnZURhdGEgPSBudWxsO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGVuY29kZUNhbnZhcztcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlUGl4ZWxCdWZmZXIoc2l6ZTogbnVtYmVyKTogVWludDhBcnJheSB7XHJcbiAgICBpZiAoIXBpeGVsQnVmZmVyIHx8IHBpeGVsQnVmZmVyLmxlbmd0aCAhPT0gc2l6ZSkge1xyXG4gICAgICAgIHBpeGVsQnVmZmVyID0gbmV3IFVpbnQ4QXJyYXkoc2l6ZSk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcGl4ZWxCdWZmZXI7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNvcHlDYW1lcmFTZXR0aW5ncyhzb3VyY2U6IENhbWVyYSwgdGFyZ2V0OiBDYW1lcmEpOiB2b2lkIHtcclxuICAgIHRhcmdldC5wcmlvcml0eSA9IHNvdXJjZS5wcmlvcml0eTtcclxuICAgIHRhcmdldC52aXNpYmlsaXR5ID0gc291cmNlLnZpc2liaWxpdHk7XHJcbiAgICB0YXJnZXQuY2xlYXJGbGFncyA9IHNvdXJjZS5jbGVhckZsYWdzO1xyXG4gICAgdGFyZ2V0LmNsZWFyQ29sb3IgPSBuZXcgQ29sb3Ioc291cmNlLmNsZWFyQ29sb3Iuciwgc291cmNlLmNsZWFyQ29sb3IuZywgc291cmNlLmNsZWFyQ29sb3IuYiwgc291cmNlLmNsZWFyQ29sb3IuYSk7XHJcbiAgICB0YXJnZXQuY2xlYXJEZXB0aCA9IHNvdXJjZS5jbGVhckRlcHRoO1xyXG4gICAgdGFyZ2V0LmNsZWFyU3RlbmNpbCA9IHNvdXJjZS5jbGVhclN0ZW5jaWw7XHJcbiAgICB0YXJnZXQucHJvamVjdGlvbiA9IHNvdXJjZS5wcm9qZWN0aW9uO1xyXG4gICAgdGFyZ2V0LmZvdkF4aXMgPSBzb3VyY2UuZm92QXhpcztcclxuICAgIHRhcmdldC5mb3YgPSBzb3VyY2UuZm92O1xyXG4gICAgdGFyZ2V0Lm9ydGhvSGVpZ2h0ID0gc291cmNlLm9ydGhvSGVpZ2h0O1xyXG4gICAgdGFyZ2V0Lm5lYXIgPSBzb3VyY2UubmVhcjtcclxuICAgIHRhcmdldC5mYXIgPSBzb3VyY2UuZmFyO1xyXG4gICAgdGFyZ2V0LmFwZXJ0dXJlID0gc291cmNlLmFwZXJ0dXJlO1xyXG4gICAgdGFyZ2V0LnNodXR0ZXIgPSBzb3VyY2Uuc2h1dHRlcjtcclxuICAgIHRhcmdldC5pc28gPSBzb3VyY2UuaXNvO1xyXG4gICAgY29uc3QgcmVjdCA9IHNvdXJjZS5yZWN0O1xyXG4gICAgdGFyZ2V0LnJlY3QgPSBuZXcgUmVjdChyZWN0LngsIHJlY3QueSwgcmVjdC53aWR0aCwgcmVjdC5oZWlnaHQpO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzeW5jUHJveHlOb2RlKHNvdXJjZTogQ2FtZXJhLCBub2RlOiBOb2RlKTogdm9pZCB7XHJcbiAgICBub2RlLmxheWVyID0gc291cmNlLm5vZGUubGF5ZXI7XHJcbiAgICBub2RlLnNldFdvcmxkUG9zaXRpb24oc291cmNlLm5vZGUud29ybGRQb3NpdGlvbik7XHJcbiAgICBub2RlLnNldFdvcmxkUm90YXRpb24oc291cmNlLm5vZGUud29ybGRSb3RhdGlvbik7XHJcbiAgICBub2RlLnNldFdvcmxkU2NhbGUoc291cmNlLm5vZGUud29ybGRTY2FsZSk7XHJcbiAgICBjb25zdCBjYW1lcmEgPSBub2RlLmdldENvbXBvbmVudChDYW1lcmEpO1xyXG4gICAgaWYgKGNhbWVyYSkge1xyXG4gICAgICAgIGNvcHlDYW1lcmFTZXR0aW5ncyhzb3VyY2UsIGNhbWVyYSk7XHJcbiAgICAgICAgY2FtZXJhLnRhcmdldFRleHR1cmUgPSByZW5kZXJUZXh0dXJlO1xyXG4gICAgfVxyXG59XHJcblxyXG4vKipcclxuICogQHpoIOWIm+W7uuS4jua6kOebuOacuuWQjOWnv+aAgS/lkIzlj4LmlbDnmoTkuLTml7YgQ2FtZXJh77yM5Y+q5oqK5a6D5Lus55qEIHRhcmdldFRleHR1cmUg5oyH5Yiw6aKE6KeI6LS05Zu+44CCXHJcbiAqIOi/meagt+WujOWFqOS4jeiwg+eUqOWcuuaZr+ebuOacuueahCBjaGFuZ2VUYXJnZXRXaW5kb3fvvIznvJbovpHlmajnm7jmnLrlsI/nqpfkuI3kvJrooqvmiqLotbDjgIJcclxuICovXHJcbmZ1bmN0aW9uIGNyZWF0ZVByZXZpZXdDYW1lcmFzKHNvdXJjZXM6IENhbWVyYVtdLCB0ZXh0dXJlOiBSZW5kZXJUZXh0dXJlKTogbnVtYmVyIHtcclxuICAgIGRlc3Ryb3lQcmV2aWV3Q2FtZXJhcygpO1xyXG4gICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgaWYgKCFzY2VuZSkge1xyXG4gICAgICAgIHJldHVybiAwO1xyXG4gICAgfVxyXG5cclxuICAgIGZvciAoY29uc3Qgc291cmNlIG9mIHNvdXJjZXMpIHtcclxuICAgICAgICBpZiAoIXNvdXJjZS5pc1ZhbGlkIHx8ICFzb3VyY2Uubm9kZT8uaXNWYWxpZCkge1xyXG4gICAgICAgICAgICBjb250aW51ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3Qgbm9kZSA9IG5ldyBOb2RlKFBSRVZJRVdfTk9ERV9OQU1FKTtcclxuICAgICAgICBub2RlLmhpZGVGbGFncyB8PSBDQ09iamVjdC5GbGFncy5Eb250U2F2ZSB8IENDT2JqZWN0LkZsYWdzLkhpZGVJbkhpZXJhcmNoeTtcclxuICAgICAgICBub2RlLmxheWVyID0gc291cmNlLm5vZGUubGF5ZXI7XHJcbiAgICAgICAgc2NlbmUuYWRkQ2hpbGQobm9kZSk7XHJcbiAgICAgICAgbm9kZS5zZXRXb3JsZFBvc2l0aW9uKHNvdXJjZS5ub2RlLndvcmxkUG9zaXRpb24pO1xyXG4gICAgICAgIG5vZGUuc2V0V29ybGRSb3RhdGlvbihzb3VyY2Uubm9kZS53b3JsZFJvdGF0aW9uKTtcclxuICAgICAgICBub2RlLnNldFdvcmxkU2NhbGUoc291cmNlLm5vZGUud29ybGRTY2FsZSk7XHJcblxyXG4gICAgICAgIGNvbnN0IGNhbWVyYSA9IG5vZGUuYWRkQ29tcG9uZW50KENhbWVyYSk7XHJcbiAgICAgICAgY29weUNhbWVyYVNldHRpbmdzKHNvdXJjZSwgY2FtZXJhKTtcclxuICAgICAgICBjYW1lcmEudGFyZ2V0VGV4dHVyZSA9IHRleHR1cmU7XHJcbiAgICAgICAgY2FtZXJhLmVuYWJsZWQgPSBmYWxzZTtcclxuICAgICAgICBwcmV2aWV3Tm9kZXMucHVzaChub2RlKTtcclxuICAgICAgICBwcmV2aWV3U291cmNlVXVpZHMucHVzaChzb3VyY2Uubm9kZS51dWlkKTtcclxuICAgIH1cclxuICAgIHJldHVybiBwcmV2aWV3Tm9kZXMubGVuZ3RoO1xyXG59XHJcblxyXG5mdW5jdGlvbiBzb3VyY2VMaXN0TWF0Y2hlcyhzb3VyY2VzOiBDYW1lcmFbXSk6IGJvb2xlYW4ge1xyXG4gICAgaWYgKHNvdXJjZXMubGVuZ3RoICE9PSBwcmV2aWV3U291cmNlVXVpZHMubGVuZ3RoIHx8IHNvdXJjZXMubGVuZ3RoICE9PSBwcmV2aWV3Tm9kZXMubGVuZ3RoKSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzb3VyY2VzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgaWYgKCFzb3VyY2VzW2ldLmlzVmFsaWQgfHwgc291cmNlc1tpXS5ub2RlLnV1aWQgIT09IHByZXZpZXdTb3VyY2VVdWlkc1tpXSkge1xyXG4gICAgICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGlmICghcHJldmlld05vZGVzW2ldPy5pc1ZhbGlkKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5zdXJlUHJldmlld0NhbWVyYXMoc291cmNlczogQ2FtZXJhW10sIHRleHR1cmU6IFJlbmRlclRleHR1cmUpOiBudW1iZXIge1xyXG4gICAgaWYgKHNvdXJjZUxpc3RNYXRjaGVzKHNvdXJjZXMpKSB7XHJcbiAgICAgICAgZm9yIChsZXQgaSA9IDA7IGkgPCBzb3VyY2VzLmxlbmd0aDsgaSsrKSB7XHJcbiAgICAgICAgICAgIHN5bmNQcm94eU5vZGUoc291cmNlc1tpXSwgcHJldmlld05vZGVzW2ldKTtcclxuICAgICAgICB9XHJcbiAgICAgICAgcmV0dXJuIHByZXZpZXdOb2Rlcy5sZW5ndGg7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY3JlYXRlUHJldmlld0NhbWVyYXMoc291cmNlcywgdGV4dHVyZSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHJlc29sdmVUYXJnZXRzKG9wdGlvbnM6IElDYXB0dXJlT3B0aW9ucyk6IENhbWVyYVtdIHtcclxuICAgIGNvbnN0IGNhbWVyYXMgPSBnZXRTY2VuZUNhbWVyYXMoKTtcclxuICAgIGlmIChvcHRpb25zLm1vZGUgPT09ICdzaW5nbGUnKSB7XHJcbiAgICAgICAgY29uc3QgdGFyZ2V0ID0gY2FtZXJhcy5maW5kKChjYW1lcmEpID0+IGNhbWVyYS5ub2RlLnV1aWQgPT09IG9wdGlvbnMuY2FtZXJhVXVpZCk7XHJcbiAgICAgICAgcmV0dXJuIHRhcmdldCA/IFt0YXJnZXRdIDogW107XHJcbiAgICB9XHJcbiAgICByZXR1cm4gY2FtZXJhc1xyXG4gICAgICAgIC5maWx0ZXIoKGNhbWVyYSkgPT4gY2FtZXJhLmVuYWJsZWRJbkhpZXJhcmNoeSAmJiAhY2FtZXJhLnRhcmdldFRleHR1cmUpXHJcbiAgICAgICAgLnNvcnQoKGEsIGIpID0+IGEucHJpb3JpdHkgLSBiLnByaW9yaXR5KTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVxdWVzdFJlcGFpbnQoKTogdm9pZCB7XHJcbiAgICBjb25zdCBlZGl0b3JTY2VuZSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgZWRpdG9yU2NlbmU/LkVuZ2luZT8ucmVwYWludEluRWRpdE1vZGU/LigpO1xyXG59XHJcblxyXG5jb25zdCBNSU5JX1BSRVZJRVdfUEFUQ0hfS0VZID0gJ19fZ2FtZVByZXZpZXdNaW5pUGF0Y2hfXyc7XHJcblxyXG4vKiog5ri45oiP6aKE6KeI5byA5ZCv5pyf6Ze05Y6L5Yi257yW6L6R5ZmoIE1pbmlQcmV2aWV377yM6YG/5YWN6YCJ5LitIENhbWVyYSDml7bmiqLmuLLmn5Mv5omT5patIGNhcHR1cmXjgIIgKi9cclxubGV0IG1pbmlQcmV2aWV3U3VwcHJlc3NlZCA9IGZhbHNlO1xyXG4vKiog5Y6L5Yi25pyf6Ze06K6w5b2V6YCJ5Lit55qE6IqC54K577yM5YWz6Zet5ri45oiP6aKE6KeI5ZCO55So5LqO5oGi5aSN5bCP56qX44CCICovXHJcbmxldCBzdXBwcmVzc2VkU2VsZWN0VXVpZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKipcclxuICogQHpoIOaLv+WIsOe8lui+keWZqOWGhee9rueahOebuOacuuWwj+eql++8iE1pbmlQcmV2aWV377yJ566h55CG5Zmo44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRFZGl0b3JNaW5pUHJldmlldygpOiBhbnkgfCBudWxsIHtcclxuICAgIGNvbnN0IGNjZSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgaWYgKCFjY2UpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyb21GYWNhZGUgPSBjY2UuU2NlbmVGYWNhZGVNYW5hZ2VyPy5nZXRDdXJyZW50RmFjYWRlPy4oKT8uX21pbmlQcmV2aWV3TWdyO1xyXG4gICAgaWYgKGZyb21GYWNhZGUpIHtcclxuICAgICAgICByZXR1cm4gZnJvbUZhY2FkZTtcclxuICAgIH1cclxuICAgIHJldHVybiBjY2UuUHJldmlldz8ubWluaVByZXZpZXcgfHwgY2NlLnByZXZpZXdNZ3I/Lm1pbmlQcmV2aWV3IHx8IG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg5riF5o6JIE1pbmlQcmV2aWV3IOW3suWIm+W7uueahOmihOiniOiKgueCue+8jOS4jeiwg+eUqCBoYW5kbGVVbnNlbGVjdO+8iOmBv+WFjeivr+S8pOWxgue6p+mAieS4re+8ieOAglxyXG4gKi9cclxuZnVuY3Rpb24gY2xlYXJNaW5pUHJldmlld05vZGVzKG1pbmk6IGFueSk6IHZvaWQge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBjdXJyID0gbWluaS5jdXJyTm9kZTtcclxuICAgICAgICBpZiAoY3Vycj8udXVpZCkge1xyXG4gICAgICAgICAgICBzdXBwcmVzc2VkU2VsZWN0VXVpZCA9IGN1cnIudXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBpZ25vcmVcclxuICAgIH1cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZXMgPSBtaW5pLnByZXZpZXdOb2RlcztcclxuICAgICAgICBpZiAoIW5vZGVzKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgdmFsdWVzOiBhbnlbXSA9IG5vZGVzIGluc3RhbmNlb2YgTWFwXHJcbiAgICAgICAgICAgID8gQXJyYXkuZnJvbShub2Rlcy52YWx1ZXMoKSlcclxuICAgICAgICAgICAgOiBBcnJheS5pc0FycmF5KG5vZGVzKVxyXG4gICAgICAgICAgICAgICAgPyBbLi4ubm9kZXNdXHJcbiAgICAgICAgICAgICAgICA6IE9iamVjdC52YWx1ZXMobm9kZXMpO1xyXG4gICAgICAgIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNhbWVyYSA9IHZhbHVlPy5jYW1lcmFDb21wb25lbnQgfHwgdmFsdWU/LmNhbWVyYSB8fCB2YWx1ZTtcclxuICAgICAgICAgICAgaWYgKGNhbWVyYSAmJiB0eXBlb2YgbWluaS5yZW1vdmVQcmV2aWV3Tm9kZSA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgICAgICAgICAgbWluaS5yZW1vdmVQcmV2aWV3Tm9kZShjYW1lcmEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLy8gaWdub3JlXHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhdGNoTWluaVByZXZpZXcobWluaTogYW55KTogdm9pZCB7XHJcbiAgICBpZiAobWluaVtNSU5JX1BSRVZJRVdfUEFUQ0hfS0VZXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG9yaWdpbmFsSGFuZGxlU2VsZWN0ID0gdHlwZW9mIG1pbmkuaGFuZGxlU2VsZWN0ID09PSAnZnVuY3Rpb24nXHJcbiAgICAgICAgPyBtaW5pLmhhbmRsZVNlbGVjdC5iaW5kKG1pbmkpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3Qgb3JpZ2luYWxDcmVhdGVQcmV2aWV3Tm9kZSA9IHR5cGVvZiBtaW5pLmNyZWF0ZVByZXZpZXdOb2RlID09PSAnZnVuY3Rpb24nXHJcbiAgICAgICAgPyBtaW5pLmNyZWF0ZVByZXZpZXdOb2RlLmJpbmQobWluaSlcclxuICAgICAgICA6IG51bGw7XHJcbiAgICBtaW5pW01JTklfUFJFVklFV19QQVRDSF9LRVldID0ge1xyXG4gICAgICAgIGhhbmRsZVNlbGVjdDogb3JpZ2luYWxIYW5kbGVTZWxlY3QsXHJcbiAgICAgICAgY3JlYXRlUHJldmlld05vZGU6IG9yaWdpbmFsQ3JlYXRlUHJldmlld05vZGUsXHJcbiAgICB9O1xyXG4gICAgbWluaS5oYW5kbGVTZWxlY3QgPSAodXVpZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgc3VwcHJlc3NlZFNlbGVjdFV1aWQgPSB1dWlkO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBtaW5pLmNyZWF0ZVByZXZpZXdOb2RlID0gKCkgPT4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gdW5wYXRjaE1pbmlQcmV2aWV3KG1pbmk6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3Qgb3JpZ2luYWwgPSBtaW5pW01JTklfUFJFVklFV19QQVRDSF9LRVldO1xyXG4gICAgaWYgKCFvcmlnaW5hbCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChvcmlnaW5hbC5oYW5kbGVTZWxlY3QpIHtcclxuICAgICAgICBtaW5pLmhhbmRsZVNlbGVjdCA9IG9yaWdpbmFsLmhhbmRsZVNlbGVjdDtcclxuICAgIH1cclxuICAgIGlmIChvcmlnaW5hbC5jcmVhdGVQcmV2aWV3Tm9kZSkge1xyXG4gICAgICAgIG1pbmkuY3JlYXRlUHJldmlld05vZGUgPSBvcmlnaW5hbC5jcmVhdGVQcmV2aWV3Tm9kZTtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBtaW5pW01JTklfUFJFVklFV19QQVRDSF9LRVldO1xyXG59XHJcblxyXG4vKipcclxuICogQHpoIOa4uOaIj+mihOiniOW8gOWQr+aXtuWOi+WItue8lui+keWZqOebuOacuuWwj+eql++8m+WFs+mXreWQjuaBouWkjeW5tueUsee8lui+keWZqOaMieW9k+WJjemAieS4remHjeaWsOW8ueWHuuOAglxyXG4gKi9cclxuZnVuY3Rpb24gc2V0RWRpdG9yTWluaVByZXZpZXdTdXBwcmVzc2VkKHN1cHByZXNzZWQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIG1pbmlQcmV2aWV3U3VwcHJlc3NlZCA9IHN1cHByZXNzZWQ7XHJcbiAgICBjb25zdCBtaW5pID0gZ2V0RWRpdG9yTWluaVByZXZpZXcoKTtcclxuICAgIGlmICghbWluaSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChzdXBwcmVzc2VkKSB7XHJcbiAgICAgICAgcGF0Y2hNaW5pUHJldmlldyhtaW5pKTtcclxuICAgICAgICBjbGVhck1pbmlQcmV2aWV3Tm9kZXMobWluaSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgdW5wYXRjaE1pbmlQcmV2aWV3KG1pbmkpO1xyXG4gICAgY29uc3QgdXVpZCA9IHN1cHByZXNzZWRTZWxlY3RVdWlkIHx8IG1pbmkuY3Vyck5vZGU/LnV1aWQgfHwgbnVsbDtcclxuICAgIHN1cHByZXNzZWRTZWxlY3RVdWlkID0gbnVsbDtcclxuICAgIGlmICh1dWlkICYmIHR5cGVvZiBtaW5pLmhhbmRsZVNlbGVjdCA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIG1pbmkuaGFuZGxlU2VsZWN0KHV1aWQpO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyBpZ25vcmVcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg56Gu5L+d5Y6L5Yi254q25oCB5LuN55Sf5pWI77yI5Zy65pmv6YeN6L295ZCO6Z2i5YW35a6e5L6L5Y+v6IO95o2i5paw77yJ77yM5bm25riF5o6J5bey5by55Ye655qE5bCP56qX44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBoaWRlRWRpdG9yTWluaVByZXZpZXcoKTogdm9pZCB7XHJcbiAgICBpZiAoIW1pbmlQcmV2aWV3U3VwcHJlc3NlZCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG1pbmkgPSBnZXRFZGl0b3JNaW5pUHJldmlldygpO1xyXG4gICAgaWYgKCFtaW5pKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcGF0Y2hNaW5pUHJldmlldyhtaW5pKTtcclxuICAgIGNsZWFyTWluaVByZXZpZXdOb2RlcyhtaW5pKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5jb2RlVG9EYXRhVXJsKHBpeGVsczogVWludDhBcnJheSwgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIsIHF1YWxpdHk6IG51bWJlcik6IHN0cmluZyB7XHJcbiAgICBjb25zdCBjYW52YXMgPSBlbnN1cmVFbmNvZGVDYW52YXMod2lkdGgsIGhlaWdodCk7XHJcbiAgICBjb25zdCBjb250ZXh0ID0gY2FudmFzLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICBpZiAoIWNvbnRleHQpIHtcclxuICAgICAgICByZXR1cm4gJyc7XHJcbiAgICB9XHJcbiAgICBpZiAoIWVuY29kZUltYWdlRGF0YSB8fCBlbmNvZGVJbWFnZURhdGEud2lkdGggIT09IHdpZHRoIHx8IGVuY29kZUltYWdlRGF0YS5oZWlnaHQgIT09IGhlaWdodCkge1xyXG4gICAgICAgIGVuY29kZUltYWdlRGF0YSA9IGNvbnRleHQuY3JlYXRlSW1hZ2VEYXRhKHdpZHRoLCBoZWlnaHQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1hZ2VEYXRhID0gZW5jb2RlSW1hZ2VEYXRhO1xyXG4gICAgY29uc3Qgcm93Qnl0ZXMgPSB3aWR0aCAqIDQ7XHJcbiAgICBjb25zdCBkc3QgPSBpbWFnZURhdGEuZGF0YTtcclxuICAgIGZvciAobGV0IHJvdyA9IDA7IHJvdyA8IGhlaWdodDsgcm93KyspIHtcclxuICAgICAgICBjb25zdCBzdGFydCA9IChoZWlnaHQgLSByb3cgLSAxKSAqIHJvd0J5dGVzO1xyXG4gICAgICAgIGRzdC5zZXQocGl4ZWxzLnN1YmFycmF5KHN0YXJ0LCBzdGFydCArIHJvd0J5dGVzKSwgcm93ICogcm93Qnl0ZXMpO1xyXG4gICAgfVxyXG4gICAgY29udGV4dC5wdXRJbWFnZURhdGEoaW1hZ2VEYXRhLCAwLCAwKTtcclxuICAgIHJldHVybiBjYW52YXMudG9EYXRhVVJMKCdpbWFnZS9qcGVnJywgcXVhbGl0eSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBpeGVsc1VuY2hhbmdlZChwaXhlbHM6IFVpbnQ4QXJyYXkpOiBib29sZWFuIHtcclxuICAgIGlmICghbGFzdEZyYW1lUGl4ZWxzIHx8IGxhc3RGcmFtZVBpeGVscy5sZW5ndGggIT09IHBpeGVscy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwcmV2ID0gbGFzdEZyYW1lUGl4ZWxzO1xyXG4gICAgLy8gOE1CIOmHj+e6p+mAkOWtl+iKguavlOi+g+i/nOavlCBKUEVHIOe8lueggeS+v+WunFxyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwaXhlbHMubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBpZiAocGl4ZWxzW2ldICE9PSBwcmV2W2ldKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtZW1iZXJGcmFtZVBpeGVscyhwaXhlbHM6IFVpbnQ4QXJyYXkpOiB2b2lkIHtcclxuICAgIGlmICghbGFzdEZyYW1lUGl4ZWxzIHx8IGxhc3RGcmFtZVBpeGVscy5sZW5ndGggIT09IHBpeGVscy5sZW5ndGgpIHtcclxuICAgICAgICBsYXN0RnJhbWVQaXhlbHMgPSBuZXcgVWludDhBcnJheShwaXhlbHMubGVuZ3RoKTtcclxuICAgIH1cclxuICAgIGxhc3RGcmFtZVBpeGVscy5zZXQocGl4ZWxzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF5YmVIZWFsR2FtZUNhbWVyYXMoKTogdm9pZCB7XHJcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xyXG4gICAgaWYgKG5vdyA8IGhlYWxUaHJvdHRsZVVudGlsKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaGVhbFRocm90dGxlVW50aWwgPSBub3cgKyAyMDAwO1xyXG4gICAgaGVhbEdhbWVDYW1lcmFXaW5kb3dzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsZWFyU2Vzc2lvbigpOiB2b2lkIHtcclxuICAgIHNldFByZXZpZXdDYW1lcmFzRW5hYmxlZChmYWxzZSk7XHJcbiAgICBkZXN0cm95UHJldmlld0NhbWVyYXMoKTtcclxuICAgIGRlc3Ryb3lSZW5kZXJUZXh0dXJlKCk7XHJcbiAgICBwaXhlbEJ1ZmZlciA9IG51bGw7XHJcbiAgICBsYXN0RnJhbWVQaXhlbHMgPSBudWxsO1xyXG4gICAgZW5jb2RlSW1hZ2VEYXRhID0gbnVsbDtcclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHMgPSB7XHJcbiAgICBxdWVyeUNhbWVyYXMoKTogSUNhbWVyYUluZm9bXSB7XHJcbiAgICAgICAgcmV0dXJuIGdldFNjZW5lQ2FtZXJhcygpLm1hcCgoY2FtZXJhKSA9PiAoe1xyXG4gICAgICAgICAgICB1dWlkOiBjYW1lcmEubm9kZS51dWlkLFxyXG4gICAgICAgICAgICBuYW1lOiBjYW1lcmEubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICBwYXRoOiBnZXROb2RlUGF0aChjYW1lcmEubm9kZSksXHJcbiAgICAgICAgICAgIHByaW9yaXR5OiBjYW1lcmEucHJpb3JpdHksXHJcbiAgICAgICAgICAgIGVuYWJsZWQ6IGNhbWVyYS5lbmFibGVkSW5IaWVyYXJjaHksXHJcbiAgICAgICAgfSkpO1xyXG4gICAgfSxcclxuXHJcbiAgICAvKipcclxuICAgICAqIEB6aCDmuLjmiI/pooTop4jlvIDlhbPml7bosIPnlKjvvJrlvIDlkK/liJnmi6bmiKogTWluaVByZXZpZXcg5Yib5bu65bCP56qX77yb5YWz6Zet5YiZ5oGi5aSN44CCXHJcbiAgICAgKi9cclxuICAgIHNldE1pbmlQcmV2aWV3U3VwcHJlc3NlZChzdXBwcmVzc2VkOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICAgICAgc2V0RWRpdG9yTWluaVByZXZpZXdTdXBwcmVzc2VkKCEhc3VwcHJlc3NlZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIC8qKiDnoa7kv53ljovliLbku43nlJ/mlYjlubbmuIXmjonlt7LlvLnlh7rnmoTlsI/nqpfvvIjpgInkuK0gQ2FtZXJhIOWQjueahOWFnOW6le+8ieOAgiAqL1xyXG4gICAgaGlkZUVkaXRvck1pbmlQcmV2aWV3KCk6IHZvaWQge1xyXG4gICAgICAgIGhpZGVFZGl0b3JNaW5pUHJldmlldygpO1xyXG4gICAgfSxcclxuXHJcbiAgICAvKipcclxuICAgICAqIEB6aCDluLjpqbvku6PnkIbnm7jmnLogKyDljZXmrKEgcmVwYWludCDor7vlm57jgILluKfpl7TnpoHnlKjku6PnkIbnm7jmnLrvvIzpgb/lhY3mi5bmi73lnLrmma/ml7bmr4/luKflpJrnlLvkuIDot6/jgIJcclxuICAgICAqL1xyXG4gICAgYXN5bmMgY2FwdHVyZShvcHRpb25zOiBJQ2FwdHVyZU9wdGlvbnMpOiBQcm9taXNlPElDYXB0dXJlUmVzdWx0IHwgbnVsbD4ge1xyXG4gICAgICAgIGlmICghaXNSZW5kZXJlclJlYWR5KCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIG1heWJlSGVhbEdhbWVDYW1lcmFzKCk7XHJcblxyXG4gICAgICAgIGNvbnN0IHdpZHRoID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChvcHRpb25zLndpZHRoKSk7XHJcbiAgICAgICAgY29uc3QgaGVpZ2h0ID0gTWF0aC5tYXgoMSwgTWF0aC5yb3VuZChvcHRpb25zLmhlaWdodCkpO1xyXG4gICAgICAgIGNvbnN0IHRhcmdldHMgPSByZXNvbHZlVGFyZ2V0cyhvcHRpb25zKTtcclxuICAgICAgICBpZiAodGFyZ2V0cy5sZW5ndGggPT09IDApIHtcclxuICAgICAgICAgICAgY2xlYXJTZXNzaW9uKCk7XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgY29uc3QgdGV4dHVyZSA9IGVuc3VyZVJlbmRlclRleHR1cmUod2lkdGgsIGhlaWdodCk7XHJcbiAgICAgICAgaWYgKCF0ZXh0dXJlLndpbmRvdykge1xyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IGNhbWVyYUNvdW50ID0gZW5zdXJlUHJldmlld0NhbWVyYXModGFyZ2V0cywgdGV4dHVyZSk7XHJcbiAgICAgICAgaWYgKGNhbWVyYUNvdW50ID09PSAwKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgc2V0UHJldmlld0NhbWVyYXNFbmFibGVkKHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGF3YWl0IG5ldyBQcm9taXNlPHZvaWQ+KChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgICAgICAgICBkaXJlY3Rvci5vbmNlKERpcmVjdG9yLkVWRU5UX0FGVEVSX0RSQVcsIHJlc29sdmUpO1xyXG4gICAgICAgICAgICAgICAgcmVxdWVzdFJlcGFpbnQoKTtcclxuICAgICAgICAgICAgfSk7XHJcblxyXG4gICAgICAgICAgICBjb25zdCBwaXhlbHMgPSBlbnN1cmVQaXhlbEJ1ZmZlcih3aWR0aCAqIGhlaWdodCAqIDQpO1xyXG4gICAgICAgICAgICB0ZXh0dXJlLnJlYWRQaXhlbHMoMCwgMCwgd2lkdGgsIGhlaWdodCwgcGl4ZWxzKTtcclxuXHJcbiAgICAgICAgICAgIC8vIOWcuuaZr+mdmeatouaXtui3s+i/hyBKUEVHICsg5aSn5a2X56ym5LiyIElQQ++8iENQVSDlpKflpLTvvInvvIxHUFUg6K+75Zue5LuN5L+d55WZ5Lul5L+d6K+B5YaF5a655Y+Y5pu06IO95qOA5Ye6XHJcbiAgICAgICAgICAgIGlmIChwaXhlbHNVbmNoYW5nZWQocGl4ZWxzKSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgICAgICB1bmNoYW5nZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgd2lkdGgsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIGNhbWVyYUNvdW50LFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW1lbWJlckZyYW1lUGl4ZWxzKHBpeGVscyk7XHJcblxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgZGF0YVVybDogZW5jb2RlVG9EYXRhVXJsKHBpeGVscywgd2lkdGgsIGhlaWdodCwgb3B0aW9ucy5xdWFsaXR5KSxcclxuICAgICAgICAgICAgICAgIHdpZHRoLFxyXG4gICAgICAgICAgICAgICAgaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgY2FtZXJhQ291bnQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgLy8g5bin6Ze05YWz5o6J5Luj55CG55u45py677yM5LiN6ZSA5q+B77yb5LiN5YaN5LqM5qyhIHJlcGFpbnTvvIzpgb/lhY3mi5bmrbvlnLrmma/nvJbovpHlmahcclxuICAgICAgICAgICAgc2V0UHJldmlld0NhbWVyYXNFbmFibGVkKGZhbHNlKTtcclxuICAgICAgICB9XHJcbiAgICB9LFxyXG5cclxuICAgIHN0b3AoKTogdm9pZCB7XHJcbiAgICAgICAgY2xlYXJTZXNzaW9uKCk7XHJcbiAgICAgICAgaGVhbEdhbWVDYW1lcmFXaW5kb3dzKCk7XHJcbiAgICAgICAgcmVxdWVzdFJlcGFpbnQoKTtcclxuICAgIH0sXHJcbn07XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gbG9hZCgpIHtcclxuICAgIGhlYWxHYW1lQ2FtZXJhV2luZG93cygpO1xyXG59XHJcblxyXG5leHBvcnQgZnVuY3Rpb24gdW5sb2FkKCkge1xyXG4gICAgc2V0RWRpdG9yTWluaVByZXZpZXdTdXBwcmVzc2VkKGZhbHNlKTtcclxuICAgIGNsZWFyU2Vzc2lvbigpO1xyXG4gICAgaGVhbEdhbWVDYW1lcmFXaW5kb3dzKCk7XHJcbiAgICBlbmNvZGVDYW52YXMgPSBudWxsO1xyXG59XHJcbiJdfQ==
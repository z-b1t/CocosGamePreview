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
/** 递增后作废进行中的 capture，避免切到无相机场景时仍等待绘制。 */
let captureGeneration = 0;
let settleDrawWait = null;
const EDITOR_CAMERA_NODE_NAMES = new Set(['Editor Camera', 'Editor Scene Background', 'Scene Gizmo Camera']);
const PREVIEW_NODE_NAME = '__CameraPreviewProxy__';
/** 编辑器把内置相机挂在这个隐藏根下；预制体隔离场景里路径会显示成 should_hide_in_hierarchy/Camera。 */
const EDITOR_HIDDEN_ROOT_NAME = 'should_hide_in_hierarchy';
/** 等不到 AFTER_DRAW 时的上限，防止预制体等无相机场景把 capture 卡住。 */
const DRAW_WAIT_TIMEOUT_MS = 1000;
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
/**
 * @zh 只排除编辑器内置相机。编辑期用户相机的 cameraUsage 也是 EDITOR，不能拿 usage 判断。
 */
function isUnderEditorHiddenRoot(node) {
    let current = node;
    while (current) {
        if (current.name === EDITOR_HIDDEN_ROOT_NAME) {
            return true;
        }
        current = current.parent;
    }
    return false;
}
function isUserGameCamera(camera) {
    var _a;
    if (!camera.isValid || !((_a = camera.node) === null || _a === void 0 ? void 0 : _a.isValid)) {
        return false;
    }
    if (camera.node.name === PREVIEW_NODE_NAME) {
        return false;
    }
    if (EDITOR_CAMERA_NODE_NAMES.has(camera.node.name) || camera.node.name.startsWith('Editor')) {
        return false;
    }
    if (camera.node.hideFlags & cc_1.CCObject.Flags.HideInHierarchy) {
        return false;
    }
    if (isUnderEditorHiddenRoot(camera.node)) {
        return false;
    }
    return true;
}
function getSceneCameras() {
    const scene = cc_1.director.getScene();
    if (!scene) {
        return [];
    }
    return scene.getComponentsInChildren(cc_1.Camera).filter(isUserGameCamera);
}
function hasPreviewSession() {
    return previewNodes.length > 0 || !!renderTexture;
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
                    camera.enabled = false;
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
        node.active = false;
        scene.addChild(node);
        node.setWorldPosition(source.node.worldPosition);
        node.setWorldRotation(source.node.worldRotation);
        node.setWorldScale(source.node.worldScale);
        const camera = node.addComponent(cc_1.Camera);
        copyCameraSettings(source, camera);
        camera.targetTexture = texture;
        camera.enabled = false;
        node.active = true;
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
function waitForDraw() {
    return new Promise((resolve) => {
        let settled = false;
        const finish = (drawn) => {
            if (settled) {
                return;
            }
            settled = true;
            settleDrawWait = null;
            cc_1.director.off(cc_1.Director.EVENT_AFTER_DRAW, onDraw);
            resolve(drawn);
        };
        const onDraw = () => finish(true);
        settleDrawWait = () => finish(false);
        cc_1.director.once(cc_1.Director.EVENT_AFTER_DRAW, onDraw);
        try {
            requestRepaint();
        }
        catch (_a) {
            finish(false);
            return;
        }
        setTimeout(() => finish(false), DRAW_WAIT_TIMEOUT_MS);
    });
}
function onSceneWillChange() {
    captureGeneration += 1;
    settleDrawWait === null || settleDrawWait === void 0 ? void 0 : settleDrawWait();
    clearSession();
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
        const width = Math.max(1, Math.round(options.width));
        const height = Math.max(1, Math.round(options.height));
        const targets = resolveTargets(options);
        if (targets.length === 0) {
            if (hasPreviewSession()) {
                clearSession();
            }
            return { width, height, cameraCount: 0 };
        }
        maybeHealGameCameras();
        const texture = ensureRenderTexture(width, height);
        if (!texture.window) {
            return null;
        }
        const cameraCount = ensurePreviewCameras(targets, texture);
        if (cameraCount === 0) {
            return { width, height, cameraCount: 0 };
        }
        const token = ++captureGeneration;
        setPreviewCamerasEnabled(true);
        try {
            const drawn = await waitForDraw();
            if (!drawn || token !== captureGeneration) {
                return null;
            }
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
            if (token === captureGeneration) {
                setPreviewCamerasEnabled(false);
            }
        }
    },
    stop() {
        captureGeneration += 1;
        settleDrawWait === null || settleDrawWait === void 0 ? void 0 : settleDrawWait();
        clearSession();
        if (getSceneCameras().length === 0 || !isRendererReady()) {
            return;
        }
        healGameCameraWindows();
        requestRepaint();
    },
};
function load() {
    cc_1.director.on(cc_1.Director.EVENT_BEFORE_SCENE_LOADING, onSceneWillChange);
    cc_1.director.on(cc_1.Director.EVENT_BEFORE_SCENE_LAUNCH, onSceneWillChange);
    healGameCameraWindows();
}
function unload() {
    cc_1.director.off(cc_1.Director.EVENT_BEFORE_SCENE_LOADING, onSceneWillChange);
    cc_1.director.off(cc_1.Director.EVENT_BEFORE_SCENE_LAUNCH, onSceneWillChange);
    captureGeneration += 1;
    settleDrawWait === null || settleDrawWait === void 0 ? void 0 : settleDrawWait();
    setEditorMiniPreviewSuppressed(false);
    clearSession();
    healGameCameraWindows();
    encodeCanvas = null;
}
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoic2NlbmUuanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyIuLi9zb3VyY2Uvc2NlbmUudHMiXSwibmFtZXMiOltdLCJtYXBwaW5ncyI6Ijs7O0FBMG1CQSxvQkFJQztBQUVELHdCQVNDO0FBem5CRCx5QkFBdUI7QUFDdkIsMkJBQWlHO0FBR2pHLElBQUksYUFBYSxHQUF5QixJQUFJLENBQUM7QUFDL0MsSUFBSSxZQUFZLEdBQTZCLElBQUksQ0FBQztBQUNsRCxJQUFJLGVBQWUsR0FBcUIsSUFBSSxDQUFDO0FBQzdDLElBQUksV0FBVyxHQUFzQixJQUFJLENBQUM7QUFDMUMsc0NBQXNDO0FBQ3RDLElBQUksZUFBZSxHQUFzQixJQUFJLENBQUM7QUFDOUMsMkNBQTJDO0FBQzNDLElBQUksWUFBWSxHQUFXLEVBQUUsQ0FBQztBQUM5QiwrQ0FBK0M7QUFDL0MsSUFBSSxrQkFBa0IsR0FBYSxFQUFFLENBQUM7QUFDdEMsSUFBSSxpQkFBaUIsR0FBRyxDQUFDLENBQUM7QUFDMUIseUNBQXlDO0FBQ3pDLElBQUksaUJBQWlCLEdBQUcsQ0FBQyxDQUFDO0FBQzFCLElBQUksY0FBYyxHQUF3QixJQUFJLENBQUM7QUFFL0MsTUFBTSx3QkFBd0IsR0FBRyxJQUFJLEdBQUcsQ0FBQyxDQUFDLGVBQWUsRUFBRSx5QkFBeUIsRUFBRSxvQkFBb0IsQ0FBQyxDQUFDLENBQUM7QUFDN0csTUFBTSxpQkFBaUIsR0FBRyx3QkFBd0IsQ0FBQztBQUNuRCx1RUFBdUU7QUFDdkUsTUFBTSx1QkFBdUIsR0FBRywwQkFBMEIsQ0FBQztBQUMzRCxtREFBbUQ7QUFDbkQsTUFBTSxvQkFBb0IsR0FBRyxJQUFJLENBQUM7QUFFbEMsU0FBUyxlQUFlO0lBQ3BCLE1BQU0sSUFBSSxHQUFHLGFBQVEsQ0FBQyxJQUFJLENBQUM7SUFDM0IsT0FBTyxDQUFDLENBQUMsQ0FBQSxJQUFJLGFBQUosSUFBSSx1QkFBSixJQUFJLENBQUUsVUFBVSxDQUFBLElBQUksQ0FBQyxDQUFDLElBQUksQ0FBQyxRQUFR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QUMsS0FBSyxDQUFDLENBQUM7WUFDcEMsQ0FBQztRQUNMLENBQUM7SUFDTCxDQUFDO0lBRUQsSUFBSTtRQUNBLGlCQUFpQixJQUFJLENBQUMsQ0FBQztRQUN2QixjQUFjLGFBQWQsY0FBYyx1QkFBZCxjQUFjLEVBQUksQ0FBQztRQUNuQixZQUFZLEVBQUUsQ0FBQztRQUNmLElBQUksZUFBZSxFQUFFLENBQUMsTUFBTSxLQUFLLENBQUMsSUFBSSxDQUFDLGVBQWUsRUFBRSxFQUFFLENBQUM7WUFDdkQsT0FBTztRQUNYLENBQUM7UUFDRCxxQkFBcUIsRUFBRSxDQUFDO1FBQ3hCLGNBQWMsRUFBRSxDQUFDO0lBQ3JCLENBQUM7Q0FDSixDQUFDO0FBRUYsU0FBZ0IsSUFBSTtJQUNoQixhQUFRLENBQUMsRUFBRSxDQUFDLGFBQVEsQ0FBQywwQkFBMEIsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO0lBQ3BFLGFBQVEsQ0FBQyxFQUFFLENBQUMsYUFBUSxDQUFDLHlCQUF5QixFQUFFLGlCQUFpQixDQUFDLENBQUM7SUFDbkUscUJBQXFCLEVBQUUsQ0FBQztBQUM1QixDQUFDO0FBRUQsU0FBZ0IsTUFBTTtJQUNsQixhQUFRLENBQUMsR0FBRyxDQUFDLGFBQVEsQ0FBQywwQkFBMEIsRUFBRSxpQkFBaUIsQ0FBQyxDQUFDO0lBQ3JFLGFBQVEsQ0FBQyxHQUFHLENBQUMsYUFBUSxDQUFDLHlCQUF5QixFQUFFLGlCQUFpQixDQUFDLENBQUM7SUFDcEUsaUJBQWlCLElBQUksQ0FBQyxDQUFDO0lBQ3ZCLGNBQWMsYUFBZCxjQUFjLHVCQUFkLGNBQWMsRUFBSSxDQUFDO0lBQ25CLDhCQUE4QixDQUFDLEtBQUssQ0FBQyxDQUFDO0lBQ3RDLFlBQVksRUFBRSxDQUFDO0lBQ2YscUJBQXFCLEVBQUUsQ0FBQztJQUN4QixZQUFZLEdBQUcsSUFBSSxDQUFDO0FBQ3hCLENBQUMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgJy4vZW5naW5lLXBhdGgnO1xyXG5pbXBvcnQgeyBDQ09iamVjdCwgQ2FtZXJhLCBDb2xvciwgRGlyZWN0b3IsIE5vZGUsIFJlY3QsIFJlbmRlclRleHR1cmUsIGRpcmVjdG9yLCBnZnggfSBmcm9tICdjYyc7XHJcbmltcG9ydCB0eXBlIHsgSUNhbWVyYUluZm8sIElDYXB0dXJlT3B0aW9ucywgSUNhcHR1cmVSZXN1bHQgfSBmcm9tICcuL3R5cGVzJztcclxuXHJcbmxldCByZW5kZXJUZXh0dXJlOiBSZW5kZXJUZXh0dXJlIHwgbnVsbCA9IG51bGw7XHJcbmxldCBlbmNvZGVDYW52YXM6IEhUTUxDYW52YXNFbGVtZW50IHwgbnVsbCA9IG51bGw7XHJcbmxldCBlbmNvZGVJbWFnZURhdGE6IEltYWdlRGF0YSB8IG51bGwgPSBudWxsO1xyXG5sZXQgcGl4ZWxCdWZmZXI6IFVpbnQ4QXJyYXkgfCBudWxsID0gbnVsbDtcclxuLyoqIOS4iuS4gOW4p+WDj+e0oOWJr+acrO+8jOeUqOS6jui3s+i/h+aXoOWPmOWMluaXtueahCBKUEVHIOe8lueggeS4jiBJUEPjgIIgKi9cclxubGV0IGxhc3RGcmFtZVBpeGVsczogVWludDhBcnJheSB8IG51bGwgPSBudWxsO1xyXG4vKiog5LuF55So5LqO6aKE6KeI55qE5Li05pe255u45py66IqC54K577yM57ud5LiN5pS55Yqo5Zy65pmv6YeM5Y6f5pyJIENhbWVyYSDnmoTmuLLmn5Pnm67moIfjgIIgKi9cclxubGV0IHByZXZpZXdOb2RlczogTm9kZVtdID0gW107XHJcbi8qKiDkuI4gcHJldmlld05vZGVzIOS4gOS4gOWvueW6lOeahOa6kOebuOacuiB1dWlk77yM55So5LqO5Yik5pat5piv5ZCm6ZyA6KaB6YeN5bu644CCICovXHJcbmxldCBwcmV2aWV3U291cmNlVXVpZHM6IHN0cmluZ1tdID0gW107XHJcbmxldCBoZWFsVGhyb3R0bGVVbnRpbCA9IDA7XHJcbi8qKiDpgJLlop7lkI7kvZzlup/ov5vooYzkuK3nmoQgY2FwdHVyZe+8jOmBv+WFjeWIh+WIsOaXoOebuOacuuWcuuaZr+aXtuS7jeetieW+hee7mOWItuOAgiAqL1xyXG5sZXQgY2FwdHVyZUdlbmVyYXRpb24gPSAwO1xyXG5sZXQgc2V0dGxlRHJhd1dhaXQ6ICgoKSA9PiB2b2lkKSB8IG51bGwgPSBudWxsO1xyXG5cclxuY29uc3QgRURJVE9SX0NBTUVSQV9OT0RFX05BTUVTID0gbmV3IFNldChbJ0VkaXRvciBDYW1lcmEnLCAnRWRpdG9yIFNjZW5lIEJhY2tncm91bmQnLCAnU2NlbmUgR2l6bW8gQ2FtZXJhJ10pO1xyXG5jb25zdCBQUkVWSUVXX05PREVfTkFNRSA9ICdfX0NhbWVyYVByZXZpZXdQcm94eV9fJztcclxuLyoqIOe8lui+keWZqOaKiuWGhee9ruebuOacuuaMguWcqOi/meS4qumakOiXj+agueS4i++8m+mihOWItuS9k+malOemu+WcuuaZr+mHjOi3r+W+hOS8muaYvuekuuaIkCBzaG91bGRfaGlkZV9pbl9oaWVyYXJjaHkvQ2FtZXJh44CCICovXHJcbmNvbnN0IEVESVRPUl9ISURERU5fUk9PVF9OQU1FID0gJ3Nob3VsZF9oaWRlX2luX2hpZXJhcmNoeSc7XHJcbi8qKiDnrYnkuI3liLAgQUZURVJfRFJBVyDml7bnmoTkuIrpmZDvvIzpmLLmraLpooTliLbkvZPnrYnml6Dnm7jmnLrlnLrmma/mioogY2FwdHVyZSDljaHkvY/jgIIgKi9cclxuY29uc3QgRFJBV19XQUlUX1RJTUVPVVRfTVMgPSAxMDAwO1xyXG5cclxuZnVuY3Rpb24gaXNSZW5kZXJlclJlYWR5KCk6IGJvb2xlYW4ge1xyXG4gICAgY29uc3Qgcm9vdCA9IGRpcmVjdG9yLnJvb3Q7XHJcbiAgICByZXR1cm4gISFyb290Py5tYWluV2luZG93ICYmICEhcm9vdC5waXBlbGluZSAmJiByb290LmRldmljZS5zd2FwY2hhaW5Gb3JtYXQgIT09IGdmeC5Gb3JtYXQuVU5LTk9XTjtcclxufVxyXG5cclxuZnVuY3Rpb24gZ2V0VGVtcFdpbmRvdygpOiBhbnkgfCBudWxsIHtcclxuICAgIHJldHVybiAoZGlyZWN0b3Iucm9vdCBhcyBhbnkpPy50ZW1wV2luZG93ID8/IG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg57yW6L6R5pyf5ri45oiP55u45py65Lya5oyC5ZyoIHJvb3QudGVtcFdpbmRvdyDkuIrjgIJcclxuICog5pen54mI5pys5o+S5Lu26Iul5oqK55u45py65pGY5oiQIHdpbmRvdz1udWxs77yM6L+Z6YeM5bC96YeP6KGl5Zue77yM6YG/5YWN57yW6L6R5Zmo55u45py65bCP56qX5oyB57ut5oql6ZSZ44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBoZWFsR2FtZUNhbWVyYVdpbmRvd3MoKTogdm9pZCB7XHJcbiAgICBjb25zdCB0ZW1wV2luZG93ID0gZ2V0VGVtcFdpbmRvdygpO1xyXG4gICAgaWYgKCF0ZW1wV2luZG93KSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgZm9yIChjb25zdCBjb21wb25lbnQgb2YgZ2V0U2NlbmVDYW1lcmFzKCkpIHtcclxuICAgICAgICBpZiAoY29tcG9uZW50LnRhcmdldFRleHR1cmUpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNhbWVyYSA9IGNvbXBvbmVudC5jYW1lcmE7XHJcbiAgICAgICAgaWYgKCFjYW1lcmEpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGlmICghY2FtZXJhLndpbmRvdykge1xyXG4gICAgICAgICAgICAgICAgY2FtZXJhLmNoYW5nZVRhcmdldFdpbmRvdyh0ZW1wV2luZG93KTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyDlv73nlaXkuKrliKvlt7LplIDmr4Hnm7jmnLpcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg5Y+q5o6S6Zmk57yW6L6R5Zmo5YaF572u55u45py644CC57yW6L6R5pyf55So5oi355u45py655qEIGNhbWVyYVVzYWdlIOS5n+aYryBFRElUT1LvvIzkuI3og73mi78gdXNhZ2Ug5Yik5pat44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBpc1VuZGVyRWRpdG9ySGlkZGVuUm9vdChub2RlOiBOb2RlKTogYm9vbGVhbiB7XHJcbiAgICBsZXQgY3VycmVudDogTm9kZSB8IG51bGwgPSBub2RlO1xyXG4gICAgd2hpbGUgKGN1cnJlbnQpIHtcclxuICAgICAgICBpZiAoY3VycmVudC5uYW1lID09PSBFRElUT1JfSElEREVOX1JPT1RfTkFNRSkge1xyXG4gICAgICAgICAgICByZXR1cm4gdHJ1ZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgY3VycmVudCA9IGN1cnJlbnQucGFyZW50O1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIGZhbHNlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBpc1VzZXJHYW1lQ2FtZXJhKGNhbWVyYTogQ2FtZXJhKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoIWNhbWVyYS5pc1ZhbGlkIHx8ICFjYW1lcmEubm9kZT8uaXNWYWxpZCkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGlmIChjYW1lcmEubm9kZS5uYW1lID09PSBQUkVWSUVXX05PREVfTkFNRSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIGlmIChFRElUT1JfQ0FNRVJBX05PREVfTkFNRVMuaGFzKGNhbWVyYS5ub2RlLm5hbWUpIHx8IGNhbWVyYS5ub2RlLm5hbWUuc3RhcnRzV2l0aCgnRWRpdG9yJykpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBpZiAoY2FtZXJhLm5vZGUuaGlkZUZsYWdzICYgQ0NPYmplY3QuRmxhZ3MuSGlkZUluSGllcmFyY2h5KSB7XHJcbiAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgfVxyXG4gICAgaWYgKGlzVW5kZXJFZGl0b3JIaWRkZW5Sb290KGNhbWVyYS5ub2RlKSkge1xyXG4gICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgIH1cclxuICAgIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXRTY2VuZUNhbWVyYXMoKTogQ2FtZXJhW10ge1xyXG4gICAgY29uc3Qgc2NlbmUgPSBkaXJlY3Rvci5nZXRTY2VuZSgpO1xyXG4gICAgaWYgKCFzY2VuZSkge1xyXG4gICAgICAgIHJldHVybiBbXTtcclxuICAgIH1cclxuICAgIHJldHVybiBzY2VuZS5nZXRDb21wb25lbnRzSW5DaGlsZHJlbihDYW1lcmEpLmZpbHRlcihpc1VzZXJHYW1lQ2FtZXJhKTtcclxufVxyXG5cclxuZnVuY3Rpb24gaGFzUHJldmlld1Nlc3Npb24oKTogYm9vbGVhbiB7XHJcbiAgICByZXR1cm4gcHJldmlld05vZGVzLmxlbmd0aCA+IDAgfHwgISFyZW5kZXJUZXh0dXJlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBnZXROb2RlUGF0aChub2RlOiBOb2RlKTogc3RyaW5nIHtcclxuICAgIGNvbnN0IG5hbWVzOiBzdHJpbmdbXSA9IFtdO1xyXG4gICAgbGV0IGN1cnJlbnQ6IE5vZGUgfCBudWxsID0gbm9kZTtcclxuICAgIHdoaWxlIChjdXJyZW50ICYmIGN1cnJlbnQucGFyZW50KSB7XHJcbiAgICAgICAgbmFtZXMudW5zaGlmdChjdXJyZW50Lm5hbWUpO1xyXG4gICAgICAgIGN1cnJlbnQgPSBjdXJyZW50LnBhcmVudDtcclxuICAgIH1cclxuICAgIHJldHVybiBuYW1lcy5qb2luKCcvJyk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNldFByZXZpZXdDYW1lcmFzRW5hYmxlZChlbmFibGVkOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcHJldmlld05vZGVzKSB7XHJcbiAgICAgICAgaWYgKCFub2RlLmlzVmFsaWQpIHtcclxuICAgICAgICAgICAgY29udGludWU7XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGNvbnN0IGNhbWVyYSA9IG5vZGUuZ2V0Q29tcG9uZW50KENhbWVyYSk7XHJcbiAgICAgICAgaWYgKGNhbWVyYSkge1xyXG4gICAgICAgICAgICBjYW1lcmEuZW5hYmxlZCA9IGVuYWJsZWQ7XHJcbiAgICAgICAgfVxyXG4gICAgfVxyXG59XHJcblxyXG5mdW5jdGlvbiBkZXN0cm95UHJldmlld0NhbWVyYXMoKTogdm9pZCB7XHJcbiAgICBmb3IgKGNvbnN0IG5vZGUgb2YgcHJldmlld05vZGVzKSB7XHJcbiAgICAgICAgdHJ5IHtcclxuICAgICAgICAgICAgaWYgKG5vZGUuaXNWYWxpZCkge1xyXG4gICAgICAgICAgICAgICAgY29uc3QgY2FtZXJhID0gbm9kZS5nZXRDb21wb25lbnQoQ2FtZXJhKTtcclxuICAgICAgICAgICAgICAgIGlmIChjYW1lcmEpIHtcclxuICAgICAgICAgICAgICAgICAgICBjYW1lcmEuZW5hYmxlZCA9IGZhbHNlO1xyXG4gICAgICAgICAgICAgICAgICAgIGNhbWVyYS50YXJnZXRUZXh0dXJlID0gbnVsbDtcclxuICAgICAgICAgICAgICAgIH1cclxuICAgICAgICAgICAgICAgIG5vZGUuZGVzdHJveSgpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfSBjYXRjaCB7XHJcbiAgICAgICAgICAgIC8vIOWcuuaZr+WIh+aNouaXtuiKgueCueWPr+iDveW3suWkseaViFxyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHByZXZpZXdOb2RlcyA9IFtdO1xyXG4gICAgcHJldmlld1NvdXJjZVV1aWRzID0gW107XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZVJlbmRlclRleHR1cmUod2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIpOiBSZW5kZXJUZXh0dXJlIHtcclxuICAgIGlmICghcmVuZGVyVGV4dHVyZSkge1xyXG4gICAgICAgIGNvbnN0IHRleHR1cmUgPSBuZXcgUmVuZGVyVGV4dHVyZSgpO1xyXG4gICAgICAgIHRleHR1cmUucmVzZXQoeyB3aWR0aCwgaGVpZ2h0IH0pO1xyXG4gICAgICAgIHJlbmRlclRleHR1cmUgPSB0ZXh0dXJlO1xyXG4gICAgfSBlbHNlIGlmIChyZW5kZXJUZXh0dXJlLndpZHRoICE9PSB3aWR0aCB8fCByZW5kZXJUZXh0dXJlLmhlaWdodCAhPT0gaGVpZ2h0KSB7XHJcbiAgICAgICAgZGVzdHJveVByZXZpZXdDYW1lcmFzKCk7XHJcbiAgICAgICAgcmVuZGVyVGV4dHVyZS5yZXNpemUod2lkdGgsIGhlaWdodCk7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gcmVuZGVyVGV4dHVyZTtcclxufVxyXG5cclxuZnVuY3Rpb24gZGVzdHJveVJlbmRlclRleHR1cmUoKTogdm9pZCB7XHJcbiAgICBkZXN0cm95UHJldmlld0NhbWVyYXMoKTtcclxuICAgIGlmICghcmVuZGVyVGV4dHVyZSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIHJlbmRlclRleHR1cmUuZGVzdHJveSgpO1xyXG4gICAgcmVuZGVyVGV4dHVyZSA9IG51bGw7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGVuc3VyZUVuY29kZUNhbnZhcyh3aWR0aDogbnVtYmVyLCBoZWlnaHQ6IG51bWJlcik6IEhUTUxDYW52YXNFbGVtZW50IHtcclxuICAgIGlmICghZW5jb2RlQ2FudmFzKSB7XHJcbiAgICAgICAgZW5jb2RlQ2FudmFzID0gZG9jdW1lbnQuY3JlYXRlRWxlbWVudCgnY2FudmFzJyk7XHJcbiAgICB9XHJcbiAgICBpZiAoZW5jb2RlQ2FudmFzLndpZHRoICE9PSB3aWR0aCB8fCBlbmNvZGVDYW52YXMuaGVpZ2h0ICE9PSBoZWlnaHQpIHtcclxuICAgICAgICBlbmNvZGVDYW52YXMud2lkdGggPSB3aWR0aDtcclxuICAgICAgICBlbmNvZGVDYW52YXMuaGVpZ2h0ID0gaGVpZ2h0O1xyXG4gICAgICAgIGVuY29kZUltYWdlRGF0YSA9IG51bGw7XHJcbiAgICB9XHJcbiAgICByZXR1cm4gZW5jb2RlQ2FudmFzO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVQaXhlbEJ1ZmZlcihzaXplOiBudW1iZXIpOiBVaW50OEFycmF5IHtcclxuICAgIGlmICghcGl4ZWxCdWZmZXIgfHwgcGl4ZWxCdWZmZXIubGVuZ3RoICE9PSBzaXplKSB7XHJcbiAgICAgICAgcGl4ZWxCdWZmZXIgPSBuZXcgVWludDhBcnJheShzaXplKTtcclxuICAgIH1cclxuICAgIHJldHVybiBwaXhlbEJ1ZmZlcjtcclxufVxyXG5cclxuZnVuY3Rpb24gY29weUNhbWVyYVNldHRpbmdzKHNvdXJjZTogQ2FtZXJhLCB0YXJnZXQ6IENhbWVyYSk6IHZvaWQge1xyXG4gICAgdGFyZ2V0LnByaW9yaXR5ID0gc291cmNlLnByaW9yaXR5O1xyXG4gICAgdGFyZ2V0LnZpc2liaWxpdHkgPSBzb3VyY2UudmlzaWJpbGl0eTtcclxuICAgIHRhcmdldC5jbGVhckZsYWdzID0gc291cmNlLmNsZWFyRmxhZ3M7XHJcbiAgICB0YXJnZXQuY2xlYXJDb2xvciA9IG5ldyBDb2xvcihzb3VyY2UuY2xlYXJDb2xvci5yLCBzb3VyY2UuY2xlYXJDb2xvci5nLCBzb3VyY2UuY2xlYXJDb2xvci5iLCBzb3VyY2UuY2xlYXJDb2xvci5hKTtcclxuICAgIHRhcmdldC5jbGVhckRlcHRoID0gc291cmNlLmNsZWFyRGVwdGg7XHJcbiAgICB0YXJnZXQuY2xlYXJTdGVuY2lsID0gc291cmNlLmNsZWFyU3RlbmNpbDtcclxuICAgIHRhcmdldC5wcm9qZWN0aW9uID0gc291cmNlLnByb2plY3Rpb247XHJcbiAgICB0YXJnZXQuZm92QXhpcyA9IHNvdXJjZS5mb3ZBeGlzO1xyXG4gICAgdGFyZ2V0LmZvdiA9IHNvdXJjZS5mb3Y7XHJcbiAgICB0YXJnZXQub3J0aG9IZWlnaHQgPSBzb3VyY2Uub3J0aG9IZWlnaHQ7XHJcbiAgICB0YXJnZXQubmVhciA9IHNvdXJjZS5uZWFyO1xyXG4gICAgdGFyZ2V0LmZhciA9IHNvdXJjZS5mYXI7XHJcbiAgICB0YXJnZXQuYXBlcnR1cmUgPSBzb3VyY2UuYXBlcnR1cmU7XHJcbiAgICB0YXJnZXQuc2h1dHRlciA9IHNvdXJjZS5zaHV0dGVyO1xyXG4gICAgdGFyZ2V0LmlzbyA9IHNvdXJjZS5pc287XHJcbiAgICBjb25zdCByZWN0ID0gc291cmNlLnJlY3Q7XHJcbiAgICB0YXJnZXQucmVjdCA9IG5ldyBSZWN0KHJlY3QueCwgcmVjdC55LCByZWN0LndpZHRoLCByZWN0LmhlaWdodCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHN5bmNQcm94eU5vZGUoc291cmNlOiBDYW1lcmEsIG5vZGU6IE5vZGUpOiB2b2lkIHtcclxuICAgIG5vZGUubGF5ZXIgPSBzb3VyY2Uubm9kZS5sYXllcjtcclxuICAgIG5vZGUuc2V0V29ybGRQb3NpdGlvbihzb3VyY2Uubm9kZS53b3JsZFBvc2l0aW9uKTtcclxuICAgIG5vZGUuc2V0V29ybGRSb3RhdGlvbihzb3VyY2Uubm9kZS53b3JsZFJvdGF0aW9uKTtcclxuICAgIG5vZGUuc2V0V29ybGRTY2FsZShzb3VyY2Uubm9kZS53b3JsZFNjYWxlKTtcclxuICAgIGNvbnN0IGNhbWVyYSA9IG5vZGUuZ2V0Q29tcG9uZW50KENhbWVyYSk7XHJcbiAgICBpZiAoY2FtZXJhKSB7XHJcbiAgICAgICAgY29weUNhbWVyYVNldHRpbmdzKHNvdXJjZSwgY2FtZXJhKTtcclxuICAgICAgICBjYW1lcmEudGFyZ2V0VGV4dHVyZSA9IHJlbmRlclRleHR1cmU7XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg5Yib5bu65LiO5rqQ55u45py65ZCM5ae/5oCBL+WQjOWPguaVsOeahOS4tOaXtiBDYW1lcmHvvIzlj6rmiorlroPku6znmoQgdGFyZ2V0VGV4dHVyZSDmjIfliLDpooTop4jotLTlm77jgIJcclxuICog6L+Z5qC35a6M5YWo5LiN6LCD55So5Zy65pmv55u45py655qEIGNoYW5nZVRhcmdldFdpbmRvd++8jOe8lui+keWZqOebuOacuuWwj+eql+S4jeS8muiiq+aKoui1sOOAglxyXG4gKi9cclxuZnVuY3Rpb24gY3JlYXRlUHJldmlld0NhbWVyYXMoc291cmNlczogQ2FtZXJhW10sIHRleHR1cmU6IFJlbmRlclRleHR1cmUpOiBudW1iZXIge1xyXG4gICAgZGVzdHJveVByZXZpZXdDYW1lcmFzKCk7XHJcbiAgICBjb25zdCBzY2VuZSA9IGRpcmVjdG9yLmdldFNjZW5lKCk7XHJcbiAgICBpZiAoIXNjZW5lKSB7XHJcbiAgICAgICAgcmV0dXJuIDA7XHJcbiAgICB9XHJcblxyXG4gICAgZm9yIChjb25zdCBzb3VyY2Ugb2Ygc291cmNlcykge1xyXG4gICAgICAgIGlmICghc291cmNlLmlzVmFsaWQgfHwgIXNvdXJjZS5ub2RlPy5pc1ZhbGlkKSB7XHJcbiAgICAgICAgICAgIGNvbnRpbnVlO1xyXG4gICAgICAgIH1cclxuICAgICAgICBjb25zdCBub2RlID0gbmV3IE5vZGUoUFJFVklFV19OT0RFX05BTUUpO1xyXG4gICAgICAgIG5vZGUuaGlkZUZsYWdzIHw9IENDT2JqZWN0LkZsYWdzLkRvbnRTYXZlIHwgQ0NPYmplY3QuRmxhZ3MuSGlkZUluSGllcmFyY2h5O1xyXG4gICAgICAgIG5vZGUubGF5ZXIgPSBzb3VyY2Uubm9kZS5sYXllcjtcclxuICAgICAgICBub2RlLmFjdGl2ZSA9IGZhbHNlO1xyXG4gICAgICAgIHNjZW5lLmFkZENoaWxkKG5vZGUpO1xyXG4gICAgICAgIG5vZGUuc2V0V29ybGRQb3NpdGlvbihzb3VyY2Uubm9kZS53b3JsZFBvc2l0aW9uKTtcclxuICAgICAgICBub2RlLnNldFdvcmxkUm90YXRpb24oc291cmNlLm5vZGUud29ybGRSb3RhdGlvbik7XHJcbiAgICAgICAgbm9kZS5zZXRXb3JsZFNjYWxlKHNvdXJjZS5ub2RlLndvcmxkU2NhbGUpO1xyXG5cclxuICAgICAgICBjb25zdCBjYW1lcmEgPSBub2RlLmFkZENvbXBvbmVudChDYW1lcmEpO1xyXG4gICAgICAgIGNvcHlDYW1lcmFTZXR0aW5ncyhzb3VyY2UsIGNhbWVyYSk7XHJcbiAgICAgICAgY2FtZXJhLnRhcmdldFRleHR1cmUgPSB0ZXh0dXJlO1xyXG4gICAgICAgIGNhbWVyYS5lbmFibGVkID0gZmFsc2U7XHJcbiAgICAgICAgbm9kZS5hY3RpdmUgPSB0cnVlO1xyXG4gICAgICAgIHByZXZpZXdOb2Rlcy5wdXNoKG5vZGUpO1xyXG4gICAgICAgIHByZXZpZXdTb3VyY2VVdWlkcy5wdXNoKHNvdXJjZS5ub2RlLnV1aWQpO1xyXG4gICAgfVxyXG4gICAgcmV0dXJuIHByZXZpZXdOb2Rlcy5sZW5ndGg7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHNvdXJjZUxpc3RNYXRjaGVzKHNvdXJjZXM6IENhbWVyYVtdKTogYm9vbGVhbiB7XHJcbiAgICBpZiAoc291cmNlcy5sZW5ndGggIT09IHByZXZpZXdTb3VyY2VVdWlkcy5sZW5ndGggfHwgc291cmNlcy5sZW5ndGggIT09IHByZXZpZXdOb2Rlcy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBmb3IgKGxldCBpID0gMDsgaSA8IHNvdXJjZXMubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBpZiAoIXNvdXJjZXNbaV0uaXNWYWxpZCB8fCBzb3VyY2VzW2ldLm5vZGUudXVpZCAhPT0gcHJldmlld1NvdXJjZVV1aWRzW2ldKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICAgICAgaWYgKCFwcmV2aWV3Tm9kZXNbaV0/LmlzVmFsaWQpIHtcclxuICAgICAgICAgICAgcmV0dXJuIGZhbHNlO1xyXG4gICAgICAgIH1cclxuICAgIH1cclxuICAgIHJldHVybiB0cnVlO1xyXG59XHJcblxyXG5mdW5jdGlvbiBlbnN1cmVQcmV2aWV3Q2FtZXJhcyhzb3VyY2VzOiBDYW1lcmFbXSwgdGV4dHVyZTogUmVuZGVyVGV4dHVyZSk6IG51bWJlciB7XHJcbiAgICBpZiAoc291cmNlTGlzdE1hdGNoZXMoc291cmNlcykpIHtcclxuICAgICAgICBmb3IgKGxldCBpID0gMDsgaSA8IHNvdXJjZXMubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICAgICAgc3luY1Byb3h5Tm9kZShzb3VyY2VzW2ldLCBwcmV2aWV3Tm9kZXNbaV0pO1xyXG4gICAgICAgIH1cclxuICAgICAgICByZXR1cm4gcHJldmlld05vZGVzLmxlbmd0aDtcclxuICAgIH1cclxuICAgIHJldHVybiBjcmVhdGVQcmV2aWV3Q2FtZXJhcyhzb3VyY2VzLCB0ZXh0dXJlKTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVzb2x2ZVRhcmdldHMob3B0aW9uczogSUNhcHR1cmVPcHRpb25zKTogQ2FtZXJhW10ge1xyXG4gICAgY29uc3QgY2FtZXJhcyA9IGdldFNjZW5lQ2FtZXJhcygpO1xyXG4gICAgaWYgKG9wdGlvbnMubW9kZSA9PT0gJ3NpbmdsZScpIHtcclxuICAgICAgICBjb25zdCB0YXJnZXQgPSBjYW1lcmFzLmZpbmQoKGNhbWVyYSkgPT4gY2FtZXJhLm5vZGUudXVpZCA9PT0gb3B0aW9ucy5jYW1lcmFVdWlkKTtcclxuICAgICAgICByZXR1cm4gdGFyZ2V0ID8gW3RhcmdldF0gOiBbXTtcclxuICAgIH1cclxuICAgIHJldHVybiBjYW1lcmFzXHJcbiAgICAgICAgLmZpbHRlcigoY2FtZXJhKSA9PiBjYW1lcmEuZW5hYmxlZEluSGllcmFyY2h5ICYmICFjYW1lcmEudGFyZ2V0VGV4dHVyZSlcclxuICAgICAgICAuc29ydCgoYSwgYikgPT4gYS5wcmlvcml0eSAtIGIucHJpb3JpdHkpO1xyXG59XHJcblxyXG5mdW5jdGlvbiByZXF1ZXN0UmVwYWludCgpOiB2b2lkIHtcclxuICAgIGNvbnN0IGVkaXRvclNjZW5lID0gKGdsb2JhbFRoaXMgYXMgYW55KS5jY2U7XHJcbiAgICBlZGl0b3JTY2VuZT8uRW5naW5lPy5yZXBhaW50SW5FZGl0TW9kZT8uKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHdhaXRGb3JEcmF3KCk6IFByb21pc2U8Ym9vbGVhbj4ge1xyXG4gICAgcmV0dXJuIG5ldyBQcm9taXNlKChyZXNvbHZlKSA9PiB7XHJcbiAgICAgICAgbGV0IHNldHRsZWQgPSBmYWxzZTtcclxuICAgICAgICBjb25zdCBmaW5pc2ggPSAoZHJhd246IGJvb2xlYW4pID0+IHtcclxuICAgICAgICAgICAgaWYgKHNldHRsZWQpIHtcclxuICAgICAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICBzZXR0bGVkID0gdHJ1ZTtcclxuICAgICAgICAgICAgc2V0dGxlRHJhd1dhaXQgPSBudWxsO1xyXG4gICAgICAgICAgICBkaXJlY3Rvci5vZmYoRGlyZWN0b3IuRVZFTlRfQUZURVJfRFJBVywgb25EcmF3KTtcclxuICAgICAgICAgICAgcmVzb2x2ZShkcmF3bik7XHJcbiAgICAgICAgfTtcclxuICAgICAgICBjb25zdCBvbkRyYXcgPSAoKSA9PiBmaW5pc2godHJ1ZSk7XHJcbiAgICAgICAgc2V0dGxlRHJhd1dhaXQgPSAoKSA9PiBmaW5pc2goZmFsc2UpO1xyXG4gICAgICAgIGRpcmVjdG9yLm9uY2UoRGlyZWN0b3IuRVZFTlRfQUZURVJfRFJBVywgb25EcmF3KTtcclxuICAgICAgICB0cnkge1xyXG4gICAgICAgICAgICByZXF1ZXN0UmVwYWludCgpO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICBmaW5pc2goZmFsc2UpO1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIHNldFRpbWVvdXQoKCkgPT4gZmluaXNoKGZhbHNlKSwgRFJBV19XQUlUX1RJTUVPVVRfTVMpO1xyXG4gICAgfSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIG9uU2NlbmVXaWxsQ2hhbmdlKCk6IHZvaWQge1xyXG4gICAgY2FwdHVyZUdlbmVyYXRpb24gKz0gMTtcclxuICAgIHNldHRsZURyYXdXYWl0Py4oKTtcclxuICAgIGNsZWFyU2Vzc2lvbigpO1xyXG59XHJcblxyXG5jb25zdCBNSU5JX1BSRVZJRVdfUEFUQ0hfS0VZID0gJ19fZ2FtZVByZXZpZXdNaW5pUGF0Y2hfXyc7XHJcblxyXG4vKiog5ri45oiP6aKE6KeI5byA5ZCv5pyf6Ze05Y6L5Yi257yW6L6R5ZmoIE1pbmlQcmV2aWV377yM6YG/5YWN6YCJ5LitIENhbWVyYSDml7bmiqLmuLLmn5Mv5omT5patIGNhcHR1cmXjgIIgKi9cclxubGV0IG1pbmlQcmV2aWV3U3VwcHJlc3NlZCA9IGZhbHNlO1xyXG4vKiog5Y6L5Yi25pyf6Ze06K6w5b2V6YCJ5Lit55qE6IqC54K577yM5YWz6Zet5ri45oiP6aKE6KeI5ZCO55So5LqO5oGi5aSN5bCP56qX44CCICovXHJcbmxldCBzdXBwcmVzc2VkU2VsZWN0VXVpZDogc3RyaW5nIHwgbnVsbCA9IG51bGw7XHJcblxyXG4vKipcclxuICogQHpoIOaLv+WIsOe8lui+keWZqOWGhee9rueahOebuOacuuWwj+eql++8iE1pbmlQcmV2aWV377yJ566h55CG5Zmo44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBnZXRFZGl0b3JNaW5pUHJldmlldygpOiBhbnkgfCBudWxsIHtcclxuICAgIGNvbnN0IGNjZSA9IChnbG9iYWxUaGlzIGFzIGFueSkuY2NlO1xyXG4gICAgaWYgKCFjY2UpIHtcclxuICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgIH1cclxuICAgIGNvbnN0IGZyb21GYWNhZGUgPSBjY2UuU2NlbmVGYWNhZGVNYW5hZ2VyPy5nZXRDdXJyZW50RmFjYWRlPy4oKT8uX21pbmlQcmV2aWV3TWdyO1xyXG4gICAgaWYgKGZyb21GYWNhZGUpIHtcclxuICAgICAgICByZXR1cm4gZnJvbUZhY2FkZTtcclxuICAgIH1cclxuICAgIHJldHVybiBjY2UuUHJldmlldz8ubWluaVByZXZpZXcgfHwgY2NlLnByZXZpZXdNZ3I/Lm1pbmlQcmV2aWV3IHx8IG51bGw7XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg5riF5o6JIE1pbmlQcmV2aWV3IOW3suWIm+W7uueahOmihOiniOiKgueCue+8jOS4jeiwg+eUqCBoYW5kbGVVbnNlbGVjdO+8iOmBv+WFjeivr+S8pOWxgue6p+mAieS4re+8ieOAglxyXG4gKi9cclxuZnVuY3Rpb24gY2xlYXJNaW5pUHJldmlld05vZGVzKG1pbmk6IGFueSk6IHZvaWQge1xyXG4gICAgdHJ5IHtcclxuICAgICAgICBjb25zdCBjdXJyID0gbWluaS5jdXJyTm9kZTtcclxuICAgICAgICBpZiAoY3Vycj8udXVpZCkge1xyXG4gICAgICAgICAgICBzdXBwcmVzc2VkU2VsZWN0VXVpZCA9IGN1cnIudXVpZDtcclxuICAgICAgICB9XHJcbiAgICB9IGNhdGNoIHtcclxuICAgICAgICAvLyBpZ25vcmVcclxuICAgIH1cclxuICAgIHRyeSB7XHJcbiAgICAgICAgY29uc3Qgbm9kZXMgPSBtaW5pLnByZXZpZXdOb2RlcztcclxuICAgICAgICBpZiAoIW5vZGVzKSB7XHJcbiAgICAgICAgICAgIHJldHVybjtcclxuICAgICAgICB9XHJcbiAgICAgICAgY29uc3QgdmFsdWVzOiBhbnlbXSA9IG5vZGVzIGluc3RhbmNlb2YgTWFwXHJcbiAgICAgICAgICAgID8gQXJyYXkuZnJvbShub2Rlcy52YWx1ZXMoKSlcclxuICAgICAgICAgICAgOiBBcnJheS5pc0FycmF5KG5vZGVzKVxyXG4gICAgICAgICAgICAgICAgPyBbLi4ubm9kZXNdXHJcbiAgICAgICAgICAgICAgICA6IE9iamVjdC52YWx1ZXMobm9kZXMpO1xyXG4gICAgICAgIGZvciAoY29uc3QgdmFsdWUgb2YgdmFsdWVzKSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGNhbWVyYSA9IHZhbHVlPy5jYW1lcmFDb21wb25lbnQgfHwgdmFsdWU/LmNhbWVyYSB8fCB2YWx1ZTtcclxuICAgICAgICAgICAgaWYgKGNhbWVyYSAmJiB0eXBlb2YgbWluaS5yZW1vdmVQcmV2aWV3Tm9kZSA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgICAgICAgICAgbWluaS5yZW1vdmVQcmV2aWV3Tm9kZShjYW1lcmEpO1xyXG4gICAgICAgICAgICB9XHJcbiAgICAgICAgfVxyXG4gICAgfSBjYXRjaCB7XHJcbiAgICAgICAgLy8gaWdub3JlXHJcbiAgICB9XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBhdGNoTWluaVByZXZpZXcobWluaTogYW55KTogdm9pZCB7XHJcbiAgICBpZiAobWluaVtNSU5JX1BSRVZJRVdfUEFUQ0hfS0VZXSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG9yaWdpbmFsSGFuZGxlU2VsZWN0ID0gdHlwZW9mIG1pbmkuaGFuZGxlU2VsZWN0ID09PSAnZnVuY3Rpb24nXHJcbiAgICAgICAgPyBtaW5pLmhhbmRsZVNlbGVjdC5iaW5kKG1pbmkpXHJcbiAgICAgICAgOiBudWxsO1xyXG4gICAgY29uc3Qgb3JpZ2luYWxDcmVhdGVQcmV2aWV3Tm9kZSA9IHR5cGVvZiBtaW5pLmNyZWF0ZVByZXZpZXdOb2RlID09PSAnZnVuY3Rpb24nXHJcbiAgICAgICAgPyBtaW5pLmNyZWF0ZVByZXZpZXdOb2RlLmJpbmQobWluaSlcclxuICAgICAgICA6IG51bGw7XHJcbiAgICBtaW5pW01JTklfUFJFVklFV19QQVRDSF9LRVldID0ge1xyXG4gICAgICAgIGhhbmRsZVNlbGVjdDogb3JpZ2luYWxIYW5kbGVTZWxlY3QsXHJcbiAgICAgICAgY3JlYXRlUHJldmlld05vZGU6IG9yaWdpbmFsQ3JlYXRlUHJldmlld05vZGUsXHJcbiAgICB9O1xyXG4gICAgbWluaS5oYW5kbGVTZWxlY3QgPSAodXVpZDogc3RyaW5nKSA9PiB7XHJcbiAgICAgICAgaWYgKHV1aWQpIHtcclxuICAgICAgICAgICAgc3VwcHJlc3NlZFNlbGVjdFV1aWQgPSB1dWlkO1xyXG4gICAgICAgIH1cclxuICAgIH07XHJcbiAgICBtaW5pLmNyZWF0ZVByZXZpZXdOb2RlID0gKCkgPT4gbnVsbDtcclxufVxyXG5cclxuZnVuY3Rpb24gdW5wYXRjaE1pbmlQcmV2aWV3KG1pbmk6IGFueSk6IHZvaWQge1xyXG4gICAgY29uc3Qgb3JpZ2luYWwgPSBtaW5pW01JTklfUFJFVklFV19QQVRDSF9LRVldO1xyXG4gICAgaWYgKCFvcmlnaW5hbCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChvcmlnaW5hbC5oYW5kbGVTZWxlY3QpIHtcclxuICAgICAgICBtaW5pLmhhbmRsZVNlbGVjdCA9IG9yaWdpbmFsLmhhbmRsZVNlbGVjdDtcclxuICAgIH1cclxuICAgIGlmIChvcmlnaW5hbC5jcmVhdGVQcmV2aWV3Tm9kZSkge1xyXG4gICAgICAgIG1pbmkuY3JlYXRlUHJldmlld05vZGUgPSBvcmlnaW5hbC5jcmVhdGVQcmV2aWV3Tm9kZTtcclxuICAgIH1cclxuICAgIGRlbGV0ZSBtaW5pW01JTklfUFJFVklFV19QQVRDSF9LRVldO1xyXG59XHJcblxyXG4vKipcclxuICogQHpoIOa4uOaIj+mihOiniOW8gOWQr+aXtuWOi+WItue8lui+keWZqOebuOacuuWwj+eql++8m+WFs+mXreWQjuaBouWkjeW5tueUsee8lui+keWZqOaMieW9k+WJjemAieS4remHjeaWsOW8ueWHuuOAglxyXG4gKi9cclxuZnVuY3Rpb24gc2V0RWRpdG9yTWluaVByZXZpZXdTdXBwcmVzc2VkKHN1cHByZXNzZWQ6IGJvb2xlYW4pOiB2b2lkIHtcclxuICAgIG1pbmlQcmV2aWV3U3VwcHJlc3NlZCA9IHN1cHByZXNzZWQ7XHJcbiAgICBjb25zdCBtaW5pID0gZ2V0RWRpdG9yTWluaVByZXZpZXcoKTtcclxuICAgIGlmICghbWluaSkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGlmIChzdXBwcmVzc2VkKSB7XHJcbiAgICAgICAgcGF0Y2hNaW5pUHJldmlldyhtaW5pKTtcclxuICAgICAgICBjbGVhck1pbmlQcmV2aWV3Tm9kZXMobWluaSk7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgdW5wYXRjaE1pbmlQcmV2aWV3KG1pbmkpO1xyXG4gICAgY29uc3QgdXVpZCA9IHN1cHByZXNzZWRTZWxlY3RVdWlkIHx8IG1pbmkuY3Vyck5vZGU/LnV1aWQgfHwgbnVsbDtcclxuICAgIHN1cHByZXNzZWRTZWxlY3RVdWlkID0gbnVsbDtcclxuICAgIGlmICh1dWlkICYmIHR5cGVvZiBtaW5pLmhhbmRsZVNlbGVjdCA9PT0gJ2Z1bmN0aW9uJykge1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIG1pbmkuaGFuZGxlU2VsZWN0KHV1aWQpO1xyXG4gICAgICAgIH0gY2F0Y2gge1xyXG4gICAgICAgICAgICAvLyBpZ25vcmVcclxuICAgICAgICB9XHJcbiAgICB9XHJcbn1cclxuXHJcbi8qKlxyXG4gKiBAemgg56Gu5L+d5Y6L5Yi254q25oCB5LuN55Sf5pWI77yI5Zy65pmv6YeN6L295ZCO6Z2i5YW35a6e5L6L5Y+v6IO95o2i5paw77yJ77yM5bm25riF5o6J5bey5by55Ye655qE5bCP56qX44CCXHJcbiAqL1xyXG5mdW5jdGlvbiBoaWRlRWRpdG9yTWluaVByZXZpZXcoKTogdm9pZCB7XHJcbiAgICBpZiAoIW1pbmlQcmV2aWV3U3VwcHJlc3NlZCkge1xyXG4gICAgICAgIHJldHVybjtcclxuICAgIH1cclxuICAgIGNvbnN0IG1pbmkgPSBnZXRFZGl0b3JNaW5pUHJldmlldygpO1xyXG4gICAgaWYgKCFtaW5pKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgcGF0Y2hNaW5pUHJldmlldyhtaW5pKTtcclxuICAgIGNsZWFyTWluaVByZXZpZXdOb2RlcyhtaW5pKTtcclxufVxyXG5cclxuZnVuY3Rpb24gZW5jb2RlVG9EYXRhVXJsKHBpeGVsczogVWludDhBcnJheSwgd2lkdGg6IG51bWJlciwgaGVpZ2h0OiBudW1iZXIsIHF1YWxpdHk6IG51bWJlcik6IHN0cmluZyB7XHJcbiAgICBjb25zdCBjYW52YXMgPSBlbnN1cmVFbmNvZGVDYW52YXMod2lkdGgsIGhlaWdodCk7XHJcbiAgICBjb25zdCBjb250ZXh0ID0gY2FudmFzLmdldENvbnRleHQoJzJkJyk7XHJcbiAgICBpZiAoIWNvbnRleHQpIHtcclxuICAgICAgICByZXR1cm4gJyc7XHJcbiAgICB9XHJcbiAgICBpZiAoIWVuY29kZUltYWdlRGF0YSB8fCBlbmNvZGVJbWFnZURhdGEud2lkdGggIT09IHdpZHRoIHx8IGVuY29kZUltYWdlRGF0YS5oZWlnaHQgIT09IGhlaWdodCkge1xyXG4gICAgICAgIGVuY29kZUltYWdlRGF0YSA9IGNvbnRleHQuY3JlYXRlSW1hZ2VEYXRhKHdpZHRoLCBoZWlnaHQpO1xyXG4gICAgfVxyXG4gICAgY29uc3QgaW1hZ2VEYXRhID0gZW5jb2RlSW1hZ2VEYXRhO1xyXG4gICAgY29uc3Qgcm93Qnl0ZXMgPSB3aWR0aCAqIDQ7XHJcbiAgICBjb25zdCBkc3QgPSBpbWFnZURhdGEuZGF0YTtcclxuICAgIGZvciAobGV0IHJvdyA9IDA7IHJvdyA8IGhlaWdodDsgcm93KyspIHtcclxuICAgICAgICBjb25zdCBzdGFydCA9IChoZWlnaHQgLSByb3cgLSAxKSAqIHJvd0J5dGVzO1xyXG4gICAgICAgIGRzdC5zZXQocGl4ZWxzLnN1YmFycmF5KHN0YXJ0LCBzdGFydCArIHJvd0J5dGVzKSwgcm93ICogcm93Qnl0ZXMpO1xyXG4gICAgfVxyXG4gICAgY29udGV4dC5wdXRJbWFnZURhdGEoaW1hZ2VEYXRhLCAwLCAwKTtcclxuICAgIHJldHVybiBjYW52YXMudG9EYXRhVVJMKCdpbWFnZS9qcGVnJywgcXVhbGl0eSk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIHBpeGVsc1VuY2hhbmdlZChwaXhlbHM6IFVpbnQ4QXJyYXkpOiBib29sZWFuIHtcclxuICAgIGlmICghbGFzdEZyYW1lUGl4ZWxzIHx8IGxhc3RGcmFtZVBpeGVscy5sZW5ndGggIT09IHBpeGVscy5sZW5ndGgpIHtcclxuICAgICAgICByZXR1cm4gZmFsc2U7XHJcbiAgICB9XHJcbiAgICBjb25zdCBwcmV2ID0gbGFzdEZyYW1lUGl4ZWxzO1xyXG4gICAgLy8gOE1CIOmHj+e6p+mAkOWtl+iKguavlOi+g+i/nOavlCBKUEVHIOe8lueggeS+v+WunFxyXG4gICAgZm9yIChsZXQgaSA9IDA7IGkgPCBwaXhlbHMubGVuZ3RoOyBpKyspIHtcclxuICAgICAgICBpZiAocGl4ZWxzW2ldICE9PSBwcmV2W2ldKSB7XHJcbiAgICAgICAgICAgIHJldHVybiBmYWxzZTtcclxuICAgICAgICB9XHJcbiAgICB9XHJcbiAgICByZXR1cm4gdHJ1ZTtcclxufVxyXG5cclxuZnVuY3Rpb24gcmVtZW1iZXJGcmFtZVBpeGVscyhwaXhlbHM6IFVpbnQ4QXJyYXkpOiB2b2lkIHtcclxuICAgIGlmICghbGFzdEZyYW1lUGl4ZWxzIHx8IGxhc3RGcmFtZVBpeGVscy5sZW5ndGggIT09IHBpeGVscy5sZW5ndGgpIHtcclxuICAgICAgICBsYXN0RnJhbWVQaXhlbHMgPSBuZXcgVWludDhBcnJheShwaXhlbHMubGVuZ3RoKTtcclxuICAgIH1cclxuICAgIGxhc3RGcmFtZVBpeGVscy5zZXQocGl4ZWxzKTtcclxufVxyXG5cclxuZnVuY3Rpb24gbWF5YmVIZWFsR2FtZUNhbWVyYXMoKTogdm9pZCB7XHJcbiAgICBjb25zdCBub3cgPSBEYXRlLm5vdygpO1xyXG4gICAgaWYgKG5vdyA8IGhlYWxUaHJvdHRsZVVudGlsKSB7XHJcbiAgICAgICAgcmV0dXJuO1xyXG4gICAgfVxyXG4gICAgaGVhbFRocm90dGxlVW50aWwgPSBub3cgKyAyMDAwO1xyXG4gICAgaGVhbEdhbWVDYW1lcmFXaW5kb3dzKCk7XHJcbn1cclxuXHJcbmZ1bmN0aW9uIGNsZWFyU2Vzc2lvbigpOiB2b2lkIHtcclxuICAgIHNldFByZXZpZXdDYW1lcmFzRW5hYmxlZChmYWxzZSk7XHJcbiAgICBkZXN0cm95UHJldmlld0NhbWVyYXMoKTtcclxuICAgIGRlc3Ryb3lSZW5kZXJUZXh0dXJlKCk7XHJcbiAgICBwaXhlbEJ1ZmZlciA9IG51bGw7XHJcbiAgICBsYXN0RnJhbWVQaXhlbHMgPSBudWxsO1xyXG4gICAgZW5jb2RlSW1hZ2VEYXRhID0gbnVsbDtcclxufVxyXG5cclxuZXhwb3J0IGNvbnN0IG1ldGhvZHMgPSB7XHJcbiAgICBxdWVyeUNhbWVyYXMoKTogSUNhbWVyYUluZm9bXSB7XHJcbiAgICAgICAgcmV0dXJuIGdldFNjZW5lQ2FtZXJhcygpLm1hcCgoY2FtZXJhKSA9PiAoe1xyXG4gICAgICAgICAgICB1dWlkOiBjYW1lcmEubm9kZS51dWlkLFxyXG4gICAgICAgICAgICBuYW1lOiBjYW1lcmEubm9kZS5uYW1lLFxyXG4gICAgICAgICAgICBwYXRoOiBnZXROb2RlUGF0aChjYW1lcmEubm9kZSksXHJcbiAgICAgICAgICAgIHByaW9yaXR5OiBjYW1lcmEucHJpb3JpdHksXHJcbiAgICAgICAgICAgIGVuYWJsZWQ6IGNhbWVyYS5lbmFibGVkSW5IaWVyYXJjaHksXHJcbiAgICAgICAgfSkpO1xyXG4gICAgfSxcclxuXHJcbiAgICAvKipcclxuICAgICAqIEB6aCDmuLjmiI/pooTop4jlvIDlhbPml7bosIPnlKjvvJrlvIDlkK/liJnmi6bmiKogTWluaVByZXZpZXcg5Yib5bu65bCP56qX77yb5YWz6Zet5YiZ5oGi5aSN44CCXHJcbiAgICAgKi9cclxuICAgIHNldE1pbmlQcmV2aWV3U3VwcHJlc3NlZChzdXBwcmVzc2VkOiBib29sZWFuKTogdm9pZCB7XHJcbiAgICAgICAgc2V0RWRpdG9yTWluaVByZXZpZXdTdXBwcmVzc2VkKCEhc3VwcHJlc3NlZCk7XHJcbiAgICB9LFxyXG5cclxuICAgIC8qKiDnoa7kv53ljovliLbku43nlJ/mlYjlubbmuIXmjonlt7LlvLnlh7rnmoTlsI/nqpfvvIjpgInkuK0gQ2FtZXJhIOWQjueahOWFnOW6le+8ieOAgiAqL1xyXG4gICAgaGlkZUVkaXRvck1pbmlQcmV2aWV3KCk6IHZvaWQge1xyXG4gICAgICAgIGhpZGVFZGl0b3JNaW5pUHJldmlldygpO1xyXG4gICAgfSxcclxuXHJcbiAgICAvKipcclxuICAgICAqIEB6aCDluLjpqbvku6PnkIbnm7jmnLogKyDljZXmrKEgcmVwYWludCDor7vlm57jgILluKfpl7TnpoHnlKjku6PnkIbnm7jmnLrvvIzpgb/lhY3mi5bmi73lnLrmma/ml7bmr4/luKflpJrnlLvkuIDot6/jgIJcclxuICAgICAqL1xyXG4gICAgYXN5bmMgY2FwdHVyZShvcHRpb25zOiBJQ2FwdHVyZU9wdGlvbnMpOiBQcm9taXNlPElDYXB0dXJlUmVzdWx0IHwgbnVsbD4ge1xyXG4gICAgICAgIGlmICghaXNSZW5kZXJlclJlYWR5KCkpIHtcclxuICAgICAgICAgICAgcmV0dXJuIG51bGw7XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCB3aWR0aCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQob3B0aW9ucy53aWR0aCkpO1xyXG4gICAgICAgIGNvbnN0IGhlaWdodCA9IE1hdGgubWF4KDEsIE1hdGgucm91bmQob3B0aW9ucy5oZWlnaHQpKTtcclxuICAgICAgICBjb25zdCB0YXJnZXRzID0gcmVzb2x2ZVRhcmdldHMob3B0aW9ucyk7XHJcbiAgICAgICAgaWYgKHRhcmdldHMubGVuZ3RoID09PSAwKSB7XHJcbiAgICAgICAgICAgIGlmIChoYXNQcmV2aWV3U2Vzc2lvbigpKSB7XHJcbiAgICAgICAgICAgICAgICBjbGVhclNlc3Npb24oKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZXR1cm4geyB3aWR0aCwgaGVpZ2h0LCBjYW1lcmFDb3VudDogMCB9O1xyXG4gICAgICAgIH1cclxuXHJcbiAgICAgICAgbWF5YmVIZWFsR2FtZUNhbWVyYXMoKTtcclxuXHJcbiAgICAgICAgY29uc3QgdGV4dHVyZSA9IGVuc3VyZVJlbmRlclRleHR1cmUod2lkdGgsIGhlaWdodCk7XHJcbiAgICAgICAgaWYgKCF0ZXh0dXJlLndpbmRvdykge1xyXG4gICAgICAgICAgICByZXR1cm4gbnVsbDtcclxuICAgICAgICB9XHJcblxyXG4gICAgICAgIGNvbnN0IGNhbWVyYUNvdW50ID0gZW5zdXJlUHJldmlld0NhbWVyYXModGFyZ2V0cywgdGV4dHVyZSk7XHJcbiAgICAgICAgaWYgKGNhbWVyYUNvdW50ID09PSAwKSB7XHJcbiAgICAgICAgICAgIHJldHVybiB7IHdpZHRoLCBoZWlnaHQsIGNhbWVyYUNvdW50OiAwIH07XHJcbiAgICAgICAgfVxyXG5cclxuICAgICAgICBjb25zdCB0b2tlbiA9ICsrY2FwdHVyZUdlbmVyYXRpb247XHJcbiAgICAgICAgc2V0UHJldmlld0NhbWVyYXNFbmFibGVkKHRydWUpO1xyXG4gICAgICAgIHRyeSB7XHJcbiAgICAgICAgICAgIGNvbnN0IGRyYXduID0gYXdhaXQgd2FpdEZvckRyYXcoKTtcclxuICAgICAgICAgICAgaWYgKCFkcmF3biB8fCB0b2tlbiAhPT0gY2FwdHVyZUdlbmVyYXRpb24pIHtcclxuICAgICAgICAgICAgICAgIHJldHVybiBudWxsO1xyXG4gICAgICAgICAgICB9XHJcblxyXG4gICAgICAgICAgICBjb25zdCBwaXhlbHMgPSBlbnN1cmVQaXhlbEJ1ZmZlcih3aWR0aCAqIGhlaWdodCAqIDQpO1xyXG4gICAgICAgICAgICB0ZXh0dXJlLnJlYWRQaXhlbHMoMCwgMCwgd2lkdGgsIGhlaWdodCwgcGl4ZWxzKTtcclxuXHJcbiAgICAgICAgICAgIC8vIOWcuuaZr+mdmeatouaXtui3s+i/hyBKUEVHICsg5aSn5a2X56ym5LiyIElQQ++8iENQVSDlpKflpLTvvInvvIxHUFUg6K+75Zue5LuN5L+d55WZ5Lul5L+d6K+B5YaF5a655Y+Y5pu06IO95qOA5Ye6XHJcbiAgICAgICAgICAgIGlmIChwaXhlbHNVbmNoYW5nZWQocGl4ZWxzKSkge1xyXG4gICAgICAgICAgICAgICAgcmV0dXJuIHtcclxuICAgICAgICAgICAgICAgICAgICB1bmNoYW5nZWQ6IHRydWUsXHJcbiAgICAgICAgICAgICAgICAgICAgd2lkdGgsXHJcbiAgICAgICAgICAgICAgICAgICAgaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgICAgIGNhbWVyYUNvdW50LFxyXG4gICAgICAgICAgICAgICAgfTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgICAgICByZW1lbWJlckZyYW1lUGl4ZWxzKHBpeGVscyk7XHJcblxyXG4gICAgICAgICAgICByZXR1cm4ge1xyXG4gICAgICAgICAgICAgICAgZGF0YVVybDogZW5jb2RlVG9EYXRhVXJsKHBpeGVscywgd2lkdGgsIGhlaWdodCwgb3B0aW9ucy5xdWFsaXR5KSxcclxuICAgICAgICAgICAgICAgIHdpZHRoLFxyXG4gICAgICAgICAgICAgICAgaGVpZ2h0LFxyXG4gICAgICAgICAgICAgICAgY2FtZXJhQ291bnQsXHJcbiAgICAgICAgICAgIH07XHJcbiAgICAgICAgfSBmaW5hbGx5IHtcclxuICAgICAgICAgICAgaWYgKHRva2VuID09PSBjYXB0dXJlR2VuZXJhdGlvbikge1xyXG4gICAgICAgICAgICAgICAgc2V0UHJldmlld0NhbWVyYXNFbmFibGVkKGZhbHNlKTtcclxuICAgICAgICAgICAgfVxyXG4gICAgICAgIH1cclxuICAgIH0sXHJcblxyXG4gICAgc3RvcCgpOiB2b2lkIHtcclxuICAgICAgICBjYXB0dXJlR2VuZXJhdGlvbiArPSAxO1xyXG4gICAgICAgIHNldHRsZURyYXdXYWl0Py4oKTtcclxuICAgICAgICBjbGVhclNlc3Npb24oKTtcclxuICAgICAgICBpZiAoZ2V0U2NlbmVDYW1lcmFzKCkubGVuZ3RoID09PSAwIHx8ICFpc1JlbmRlcmVyUmVhZHkoKSkge1xyXG4gICAgICAgICAgICByZXR1cm47XHJcbiAgICAgICAgfVxyXG4gICAgICAgIGhlYWxHYW1lQ2FtZXJhV2luZG93cygpO1xyXG4gICAgICAgIHJlcXVlc3RSZXBhaW50KCk7XHJcbiAgICB9LFxyXG59O1xyXG5cclxuZXhwb3J0IGZ1bmN0aW9uIGxvYWQoKSB7XHJcbiAgICBkaXJlY3Rvci5vbihEaXJlY3Rvci5FVkVOVF9CRUZPUkVfU0NFTkVfTE9BRElORywgb25TY2VuZVdpbGxDaGFuZ2UpO1xyXG4gICAgZGlyZWN0b3Iub24oRGlyZWN0b3IuRVZFTlRfQkVGT1JFX1NDRU5FX0xBVU5DSCwgb25TY2VuZVdpbGxDaGFuZ2UpO1xyXG4gICAgaGVhbEdhbWVDYW1lcmFXaW5kb3dzKCk7XHJcbn1cclxuXHJcbmV4cG9ydCBmdW5jdGlvbiB1bmxvYWQoKSB7XHJcbiAgICBkaXJlY3Rvci5vZmYoRGlyZWN0b3IuRVZFTlRfQkVGT1JFX1NDRU5FX0xPQURJTkcsIG9uU2NlbmVXaWxsQ2hhbmdlKTtcclxuICAgIGRpcmVjdG9yLm9mZihEaXJlY3Rvci5FVkVOVF9CRUZPUkVfU0NFTkVfTEFVTkNILCBvblNjZW5lV2lsbENoYW5nZSk7XHJcbiAgICBjYXB0dXJlR2VuZXJhdGlvbiArPSAxO1xyXG4gICAgc2V0dGxlRHJhd1dhaXQ/LigpO1xyXG4gICAgc2V0RWRpdG9yTWluaVByZXZpZXdTdXBwcmVzc2VkKGZhbHNlKTtcclxuICAgIGNsZWFyU2Vzc2lvbigpO1xyXG4gICAgaGVhbEdhbWVDYW1lcmFXaW5kb3dzKCk7XHJcbiAgICBlbmNvZGVDYW52YXMgPSBudWxsO1xyXG59XHJcbiJdfQ==
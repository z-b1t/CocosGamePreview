import './engine-path';
import { CCObject, Camera, Color, Director, Node, Rect, RenderTexture, director, gfx } from 'cc';
import type { ICameraInfo, ICaptureOptions, ICaptureResult } from './types';

let renderTexture: RenderTexture | null = null;
let encodeCanvas: HTMLCanvasElement | null = null;
let encodeImageData: ImageData | null = null;
let pixelBuffer: Uint8Array | null = null;
/** 上一帧像素副本，用于跳过无变化时的 JPEG 编码与 IPC。 */
let lastFramePixels: Uint8Array | null = null;
/** 仅用于预览的临时相机节点，绝不改动场景里原有 Camera 的渲染目标。 */
let previewNodes: Node[] = [];
/** 与 previewNodes 一一对应的源相机 uuid，用于判断是否需要重建。 */
let previewSourceUuids: string[] = [];
let healThrottleUntil = 0;

const EDITOR_CAMERA_NODE_NAMES = new Set(['Editor Scene Background', 'Scene Gizmo Camera']);
const PREVIEW_NODE_NAME = '__CameraPreviewProxy__';

function isRendererReady(): boolean {
    const root = director.root;
    return !!root?.mainWindow && !!root.pipeline && root.device.swapchainFormat !== gfx.Format.UNKNOWN;
}

function getTempWindow(): any | null {
    return (director.root as any)?.tempWindow ?? null;
}

/**
 * @zh 编辑期游戏相机会挂在 root.tempWindow 上。
 * 旧版本插件若把相机摘成 window=null，这里尽量补回，避免编辑器相机小窗持续报错。
 */
function healGameCameraWindows(): void {
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
        } catch {
            // 忽略个别已销毁相机
        }
    }
}

function getSceneCameras(): Camera[] {
    const scene = director.getScene();
    if (!scene) {
        return [];
    }
    return scene
        .getComponentsInChildren(Camera)
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

function getNodePath(node: Node): string {
    const names: string[] = [];
    let current: Node | null = node;
    while (current && current.parent) {
        names.unshift(current.name);
        current = current.parent;
    }
    return names.join('/');
}

function setPreviewCamerasEnabled(enabled: boolean): void {
    for (const node of previewNodes) {
        if (!node.isValid) {
            continue;
        }
        const camera = node.getComponent(Camera);
        if (camera) {
            camera.enabled = enabled;
        }
    }
}

function destroyPreviewCameras(): void {
    for (const node of previewNodes) {
        try {
            if (node.isValid) {
                const camera = node.getComponent(Camera);
                if (camera) {
                    camera.targetTexture = null;
                }
                node.destroy();
            }
        } catch {
            // 场景切换时节点可能已失效
        }
    }
    previewNodes = [];
    previewSourceUuids = [];
}

function ensureRenderTexture(width: number, height: number): RenderTexture {
    if (!renderTexture) {
        const texture = new RenderTexture();
        texture.reset({ width, height });
        renderTexture = texture;
    } else if (renderTexture.width !== width || renderTexture.height !== height) {
        destroyPreviewCameras();
        renderTexture.resize(width, height);
    }
    return renderTexture;
}

function destroyRenderTexture(): void {
    destroyPreviewCameras();
    if (!renderTexture) {
        return;
    }
    renderTexture.destroy();
    renderTexture = null;
}

function ensureEncodeCanvas(width: number, height: number): HTMLCanvasElement {
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

function ensurePixelBuffer(size: number): Uint8Array {
    if (!pixelBuffer || pixelBuffer.length !== size) {
        pixelBuffer = new Uint8Array(size);
    }
    return pixelBuffer;
}

function copyCameraSettings(source: Camera, target: Camera): void {
    target.priority = source.priority;
    target.visibility = source.visibility;
    target.clearFlags = source.clearFlags;
    target.clearColor = new Color(source.clearColor.r, source.clearColor.g, source.clearColor.b, source.clearColor.a);
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
    target.rect = new Rect(rect.x, rect.y, rect.width, rect.height);
}

function syncProxyNode(source: Camera, node: Node): void {
    node.layer = source.node.layer;
    node.setWorldPosition(source.node.worldPosition);
    node.setWorldRotation(source.node.worldRotation);
    node.setWorldScale(source.node.worldScale);
    const camera = node.getComponent(Camera);
    if (camera) {
        copyCameraSettings(source, camera);
        camera.targetTexture = renderTexture;
    }
}

/**
 * @zh 创建与源相机同姿态/同参数的临时 Camera，只把它们的 targetTexture 指到预览贴图。
 * 这样完全不调用场景相机的 changeTargetWindow，编辑器相机小窗不会被抢走。
 */
function createPreviewCameras(sources: Camera[], texture: RenderTexture): number {
    destroyPreviewCameras();
    const scene = director.getScene();
    if (!scene) {
        return 0;
    }

    for (const source of sources) {
        if (!source.isValid || !source.node?.isValid) {
            continue;
        }
        const node = new Node(PREVIEW_NODE_NAME);
        node.hideFlags |= CCObject.Flags.DontSave | CCObject.Flags.HideInHierarchy;
        node.layer = source.node.layer;
        scene.addChild(node);
        node.setWorldPosition(source.node.worldPosition);
        node.setWorldRotation(source.node.worldRotation);
        node.setWorldScale(source.node.worldScale);

        const camera = node.addComponent(Camera);
        copyCameraSettings(source, camera);
        camera.targetTexture = texture;
        camera.enabled = false;
        previewNodes.push(node);
        previewSourceUuids.push(source.node.uuid);
    }
    return previewNodes.length;
}

function sourceListMatches(sources: Camera[]): boolean {
    if (sources.length !== previewSourceUuids.length || sources.length !== previewNodes.length) {
        return false;
    }
    for (let i = 0; i < sources.length; i++) {
        if (!sources[i].isValid || sources[i].node.uuid !== previewSourceUuids[i]) {
            return false;
        }
        if (!previewNodes[i]?.isValid) {
            return false;
        }
    }
    return true;
}

function ensurePreviewCameras(sources: Camera[], texture: RenderTexture): number {
    if (sourceListMatches(sources)) {
        for (let i = 0; i < sources.length; i++) {
            syncProxyNode(sources[i], previewNodes[i]);
        }
        return previewNodes.length;
    }
    return createPreviewCameras(sources, texture);
}

function resolveTargets(options: ICaptureOptions): Camera[] {
    const cameras = getSceneCameras();
    if (options.mode === 'single') {
        const target = cameras.find((camera) => camera.node.uuid === options.cameraUuid);
        return target ? [target] : [];
    }
    return cameras
        .filter((camera) => camera.enabledInHierarchy && !camera.targetTexture)
        .sort((a, b) => a.priority - b.priority);
}

function requestRepaint(): void {
    const editorScene = (globalThis as any).cce;
    editorScene?.Engine?.repaintInEditMode?.();
}

const MINI_PREVIEW_PATCH_KEY = '__gamePreviewMiniPatch__';

/** 游戏预览开启期间压制编辑器 MiniPreview，避免选中 Camera 时抢渲染/打断 capture。 */
let miniPreviewSuppressed = false;
/** 压制期间记录选中的节点，关闭游戏预览后用于恢复小窗。 */
let suppressedSelectUuid: string | null = null;

/**
 * @zh 拿到编辑器内置的相机小窗（MiniPreview）管理器。
 */
function getEditorMiniPreview(): any | null {
    const cce = (globalThis as any).cce;
    if (!cce) {
        return null;
    }
    const fromFacade = cce.SceneFacadeManager?.getCurrentFacade?.()?._miniPreviewMgr;
    if (fromFacade) {
        return fromFacade;
    }
    return cce.Preview?.miniPreview || cce.previewMgr?.miniPreview || null;
}

/**
 * @zh 清掉 MiniPreview 已创建的预览节点，不调用 handleUnselect（避免误伤层级选中）。
 */
function clearMiniPreviewNodes(mini: any): void {
    try {
        const curr = mini.currNode;
        if (curr?.uuid) {
            suppressedSelectUuid = curr.uuid;
        }
    } catch {
        // ignore
    }
    try {
        const nodes = mini.previewNodes;
        if (!nodes) {
            return;
        }
        const values: any[] = nodes instanceof Map
            ? Array.from(nodes.values())
            : Array.isArray(nodes)
                ? [...nodes]
                : Object.values(nodes);
        for (const value of values) {
            const camera = value?.cameraComponent || value?.camera || value;
            if (camera && typeof mini.removePreviewNode === 'function') {
                mini.removePreviewNode(camera);
            }
        }
    } catch {
        // ignore
    }
}

function patchMiniPreview(mini: any): void {
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
    mini.handleSelect = (uuid: string) => {
        if (uuid) {
            suppressedSelectUuid = uuid;
        }
    };
    mini.createPreviewNode = () => null;
}

function unpatchMiniPreview(mini: any): void {
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
function setEditorMiniPreviewSuppressed(suppressed: boolean): void {
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
    const uuid = suppressedSelectUuid || mini.currNode?.uuid || null;
    suppressedSelectUuid = null;
    if (uuid && typeof mini.handleSelect === 'function') {
        try {
            mini.handleSelect(uuid);
        } catch {
            // ignore
        }
    }
}

/**
 * @zh 确保压制状态仍生效（场景重载后面具实例可能换新），并清掉已弹出的小窗。
 */
function hideEditorMiniPreview(): void {
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

function encodeToDataUrl(pixels: Uint8Array, width: number, height: number, quality: number): string {
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

function pixelsUnchanged(pixels: Uint8Array): boolean {
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

function rememberFramePixels(pixels: Uint8Array): void {
    if (!lastFramePixels || lastFramePixels.length !== pixels.length) {
        lastFramePixels = new Uint8Array(pixels.length);
    }
    lastFramePixels.set(pixels);
}

function maybeHealGameCameras(): void {
    const now = Date.now();
    if (now < healThrottleUntil) {
        return;
    }
    healThrottleUntil = now + 2000;
    healGameCameraWindows();
}

function clearSession(): void {
    setPreviewCamerasEnabled(false);
    destroyPreviewCameras();
    destroyRenderTexture();
    pixelBuffer = null;
    lastFramePixels = null;
    encodeImageData = null;
}

export const methods = {
    queryCameras(): ICameraInfo[] {
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
    setMiniPreviewSuppressed(suppressed: boolean): void {
        setEditorMiniPreviewSuppressed(!!suppressed);
    },

    /** 确保压制仍生效并清掉已弹出的小窗（选中 Camera 后的兜底）。 */
    hideEditorMiniPreview(): void {
        hideEditorMiniPreview();
    },

    /**
     * @zh 常驻代理相机 + 单次 repaint 读回。帧间禁用代理相机，避免拖拽场景时每帧多画一路。
     */
    async capture(options: ICaptureOptions): Promise<ICaptureResult | null> {
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
            await new Promise<void>((resolve) => {
                director.once(Director.EVENT_AFTER_DRAW, resolve);
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
        } finally {
            // 帧间关掉代理相机，不销毁；不再二次 repaint，避免拖死场景编辑器
            setPreviewCamerasEnabled(false);
        }
    },

    stop(): void {
        clearSession();
        healGameCameraWindows();
        requestRepaint();
    },
};

export function load() {
    healGameCameraWindows();
}

export function unload() {
    setEditorMiniPreviewSuppressed(false);
    clearSession();
    healGameCameraWindows();
    encodeCanvas = null;
}

import './engine-path';
import { CCObject, Camera, Color, Director, Node, Rect, RenderTexture, director, gfx } from 'cc';
import type { ICameraInfo, ICaptureOptions, ICaptureResult } from './types';

let renderTexture: RenderTexture | null = null;
let encodeCanvas: HTMLCanvasElement | null = null;
/** 仅用于预览的临时相机节点，绝不改动场景里原有 Camera 的渲染目标。 */
let previewNodes: Node[] = [];

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
            // 跳过本插件自己的临时预览相机
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
}

function ensureRenderTexture(width: number, height: number): RenderTexture {
    if (!renderTexture) {
        const texture = new RenderTexture();
        texture.reset({ width, height });
        renderTexture = texture;
    } else if (renderTexture.width !== width || renderTexture.height !== height) {
        // 先拆掉预览相机，避免 resize 时仍挂在旧 Framebuffer 上
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
    }
    return encodeCanvas;
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
        // 不进层级、不进存档，避免污染场景资源
        node.hideFlags |= CCObject.Flags.DontSave | CCObject.Flags.HideInHierarchy;
        node.layer = source.node.layer;
        scene.addChild(node);
        node.setWorldPosition(source.node.worldPosition);
        node.setWorldRotation(source.node.worldRotation);
        node.setWorldScale(source.node.worldScale);

        const camera = node.addComponent(Camera);
        copyCameraSettings(source, camera);
        // 走组件官方路径绑定 RenderTexture，只影响这个临时相机
        camera.targetTexture = texture;
        previewNodes.push(node);
    }
    return previewNodes.length;
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
    // 仍记录选中 uuid，但不创建小窗预览相机，避免和游戏预览抢渲染
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
    const imageData = context.createImageData(width, height);
    const rowBytes = width * 4;
    for (let row = 0; row < height; row++) {
        const start = (height - row - 1) * rowBytes;
        imageData.data.set(pixels.subarray(start, start + rowBytes), row * rowBytes);
    }
    context.putImageData(imageData, 0, 0);
    return canvas.toDataURL('image/jpeg', quality);
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

    async capture(options: ICaptureOptions): Promise<ICaptureResult | null> {
        if (!isRendererReady()) {
            return null;
        }
        // 兼容旧逻辑可能留下的 window=null 相机
        healGameCameraWindows();

        const width = Math.max(1, Math.round(options.width));
        const height = Math.max(1, Math.round(options.height));
        const cameras = getSceneCameras();

        let targets: Camera[];
        if (options.mode === 'single') {
            const target = cameras.find((camera) => camera.node.uuid === options.cameraUuid);
            targets = target ? [target] : [];
        } else {
            targets = cameras
                .filter((camera) => camera.enabledInHierarchy && !camera.targetTexture)
                .sort((a, b) => a.priority - b.priority);
        }
        if (targets.length === 0) {
            destroyPreviewCameras();
            return null;
        }

        const texture = ensureRenderTexture(width, height);
        if (!texture.window) {
            return null;
        }

        const cameraCount = createPreviewCameras(targets, texture);
        if (cameraCount === 0) {
            return null;
        }

        try {
            await new Promise<void>((resolve) => {
                director.once(Director.EVENT_AFTER_DRAW, resolve);
                requestRepaint();
            });

            const pixels = new Uint8Array(width * height * 4);
            texture.readPixels(0, 0, width, height, pixels);
            return {
                dataUrl: encodeToDataUrl(pixels, width, height, options.quality),
                width,
                height,
                cameraCount,
            };
        } finally {
            destroyPreviewCameras();
            // 再补一次，确保编辑器侧相机窗口状态干净
            healGameCameraWindows();
            requestRepaint();
        }
    },

    stop(): void {
        destroyPreviewCameras();
        destroyRenderTexture();
        healGameCameraWindows();
        requestRepaint();
    },
};

export function load() {
    healGameCameraWindows();
}

export function unload() {
    setEditorMiniPreviewSuppressed(false);
    destroyPreviewCameras();
    destroyRenderTexture();
    healGameCameraWindows();
    encodeCanvas = null;
}

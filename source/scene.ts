import './engine-path';
import { Camera, Director, Node, RenderTexture, director, gfx, renderer } from 'cc';
import type { ICameraInfo, ICaptureOptions, ICaptureResult } from './types';

interface IAttachedCamera {
    component: Camera;
    renderer: renderer.scene.Camera;
    window: any;
    enabled: boolean;
    width: number;
    height: number;
}

let renderTexture: RenderTexture | null = null;
let encodeCanvas: HTMLCanvasElement | null = null;
let attachedCameras: IAttachedCamera[] = [];
let attachedKey = '';

const EDITOR_CAMERA_NODE_NAMES = new Set(['Editor Scene Background', 'Scene Gizmo Camera']);

function isRendererReady(): boolean {
    const root = director.root;
    return !!root?.mainWindow && !!root.pipeline && root.device.swapchainFormat !== gfx.Format.UNKNOWN;
}

function getSceneCameras(): Camera[] {
    const scene = director.getScene();
    if (!scene) {
        return [];
    }
    // 编辑器把场景视图的内部渲染相机也挂在当前场景中，预览时不能接管它们。
    return scene
        .getComponentsInChildren(Camera)
        .filter((camera) => !EDITOR_CAMERA_NODE_NAMES.has(camera.node.name));
}

function getNodePath(node: Node): string {
    const names: string[] = [];
    let current: Node | null = node;
    // 场景节点本身不计入路径
    while (current && current.parent) {
        names.unshift(current.name);
        current = current.parent;
    }
    return names.join('/');
}

function ensureRenderTexture(width: number, height: number): RenderTexture {
    if (!renderTexture) {
        const texture = new RenderTexture();
        texture.reset({ width, height });
        renderTexture = texture;
    } else if (renderTexture.width !== width || renderTexture.height !== height) {
        // reset 会销毁并重建底层 RenderWindow；相机仍挂载时可能产生无附件的 Framebuffer。
        renderTexture.resize(width, height);
    }
    return renderTexture;
}

function destroyRenderTexture(): void {
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

/**
 * @zh 编辑期场景相机是被编辑器从渲染窗口上摘掉的（window 为 null），
 * 这里把它们挂到预览贴图自己的窗口上，交给引擎正常的帧循环去渲染，
 * 不去手动驱动渲染管线，也不改动相机组件上的任何序列化属性。
 */
function detachCameras(): void {
    for (const item of attachedCameras) {
        const camera = item.renderer;
        try {
            if (item.window) {
                camera.changeTargetWindow(item.window);
            } else {
                camera.detachCamera();
                camera.window = item.window;
            }
            camera.enabled = item.enabled;
            camera.resize(item.width, item.height);
        } catch (error) {
            // 场景切换时相机可能已经被销毁，还原失败可以忽略
        }
    }
    attachedCameras = [];
    attachedKey = '';
    requestRepaint();
}

function attachCameras(targets: Camera[], texture: RenderTexture): void {
    const window = texture.window;
    if (!window) {
        throw new Error('camera-preview: render texture window is unavailable');
    }
    for (const component of targets) {
        const camera = component.camera;
        if (!camera) {
            continue;
        }
        attachedCameras.push({
            component,
            renderer: camera,
            window: camera.window || null,
            enabled: camera.enabled,
            width: camera.width,
            height: camera.height,
        });
        camera.changeTargetWindow(window);
        camera.enabled = true;
    }
}

function ensureAttached(targets: Camera[], texture: RenderTexture, key: string): void {
    const stillValid =
        attachedCameras.length > 0 &&
        attachedCameras.every((item) => item.component.isValid && item.component.camera === item.renderer);
    if (key === attachedKey && stillValid) {
        return;
    }
    detachCameras();
    attachCameras(targets, texture);
    attachedKey = key;
}

/**
 * @zh 编辑模式下引擎是按需重绘的，主动请求一帧，否则预览会停在旧画面上。
 */
function requestRepaint(): void {
    const editorScene = (globalThis as any).cce;
    editorScene?.Engine?.repaintInEditMode?.();
}

function encodeToDataUrl(pixels: Uint8Array, width: number, height: number, quality: number): string {
    const canvas = ensureEncodeCanvas(width, height);
    const context = canvas.getContext('2d');
    if (!context) {
        return '';
    }
    const imageData = context.createImageData(width, height);
    const rowBytes = width * 4;
    // readPixels 的原点在左下角，逐行翻转成 canvas 的左上角原点
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

    async capture(options: ICaptureOptions): Promise<ICaptureResult | null> {
        // scene:ready 可能早于编辑器交换链和渲染管线就绪，过早创建 RenderTexture 会得到无附件的 Framebuffer。
        if (!isRendererReady()) {
            return null;
        }
        const width = Math.max(1, Math.round(options.width));
        const height = Math.max(1, Math.round(options.height));
        const cameras = getSceneCameras();

        let targets: Camera[];
        if (options.mode === 'single') {
            const target = cameras.find((camera) => camera.node.uuid === options.cameraUuid);
            targets = target ? [target] : [];
        } else {
            // 和运行时一致：所有启用的相机按 priority 从低到高叠加，已经占用目标贴图的相机是业务自己在用的，跳过
            targets = cameras
                .filter((camera) => camera.enabledInHierarchy && !camera.targetTexture)
                .sort((a, b) => a.priority - b.priority);
        }
        if (targets.length === 0) {
            detachCameras();
            return null;
        }

        const texture = ensureRenderTexture(width, height);
        const key = `${options.mode}|${width}x${height}|${targets.map((camera) => camera.node.uuid).join(',')}`;
        ensureAttached(targets, texture, key);
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
            cameraCount: attachedCameras.length,
        };
    },

    stop(): void {
        detachCameras();
        destroyRenderTexture();
    },
};

export function load() {}

export function unload() {
    detachCameras();
    destroyRenderTexture();
    encodeCanvas = null;
}

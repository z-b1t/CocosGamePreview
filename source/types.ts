/**
 * @zh 面板进程与场景进程之间传递的数据结构，全部保持为纯 JSON。
 */

export type PreviewMode = 'all' | 'single';

export interface ICameraInfo {
    uuid: string;
    name: string;
    path: string;
    priority: number;
    enabled: boolean;
}

export interface ICaptureOptions {
    mode: PreviewMode;
    cameraUuid: string;
    width: number;
    height: number;
    quality: number;
}

export interface ICaptureResult {
    /** 画面有变化时才带图；unchanged 时省略以省 IPC。 */
    dataUrl?: string;
    /** 与上一帧像素一致，跳过 JPEG/IPC。 */
    unchanged?: boolean;
    width: number;
    height: number;
    cameraCount: number;
}

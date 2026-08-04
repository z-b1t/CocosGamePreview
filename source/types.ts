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
    dataUrl: string;
    width: number;
    height: number;
    cameraCount: number;
}

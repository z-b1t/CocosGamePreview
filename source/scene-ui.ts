/**
 * @zh 运行在场景面板 UI 进程（不是引擎场景脚本）。
 * 负责在「游戏预览」开启时隐藏编辑器右下角相机小窗，关闭后恢复由编辑器自己控制。
 */

const STYLE_ID = 'camera-preview-hide-editor-mini-style';
const HTML_CLASS = 'camera-preview-suppress-mini';
const BROADCAST = 'camera-preview:set-mini-hidden';
/** 编辑器小窗内部结构：.float-window > ... > .camera-preview；本扩展面板已改名为 game-preview-panel，不会误伤。 */
const TARGET_SELECTOR = '.float-window .camera-preview, .float-window[camera]';

const HIDE_CSS = `
html.${HTML_CLASS} .float-window[camera],
html.${HTML_CLASS} .float-window:has(.camera-preview) {
    display: none !important;
    visibility: hidden !important;
    opacity: 0 !important;
    pointer-events: none !important;
}
html.${HTML_CLASS} .float-window .camera-preview {
    display: none !important;
    visibility: hidden !important;
}
`;

let observer: MutationObserver | null = null;
let suppressed = false;

function ensureStyle(): void {
    let style = document.getElementById(STYLE_ID) as HTMLStyleElement | null;
    if (!style) {
        style = document.createElement('style');
        style.id = STYLE_ID;
        (document.head || document.documentElement).appendChild(style);
    }
    style.textContent = HIDE_CSS;
}

function hideExistingWindows(): void {
    document.querySelectorAll(TARGET_SELECTOR).forEach((node) => {
        const win = ((node as HTMLElement).closest?.('.float-window') as HTMLElement | null) || (node as HTMLElement);
        win.setAttribute('hidden', '');
        win.setAttribute('data-game-preview-suppressed', '1');
        win.style.setProperty('display', 'none', 'important');
        win.style.setProperty('visibility', 'hidden', 'important');
    });
}

function restoreSuppressedWindows(): void {
    document.querySelectorAll('.float-window[data-game-preview-suppressed="1"]').forEach((node) => {
        const win = node as HTMLElement;
        win.removeAttribute('hidden');
        win.removeAttribute('data-game-preview-suppressed');
        win.style.removeProperty('display');
        win.style.removeProperty('visibility');
    });
}

function onSetMiniHidden(hidden: boolean): void {
    suppressed = !!hidden;
    ensureStyle();
    document.documentElement.classList.toggle(HTML_CLASS, suppressed);
    if (suppressed) {
        hideExistingWindows();
        if (!observer) {
            observer = new MutationObserver(() => {
                if (suppressed) {
                    hideExistingWindows();
                }
            });
            observer.observe(document.documentElement, {
                childList: true,
                subtree: true,
                attributes: true,
                attributeFilter: ['hidden', 'style', 'class'],
            });
        }
    } else {
        if (observer) {
            observer.disconnect();
            observer = null;
        }
        restoreSuppressedWindows();
    }
}

const onBroadcast = (...args: any[]): void => {
    onSetMiniHidden(args.length > 0 ? !!args[0] : true);
};

export function load(): void {
    ensureStyle();
    const message = Editor.Message as any;
    message.addBroadcastListener?.(BROADCAST, onBroadcast);
}

export function unload(): void {
    const message = Editor.Message as any;
    message.removeBroadcastListener?.(BROADCAST, onBroadcast);
    onSetMiniHidden(false);
    document.getElementById(STYLE_ID)?.remove();
    document.documentElement.classList.remove(HTML_CLASS);
}

/**
 * @zh 场景插件在选中变化时可能调用 update；这里确保压制期间小窗不会被编辑器再次拉起来。
 */
export function update(): void {
    if (suppressed) {
        hideExistingWindows();
    }
}

export const methods = {
    setMiniHidden(hidden: boolean): void {
        onSetMiniHidden(!!hidden);
    },
};

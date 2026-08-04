import { join } from 'path';

// 场景进程默认找不到引擎模块，必须在任何 'cc' 的 import 之前补上搜索路径，
// 所以这段代码独立成一个模块，由 scene.ts 第一个导入。
module.paths.push(join(Editor.App.path, 'node_modules'));

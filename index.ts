/**
 * 目录加载兼容入口（T1-01 实测产物）。
 *
 * opencode 2.1.4 对本地目录插件的解析：含 package.json 的目录会走 npm 包
 * 解析路径（要求先安装进插件包注册表，本地未安装目录被静默跳过）；
 * 裸目录则按 index 文件约定解析（参考 plugins/ohm-shim/index.js）。
 * 本文件使本包目录形态兼容两种解析路径：作为目录被加载时由此进入。
 */
export { default } from "./src/server.ts";

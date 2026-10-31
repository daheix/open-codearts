/**
 * 裸目录加载 shim（T1-01 实测产物）。
 *
 * opencode 2.1.4 本地目录插件解析实测：含 package.json 的目录走 npm 包解析
 * （要求先安装进插件包注册表，本地未安装目录被静默跳过）；裸目录按 index
 * 文件约定解析。本目录（无 package.json）即提供该裸目录入口：
 * `plugin` 配置项指向本目录时，由 index.ts 进入真实插件定义 src/server.ts，
 * 其 @opencode/plugin 依赖沿目录树上溯至本包 node_modules 解析。
 */
export { default } from "../src/server.ts";

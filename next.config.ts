import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // web-tree-sitter 与 yauzl 依赖 Node 原生加载方式 / wasm 文件定位，不能被打包。
  serverExternalPackages: ["web-tree-sitter", "yauzl", "tree-sitter-wasms", "@libsql/client", "libsql"],
  outputFileTracingIncludes: {
    "/api/**": [
      "./node_modules/web-tree-sitter/tree-sitter.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-python.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-javascript.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-typescript.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-tsx.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-go.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-java.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-vue.wasm",
      "./node_modules/tree-sitter-wasms/out/tree-sitter-html.wasm",
    ],
  },
  poweredByHeader: false,
};

export default nextConfig;

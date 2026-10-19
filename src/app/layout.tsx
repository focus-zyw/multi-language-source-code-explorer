import type { Metadata } from "next";
import type { ReactNode } from "react";
import { ExplanationTasks } from "@/components/ExplanationTasks";
import { THEME_BOOTSTRAP_SCRIPT } from "@/lib/theme-preference";
import "./globals.css";

export const metadata: Metadata = {
  title: "源码学习台 · Code Atlas",
  description: "导入本地源码项目，浏览函数/方法，阅读源码与讲解，查看关联测试、引用跳转、流程图与关键变量。",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="zh-CN" data-theme="light" data-theme-preference="system" suppressHydrationWarning>
      <head><script dangerouslySetInnerHTML={{ __html: THEME_BOOTSTRAP_SCRIPT }} /></head>
      <body className="antialiased">{children}<ExplanationTasks /></body>
    </html>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, type TextareaHTMLAttributes } from "react";

function resizeInput(input: HTMLTextAreaElement) {
  const limit = Math.max(44, Math.min(200, window.innerHeight * .25));
  input.style.height = "0px";
  const contentHeight = input.scrollHeight;
  input.style.height = `${Math.max(44, Math.min(contentHeight, limit))}px`;
  input.style.overflowY = contentHeight > limit ? "auto" : "hidden";
}

export function AutoGrowingTextarea({ value, ...props }: Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, "value"> & { value: string }) {
  const input = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => { if (input.current) resizeInput(input.current); }, [value]);
  useEffect(() => {
    const element = input.current;
    if (!element) return;
    let lastWidth = element.getBoundingClientRect().width;
    const resize = () => resizeInput(element);
    const observer = new ResizeObserver(() => {
      const width = element.getBoundingClientRect().width;
      if (width !== lastWidth) { lastWidth = width; resize(); }
    });
    observer.observe(element);
    window.addEventListener("resize", resize);
    return () => { observer.disconnect(); window.removeEventListener("resize", resize); };
  }, []);
  return <textarea {...props} ref={input} value={value} />;
}

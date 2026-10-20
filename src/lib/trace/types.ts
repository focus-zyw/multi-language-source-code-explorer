/** 一次追踪运行的结果。节点树由 Python 侧折叠事件流生成，服务端只做校验与透传。 */
export interface TraceArg {
  name: string;
  value: string;
}

export interface TraceNode {
  id: number;
  name: string;
  args: TraceArg[];
  ret: string | null;
  /** 进入该帧时的行号，用于和源码对照。 */
  line: number;
  depth: number;
  children: TraceNode[];
}

export interface TraceRun {
  ok: boolean;
  tree: TraceNode | null;
  nodeCount: number;
  truncated: boolean;
  result: string | null;
  stdout: string;
  error: string | null;
  elapsedMs: number;
}

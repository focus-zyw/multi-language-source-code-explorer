# 开源方案事实核验

核验日期：2026-10-20。范围是用户报告 4.1–4.4 的上游事实；项目适配判断另见本目录评审。下列链接指向核验时的 main 或官方现行文档，未来可能变化。

## Aider Repo Map

基本机制属实：按定义/引用构建文件多重有向图；提及标识符 ×10；长度至少 8 且具 snake/kebab/camel 特征 ×10；下划线前缀 ×0.1；超过 5 个定义文件 ×0.1；引用频次取平方根。源码中的 ×50 施加在聊天文件作为引用者的出边，并非“该文件 PageRank 得分 ×50”。personalization 是迭代中的偏好向量，也用于 dangling 节点，不只是初始分数。文件排名还会沿出边分配到定义，再选标签。二分控制的是渲染后的 token 计数，15% 容差可接受略微超预算，并非严格上限。见 [repomap.py](https://github.com/Aider-AI/aider/blob/main/aider/repomap.py)。

项目推论：可以复用排序与预算思路，但不要照抄权重。已有调用目标比 Aider 同名引用图更具体，但调用图也不等于完整依赖图。若要求硬上限，最终必须再次计数并裁剪。字符预算与 token 预算应明确区分。

## SCIP 符号身份

协议确实定义 scheme、manager、package、version 和 descriptor；方法是 `name(disambiguator).`，参数是 `(name)`，两者不可混为一谈。`(+1)` 在协议中只是显示名称示例里的消歧字符串：规范没有规定它代表参数个数，也没有规定“先参数个数、冲突再类型哈希”。完整符号还需 package 前缀；相对文件路径带点号时需遵循 descriptor 转义规则。见 [scip.proto](https://github.com/scip-code/scip/blob/main/scip.proto)。

不同索引器决定如何消歧。例如 [scip-clang Design.md 的 Method disambiguator](https://github.com/sourcegraph/scip-clang/blob/main/docs/Design.md#method-disambiguator) 讨论规范化方法类型的稳定哈希，不能概括成协议统一算法。

项目推论：借鉴结构化身份有价值，但路径、名称变动仍需匹配策略；名称身份无法证明源码及讲解依赖未变，因而不能替代内容指纹。参数数量不能区分同参数个数的重载，源码摘要消歧又会令方法编辑后身份改变。“源码前 8 个字符的哈希”尤其无法可靠区分共享声明前缀。

## Sonar Cognitive Complexity

平铺五个 if 得 5、五层嵌套 if 得 15 的例子正确。但表格与伪实现过度简化：else/else if 自身不受嵌套附加分，但影响其内部嵌套；逻辑序列、递归环和带标签/层数跳转也不是统一加 nesting。try/finally 完全忽略，不应进入 try 就增加深度；普通 break/continue 不加分，带标签或跨多层的跳转加分。每个 catch 计结构分并可能加 nesting，多异常类型不额外加分。递归规则包含间接递归。嵌套函数/lambda 和 Python 装饰器存在专门规则。见 [Sonar 官方白皮书，尤其附录 A/B](https://www.sonarsource.com/docs/CognitiveComplexity.pdf)。

项目推论：“每语言约 20 行、八语言不足 200 行”没有依据。可以先做明确命名的近似指标，但不能未经规则测试宣称与 Sonar 一致；间接递归还需要跨方法图分析，受调用解析可信度约束。

## Repomix 骨架压缩

Tree-sitter 提取结构、删去实现细节的描述及示例基本准确；官方现行说明保留签名、接口/类型、类结构和属性，示例也保留 import 和注释。不过压缩是有损的结构提取，不是“不丢信息”。官方仍标注为实验功能；本次查阅的官方压缩页及 README 未找到“约 70%”基准或保证，不能作为本项目节省比例。见 [官方 Code Compression](https://repomix.com/guide/code-compress) 与 [官方 README](https://github.com/yamadashy/repomix#code-compression)。

项目推论：应以实际语言样本测 token 与回答质量；目标方法保留全文合理，补充方法压缩则可能丢失理解行为所需条件、副作用和异常。发给模型的上下文语义发生变化，应检查缓存指纹，而不能仅因底层仍保存完整源码就认定无需调整。

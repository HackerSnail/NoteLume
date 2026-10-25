// ast.rs —— Quarkdown 引擎语法树
//
// 解析产物是 Block 序列：普通 Markdown 行逐行保留为 Text（原样，含缩进），指令行解析为 Call。
// 块参数（缩进更深的后续行）递归成 body 里的 Block 序列——内层指令继续是 Call，普通行是 Text。
//
// 链式调用的形态是「段」序列：`.pow {2} to:{3}::multiply {.pi}` 里 pow 与 multiply 各有各的
// 参数（{.pi} 属于 multiply），前一调用的结果是后一调用的第一个位置参数；块参数绑定到最后一段。

/// 函数实参。`name` 为 Some 时是具名参数（`by:{2}`）；`raw` 是花括号内原文（不剥引号、
/// 不判类型——区间字面量 `2..4`、布尔 `yes` 等由求值层识别）。
#[derive(Debug, Clone, PartialEq)]
pub struct Arg {
    pub name: Option<String>,
    pub raw: String,
}

/// 链式调用的一段：名字 + 该段自己的参数
#[derive(Debug, Clone, PartialEq)]
pub struct CallSeg {
    pub name: String,
    pub args: Vec<Arg>,
}

/// 一次调用：head 为首段，chain 为 `::` 后续段（各带参数），body（块参数）绑到最后一段。
#[derive(Debug, Clone, PartialEq)]
pub struct CallNode {
    pub head: CallSeg,
    pub chain: Vec<CallSeg>,
    pub body: Option<Vec<Block>>,
    /// 调用行行号（1 起始），供诊断定位
    pub line: usize,
    /// 调用的原始源文本（消费的全部行，原样）——求值失败时按它降级输出
    pub src: String,
}

/// 行内片段：普通文本或一次行内调用（`Hello, .name!` 的 `.name`）
#[derive(Debug, Clone, PartialEq)]
pub enum InlineSeg {
    Str(String),
    Call(CallNode),
}

#[derive(Debug, Clone, PartialEq)]
pub enum Block {
    /// 原样 Markdown 行（不 trim，保留缩进与空行；无行内调用时走这条快路）
    Text(String),
    /// 含行内调用的行：片段按序求值拼接
    Inline(Vec<InlineSeg>),
    Call(CallNode),
}

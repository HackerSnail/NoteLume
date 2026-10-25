// value.rs —— 求值器值类型与输出格式
//
// 弱类型对齐 Quarkdown：字符串 / 数字 / 布尔 / None / Markdown 内容 / lambda / 区间 / 列表。
// 输出口径：整数不带小数点、布尔 yes/no、None 空串、lambda 直接输出为空、区间与列表逐元素换行。

use super::ast::Block;

#[derive(Debug, Clone, PartialEq)]
pub enum Value {
    Str(String),
    Num(f64),
    Bool(bool),
    None,
    /// 函数求值产出的 Markdown 内容（函数体输出）
    Markdown(String),
    Lambda { params: Vec<String>, body: Vec<Block> },
    /// 闭区间字面量 `{2..4}`
    Range(i64, i64),
    List(Vec<Value>),
}

/// 数字输出：整数值不带小数点（`.sum {2} {3}` → 5 而非 5.0）
pub fn fmt_num(n: f64) -> String {
    if n.fract() == 0.0 && n.abs() < 1e15 {
        format!("{}", n as i64)
    } else {
        format!("{}", n)
    }
}

impl Value {
    pub fn to_output(&self) -> String {
        match self {
            Value::Str(s) => s.clone(),
            Value::Num(n) => fmt_num(*n),
            Value::Bool(true) => "yes".to_string(),
            Value::Bool(false) => "no".to_string(),
            Value::None => String::new(),
            Value::Markdown(m) => m.clone(),
            Value::Lambda { .. } => String::new(),
            Value::Range(a, b) => {
                if b < a {
                    return String::new();
                }
                let items: Vec<String> = (*a..=*b).map(|n| fmt_num(n as f64)).collect();
                items.join("\n")
            }
            Value::List(items) => items.iter().map(|v| v.to_output()).collect::<Vec<_>>().join("\n"),
        }
    }

    /// 布尔判定：Bool 原样；Str 只认 yes / no（与布尔字面量同源）；其余不算真值
    pub fn as_bool(&self) -> Option<bool> {
        match self {
            Value::Bool(b) => Some(*b),
            Value::Str(s) => match s.as_str() {
                "yes" => Some(true),
                "no" => Some(false),
                _ => None,
            },
            _ => None,
        }
    }

    /// 字符串取值（Str / Num / Bool 的文本形态；None / lambda 取不到）
    pub fn as_str(&self) -> Option<String> {
        match self {
            Value::Str(s) => Some(s.clone()),
            Value::Num(n) => Some(fmt_num(*n)),
            Value::Bool(b) => Some(if *b { "yes" } else { "no" }.to_string()),
            _ => None,
        }
    }

    /// 数字取值（Str 先尝试解析）
    pub fn as_num(&self) -> Option<f64> {
        match self {
            Value::Num(n) => Some(*n),
            Value::Str(s) => s.trim().parse::<f64>().ok(),
            _ => None,
        }
    }

    /// 可迭代取值：Range / List 展开；Markdown 列表文本逐行（- 项）拆字符串
    pub fn as_items(&self) -> Option<Vec<Value>> {
        match self {
            Value::Range(a, b) => {
                if b < a {
                    Some(Vec::new())
                } else {
                    Some((*a..=*b).map(|n| Value::Num(n as f64)).collect())
                }
            }
            Value::List(items) => Some(items.clone()),
            Value::Str(s) => Some(
                s.lines()
                    .filter_map(|l| {
                        let t = l.trim();
                        t.strip_prefix("- ").map(|item| Value::Str(item.trim().to_string()))
                    })
                    .collect(),
            ),
            _ => None,
        }
    }
}

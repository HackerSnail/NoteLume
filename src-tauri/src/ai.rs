// ai.rs —— 大模型接入：OpenAI 兼容 /chat/completions 的流式代理
//
// 前端（侧栏 AI 对话 / 选区 AI）经 ai_chat_stream 发起请求，Rust 侧负责 HTTPS 与
// SSE 增量解析（WebView 里的 fetch 撞 CORS，且拿不到流式响应体），增量经 nl:ai-event
// 事件推回前端；ai_chat_cancel 按 reqId 中止仍在跑的请求。
// 本模块只做「转发 + 解析」：不拼提示词、不存历史、不落盘——那些都在前端。
// 提示词拼装与设置归一化见 src/ai-tasks.js（纯逻辑，Node 单测）。

use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};

// —— 数据形状（camelCase 对前端） ——

// AiMessage.content 见结构体注释：serde_json::Value 透传（纯文本 String / 多模态数组都收）

#[derive(Deserialize)]
pub struct AiMessage {
    pub role: String,
    // 纯文本对话是 String；多模态对话是 OpenAI 数组（[{type:'text'},{type:'image_url',…}]）。
    // 前端构造什么就透传什么，这里不做结构校验——能力判定在前端 modelSupportsVision。
    pub content: serde_json::Value,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AiChatArgs {
    pub req_id: String,
    pub messages: Vec<AiMessage>,
    pub base_url: String,
    #[serde(default)]
    pub api_key: String,
    pub model: String,
    #[serde(default)]
    pub temperature: Option<f64>,
}

/// 推回前端的事件载荷：kind = 'chunk'（delta 有值）| 'done' | 'error'（error 有值）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiEvent {
    req_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

/// 事件回调签名：emit(kind, delta, error)。测试里可换成收集器。
/// Send+Sync：跨 await 传递 &EmitFn 的 future 必须整体 Send；带生命周期参数，
/// 裸别名默认 'static 会让测试闭包没法借局部变量。
type EmitFn<'a> = dyn Fn(&str, Option<String>, Option<String>) + Send + Sync + 'a;

// —— 请求表：reqId → 运行中的任务（abort 句柄）+ 结束标记 ——
// 结束标记用于插入新请求时顺手清掉已完成的条目；被 abort 的任务来不及置位，
// 会留到本次会话结束（一条几十字节，不值得为它挂 watcher）。
struct RunningTask {
    handle: tauri::async_runtime::JoinHandle<()>,
    finished: Arc<AtomicBool>,
}

fn running() -> &'static Mutex<HashMap<String, RunningTask>> {
    static R: OnceLock<Mutex<HashMap<String, RunningTask>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(HashMap::new()))
}

/// 发起流式对话。立即返回；增量/结束/出错都走 nl:ai-event 事件（带 reqId）。
#[tauri::command]
pub fn ai_chat_stream(app: tauri::AppHandle, args: AiChatArgs) -> Result<(), String> {
    let req_id = args.req_id.trim().to_string();
    if req_id.is_empty() {
        return Err("req_id is empty".into());
    }
    let base_url = args.base_url.trim().to_string();
    if base_url.is_empty() {
        return Err("base_url is empty".into());
    }
    let model = args.model.trim().to_string();
    if model.is_empty() {
        return Err("model is empty".into());
    }
    let url = chat_url(&base_url);
    let api_key = args.api_key.trim().to_string();
    let temperature = args.temperature;
    let messages: Vec<(String, serde_json::Value)> = args
        .messages
        .into_iter()
        .map(|m| (m.role, m.content))
        .collect();

    // 同 id 旧任务还在跑：先停（前端正常不会这么用，防御一下）
    {
        let mut map = running().lock().map_err(|_| "任务表损坏")?;
        if let Some(old) = map.remove(&req_id) {
            old.handle.abort();
        }
    }

    use tauri::Emitter;
    let emit_app = app.clone();
    let rid = req_id.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let finished_task = finished.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = move |kind: &str, delta: Option<String>, error: Option<String>| {
            let _ = emit_app.emit(
                "nl:ai-event",
                AiEvent {
                    req_id: rid.clone(),
                    kind: kind.to_string(),
                    delta,
                    error,
                },
            );
        };
        match run_stream(&url, &api_key, &model, temperature, &messages, &emit).await {
            Ok(()) => emit("done", None, None),
            Err(e) => emit("error", None, Some(e)),
        }
        finished_task.store(true, Ordering::Relaxed);
    });

    let mut map = running().lock().map_err(|_| "任务表损坏")?;
    map.retain(|_, t| !t.finished.load(Ordering::Relaxed)); // 顺手清理已结束的
    map.insert(req_id, RunningTask { handle, finished });
    Ok(())
}

/// 中止一个流式请求。返回是否命中了仍在跑的任务（前端拿返回值无感，只用于测试断言）。
#[tauri::command]
pub fn ai_chat_cancel(req_id: String) -> bool {
    let Ok(mut map) = running().lock() else {
        return false;
    };
    match map.remove(req_id.as_str()) {
        Some(t) => {
            t.handle.abort();
            true
        }
        None => false,
    }
}

/// base_url → chat/completions 完整地址。容忍末尾斜杠与用户直接填到 /chat/completions 的写法。
pub fn chat_url(base_url: &str) -> String {
    let b = base_url.trim().trim_end_matches('/');
    if b.ends_with("/chat/completions") {
        return b.to_string();
    }
    format!("{b}/chat/completions")
}

/// SSE 行 → data 载荷。非 data: 行（空行 / 注释 / event: 等字段）回 None；
/// "data: [DONE]" 回 Some("[DONE]")；载荷与冒号间的单个空格按规范剥掉。
pub fn sse_data_payload(line: &str) -> Option<&str> {
    let rest = line.strip_prefix("data:")?;
    Some(rest.strip_prefix(' ').unwrap_or(rest))
}

pub fn is_sse_done(payload: &str) -> bool {
    payload.trim() == "[DONE]"
}

/// 一条 SSE data 载荷（OpenAI chunk JSON）→ 增量文本。
/// 畸形 JSON / 无 choices 回 None；delta 缺 content（如 role 帧）回 Some("")，
/// 让上层能区分「有 chunk 但没内容」与「解析不了」；content 非字符串（坏响应）
/// 回 None，别当增量吐出去。少数网关忽略 stream 参数一次性回 message.content，一并兜住。
pub fn extract_delta_content(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let choice = v.get("choices")?.get(0)?;
    if let Some(d) = choice.get("delta") {
        return string_or_empty(d.get("content"));
    }
    if let Some(m) = choice.get("message") {
        return string_or_empty(m.get("content"));
    }
    None
}

fn string_or_empty(v: Option<&serde_json::Value>) -> Option<String> {
    match v {
        Some(serde_json::Value::String(s)) => Some(s.clone()),
        Some(serde_json::Value::Null) | None => Some(String::new()), // 缺字段 / null（工具调用帧）→ 空 chunk
        Some(_) => None, // content 不是字符串（坏响应）：别当增量吐出去
    }
}

/// 部分网关在 200 流里塞 error 对象：{"error":{"message":"…"}} → 错误文案。
pub fn extract_sse_error(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let e = v.get("error")?;
    let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("");
    Some(if msg.is_empty() { e.to_string() } else { msg.to_string() })
}

/// 发起请求并逐行解析 SSE。emit 由调用方给定（测试里可换成收集器）。
async fn run_stream(
    url: &str,
    api_key: &str,
    model: &str,
    temperature: Option<f64>,
    messages: &[(String, serde_json::Value)],
    emit: &EmitFn<'_>,
) -> Result<(), String> {
    let mut body = serde_json::json!({
        "model": model,
        "messages": messages
            .iter()
            .map(|(r, c)| serde_json::json!({ "role": r, "content": c }))
            .collect::<Vec<_>>(),
        "stream": true,
    });
    if let Some(t) = temperature {
        body["temperature"] = serde_json::json!(t);
    }

    let client = reqwest::Client::builder()
        // 整体兜底：长对话不至于挂死进程；流式读本身没有 per-read 超时
        .timeout(std::time::Duration::from_secs(300))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let mut req = client.post(url).json(&body);
    if !api_key.is_empty() {
        req = req.bearer_auth(api_key);
    }
    let mut resp = req.send().await.map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let via_json = serde_json::from_str::<serde_json::Value>(&text)
            .ok()
            .and_then(|v| {
                v.get("error")
                    .and_then(|e| e.get("message"))
                    .and_then(|m| m.as_str())
                    .map(|s| s.to_string())
            });
        return Err(format!(
            "HTTP {status}: {}",
            via_json.unwrap_or_else(|| truncate_utf8(text.trim(), 300))
        ));
    }

    // 字节缓冲逐行处理：SSE 行以 \n 结尾且 JSON 行是完整 UTF-8，按行转码不会
    // 把跨 chunk 的多字节字符切坏（直接 lossy 每个 chunk 就会）。
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = resp.chunk().await.map_err(|e| format!("读取流失败: {e}"))?;
        let Some(bytes) = chunk else { break };
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(stop) = handle_line(&line, emit) {
                return stop; // Ok = [DONE]；Err = 流内报错
            }
        }
    }
    // 流结束：剩余不足一行的尾巴也处理一次（服务端忘写换行的兜底）
    if !buf.is_empty() {
        let tail = std::mem::take(&mut buf);
        if let Some(stop) = handle_line(&tail, emit) {
            return stop;
        }
    }
    Ok(())
}

/// 错误响应体截断（按字符截，chars().take 天然不切坏多字节字符）；空体给占位文案
fn truncate_utf8(t: &str, max_chars: usize) -> String {
    if t.is_empty() {
        return "无响应体".to_string();
    }
    if t.chars().count() <= max_chars {
        return t.to_string();
    }
    let cut: String = t.chars().take(max_chars).collect();
    format!("{cut}…")
}

/// 处理一行 SSE 字节：返回 None = 与数据无关的行；Some(Ok(())) = [DONE]；
/// Some(Err(msg)) = 流内 error。chunk 增量经 emit 发出。
fn handle_line(line: &[u8], emit: &EmitFn<'_>) -> Option<Result<(), String>> {
    let text = String::from_utf8_lossy(line);
    let text = text.trim_end_matches(['\n', '\r']);
    let payload = sse_data_payload(text)?;
    if is_sse_done(payload) {
        return Some(Ok(()));
    }
    if let Some(err) = extract_sse_error(payload) {
        return Some(Err(err));
    }
    if let Some(delta) = extract_delta_content(payload) {
        if !delta.is_empty() {
            emit("chunk", Some(delta), None);
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    #[test]
    fn chat_url_variants() {
        assert_eq!(chat_url("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(chat_url("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/chat/completions");
        assert_eq!(chat_url(" https://x.cn/api/paas/v4 "), "https://x.cn/api/paas/v4/chat/completions");
        // 用户直接填到端点：不重复追加
        assert_eq!(chat_url("https://x/v1/chat/completions"), "https://x/v1/chat/completions");
        assert_eq!(chat_url("http://127.0.0.1:11434/v1"), "http://127.0.0.1:11434/v1/chat/completions");
    }

    #[test]
    fn sse_data_parsing() {
        assert_eq!(sse_data_payload("data: {\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_payload("data:{\"a\":1}"), Some("{\"a\":1}"));
        assert_eq!(sse_data_payload("data: [DONE]"), Some("[DONE]"));
        assert_eq!(sse_data_payload(""), None);
        assert_eq!(sse_data_payload(": keep-alive"), None);
        assert_eq!(sse_data_payload("event: message"), None);
        assert!(is_sse_done("[DONE]"));
        assert!(!is_sse_done("[done]"));
    }

    #[test]
    fn delta_extraction() {
        let chunk = r#"{"id":"1","choices":[{"index":0,"delta":{"content":"你好"}}]}"#;
        assert_eq!(extract_delta_content(chunk).as_deref(), Some("你好"));
        // role 帧：delta 无 content → 空 chunk（不算错误）
        let role = r#"{"choices":[{"delta":{"role":"assistant"}}]}"#;
        assert_eq!(extract_delta_content(role).as_deref(), Some(""));
        // content 为 null：工具调用帧常见，当空 chunk 处理
        assert_eq!(extract_delta_content(r#"{"choices":[{"delta":{"content":null}}]}"#).as_deref(), Some(""));
        // 少数网关忽略 stream：一次性 message.content
        let full = r#"{"choices":[{"message":{"role":"assistant","content":"整段回复"}}]}"#;
        assert_eq!(extract_delta_content(full).as_deref(), Some("整段回复"));
        // 坏形状全回 None
        assert_eq!(extract_delta_content("not json"), None);
        assert_eq!(extract_delta_content("{}"), None);
        assert_eq!(extract_delta_content(r#"{"choices":[]}"#), None);
        assert_eq!(extract_delta_content(r#"{"choices":[{"delta":{"content":42}}]}"#), None);
    }

    #[test]
    fn sse_error_extraction() {
        assert_eq!(
            extract_sse_error(r#"{"error":{"message":"Incorrect API key"}}"#).as_deref(),
            Some("Incorrect API key")
        );
        // 无 message 的 error：整个对象当文案
        assert!(extract_sse_error(r#"{"error":{"code":401}}"#).is_some());
        assert_eq!(extract_sse_error(r#"{"choices":[]}"#), None);
        assert_eq!(extract_sse_error("oops"), None);
    }

    /// 把 emit 换成收集器跑 handle_line，返回 (返回值, 事件列表)。Mutex：EmitFn 要求 Send+Sync
    fn run_line(line: &[u8]) -> (Option<Result<(), String>>, Vec<(String, Option<String>)>) {
        let out = Mutex::new(Vec::new());
        let emit = |kind: &str, delta: Option<String>, _error: Option<String>| {
            out.lock().unwrap().push((kind.to_string(), delta));
        };
        let r = handle_line(line, &emit);
        (r, out.into_inner().unwrap())
    }

    #[test]
    fn handle_line_emits_and_stops() {
        // 普通增量行 → chunk 事件，不终止
        let (r, events) = run_line(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n");
        assert!(r.is_none());
        assert_eq!(events, vec![("chunk".into(), Some("hi".into()))]);

        // [DONE] → Ok 终止
        let (r, events) = run_line(b"data: [DONE]\n");
        assert_eq!(r, Some(Ok(())));
        assert!(events.is_empty());

        // 流内错误 → Err 终止
        let (r, events) = run_line(b"data: {\"error\":{\"message\":\"bad key\"}}\n");
        assert_eq!(r, Some(Err("bad key".into())));
        assert!(events.is_empty());

        // 无关行不发事件
        let (r, events) = run_line(b": ping\n");
        assert!(r.is_none());
        assert!(events.is_empty());
        let (r, events) = run_line(b"\n");
        assert!(r.is_none());
        assert!(events.is_empty());

        // 跨 chunk 拆坏的多字节序列不会 panic（lossy 兜底），无效行回 None
        let (r, _) = run_line(&[0xe4, 0xbd, b'\n']);
        assert!(r.is_none());
    }

    #[test]
    fn truncate_utf8_boundaries() {
        assert_eq!(truncate_utf8("", 3), "无响应体");
        assert_eq!(truncate_utf8("abc", 3), "abc");
        assert!(truncate_utf8("你好世界", 2).starts_with("你好"));
        let long = "汉".repeat(10);
        let cut = truncate_utf8(&long, 3);
        assert!(cut.starts_with("汉汉汉"));
        assert!(cut.ends_with('…'));
    }

    #[test]
    fn cancel_unknown_id_is_false() {
        assert!(!ai_chat_cancel("__no_such_req__".into()));
    }
}

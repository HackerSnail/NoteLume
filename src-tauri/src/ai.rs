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
    // 工具定义只在 Agent 模式带上，原样透传（Rust 不理解工具语义，与 content 同口径）
    #[serde(default)]
    pub tools: Option<serde_json::Value>,
}

/// 推回前端的事件载荷：kind = 'chunk'（delta 有值）| 'reasoning'（推理模型的思考增量）
/// | 'done' | 'error'（error 有值）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct AiEvent {
    req_id: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    delta: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    // done 事件可能带回累积的 tool_calls：[{id, name, arguments}]（序列化为 camelCase toolCalls）
    #[serde(skip_serializing_if = "Option::is_none")]
    tool_calls: Option<serde_json::Value>,
}

/// 事件回调签名：emit(kind, delta, error, tool_calls)。测试里可换成收集器。
/// Send+Sync：跨 await 传递 &EmitFn 的 future 必须整体 Send；带生命周期参数，
/// 裸别名默认 'static 会让测试闭包没法借局部变量。
type EmitFn<'a> = dyn Fn(&str, Option<String>, Option<String>, Option<serde_json::Value>) + Send + Sync + 'a;

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
    // 空数组 / 非数组视同未带，省一次无意义字段
    let tools = args
        .tools
        .filter(|v| v.as_array().map(|a| !a.is_empty()).unwrap_or(false));
    let handle = tauri::async_runtime::spawn(async move {
        let emit = move |kind: &str,
                         delta: Option<String>,
                         error: Option<String>,
                         tool_calls: Option<serde_json::Value>| {
            let _ = emit_app.emit(
                "nl:ai-event",
                AiEvent {
                    req_id: rid.clone(),
                    kind: kind.to_string(),
                    delta,
                    error,
                    tool_calls,
                },
            );
        };
        match run_stream(&url, &api_key, &model, temperature, &messages, tools.as_ref(), &emit).await
        {
            Ok(calls) => emit(
                "done",
                None,
                None,
                calls.map(|c| {
                    serde_json::Value::Array(
                        c.into_iter()
                            .map(|(id, name, arguments)| {
                                serde_json::json!({ "id": id, "name": name, "arguments": arguments })
                            })
                            .collect(),
                    )
                }),
            ),
            Err(e) => emit("error", None, Some(e), None),
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

/// 模型列表 URL：与 chat_url 同口径（剥尾斜杠；填到 /models 就不重复追加；
/// 填到 /chat/completions 时剥回上一级再挂 /models，否则拼出 …/chat/completions/models 必 404）
pub fn models_url(base_url: &str) -> String {
    let mut b = base_url.trim().trim_end_matches('/');
    if let Some(up) = b.strip_suffix("/chat/completions") {
        b = up.trim_end_matches('/');
    }
    if b.ends_with("/models") {
        return b.to_string();
    }
    format!("{b}/models")
}

/// 拉取 OpenAI 兼容服务的模型列表（GET /models，data[].id 升序）。地址 / Key 与对话同源。
#[tauri::command]
pub async fn ai_models_list(base_url: String, api_key: Option<String>) -> Result<Vec<String>, String> {
    let base = base_url.trim().to_string();
    if base.is_empty() {
        return Err("base_url is empty".into());
    }
    let url = models_url(&base);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(8))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let mut req = client.get(&url);
    let key = api_key.unwrap_or_default();
    if !key.trim().is_empty() {
        req = req.bearer_auth(key.trim());
    }
    let resp = req.send().await.map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    let text = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", truncate_utf8(text.trim(), 200)));
    }
    let v: serde_json::Value = serde_json::from_str(&text).map_err(|e| format!("响应解析失败: {e}"))?;
    let mut ids: Vec<String> = v
        .get("data")
        .and_then(|d| d.as_array())
        .map(|arr| {
            arr.iter()
                .filter_map(|m| m.get("id").and_then(|i| i.as_str()).map(|s| s.to_string()))
                .collect()
        })
        .unwrap_or_default();
    ids.sort_by_key(|a| a.to_lowercase());
    Ok(ids)
}

/// 本机 Ollama 的状态。state 四档：
/// - `ready`：服务可达且至少有一个模型
/// - `no_models`：服务可达但一个模型也没拉（首启最常见的那一档）
/// - `stopped`：服务不可达，但本机找得到 ollama 可执行文件（装了没起）
/// - `missing`：服务不可达且找不到可执行文件（没装）
#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OllamaStatus {
    pub state: String,
    pub models: Vec<String>,
}

const OLLAMA_TAGS_URL: &str = "http://127.0.0.1:11434/api/tags";
const OLLAMA_PULL_URL: &str = "http://127.0.0.1:11434/api/pull";

/// 四档判定（纯函数，可单测）：可达性 + 模型数 + 是否装了
pub fn ollama_state(reachable: bool, model_count: usize, installed: bool) -> &'static str {
    if !reachable {
        return if installed { "stopped" } else { "missing" };
    }
    if model_count == 0 {
        "no_models"
    } else {
        "ready"
    }
}

/// /api/tags 响应 → 模型名升序。`name` 缺则取 `model`；坏 JSON / 缺字段 / 空表回空 Vec
/// （回空表与「不可达」在调用点是两回事，别在这里合并）
pub fn parse_ollama_models(text: &str) -> Vec<String> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(text) else {
        return Vec::new();
    };
    let Some(arr) = v.get("models").and_then(|m| m.as_array()) else {
        return Vec::new();
    };
    let mut names: Vec<String> = arr
        .iter()
        .filter_map(|m| {
            let pick = |k: &str| {
                m.get(k)
                    .and_then(|n| n.as_str())
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
            };
            // name 为空串也算没给（真见过），继续试 model
            pick("name").or_else(|| pick("model"))
        })
        .collect();
    names.sort_by_key(|a| a.to_lowercase());
    names
}

/// 候选可执行文件路径（纯函数：env 取值与平台名都注入，方便单测）。
/// PATH 扫描是主力——自定义安装目录（如 D:\Ollama\setup）通常只出现在 PATH 里。
pub fn ollama_exe_candidates(env: impl Fn(&str) -> Option<String>, os: &str) -> Vec<std::path::PathBuf> {
    use std::path::PathBuf;
    let exe = if os == "windows" { "ollama.exe" } else { "ollama" };
    let sep = if os == "windows" { ';' } else { ':' };
    let mut out = Vec::new();
    if let Some(path) = env("PATH") {
        for dir in path.split(sep) {
            let d = dir.trim();
            if !d.is_empty() {
                out.push(PathBuf::from(d).join(exe));
            }
        }
    }
    match os {
        "windows" => {
            for key in ["LOCALAPPDATA", "ProgramFiles", "ProgramFiles(x86)"] {
                if let Some(base) = env(key).map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
                    out.push(PathBuf::from(base).join("Ollama").join(exe));
                }
            }
        }
        "macos" => {
            out.push(PathBuf::from("/Applications/Ollama.app/Contents/Resources/ollama"));
            out.push(PathBuf::from("/usr/local/bin/ollama"));
            out.push(PathBuf::from("/opt/homebrew/bin/ollama"));
        }
        _ => {
            out.push(PathBuf::from("/usr/local/bin/ollama"));
            out.push(PathBuf::from("/usr/bin/ollama"));
            out.push(PathBuf::from("/bin/ollama"));
            if let Some(home) = env("HOME").map(|v| v.trim().to_string()).filter(|v| !v.is_empty()) {
                out.push(PathBuf::from(home).join(".ollama/bin/ollama"));
            }
        }
    }
    out
}

fn ollama_installed() -> bool {
    let os = if cfg!(target_os = "windows") {
        "windows"
    } else if cfg!(target_os = "macos") {
        "macos"
    } else {
        "linux"
    };
    ollama_exe_candidates(|k| std::env::var(k).ok(), os)
        .iter()
        .any(|p| p.is_file())
}

/// 探测本机 Ollama：先摸 /api/tags，摸不到再分「装了没起」与「没装」。
/// 此前只回 bool（可达即算已装已运行），把 /api/tags 响应里本来就带的模型表丢了，
/// 「起了但零模型」这一档首用户最需要的提示也就做不出来。
pub async fn ollama_status() -> OllamaStatus {
    let mut reachable = false;
    let mut models = Vec::new();
    if let Ok(client) = reqwest::Client::builder()
        .timeout(std::time::Duration::from_millis(1200))
        .build()
    {
        if let Ok(resp) = client.get(OLLAMA_TAGS_URL).send().await {
            if resp.status().is_success() {
                reachable = true;
                models = parse_ollama_models(&resp.text().await.unwrap_or_default());
            }
        }
    }
    let state = ollama_state(reachable, models.len(), ollama_installed());
    OllamaStatus {
        state: state.to_string(),
        models,
    }
}

#[tauri::command]
pub async fn ollama_probe() -> Result<OllamaStatus, String> {
    Ok(ollama_status().await)
}

/// 拉取进度事件：kind = 'progress'（status 有值）| 'done' | 'error'（error 有值）
#[derive(Serialize, Clone)]
#[serde(rename_all = "camelCase")]
struct PullEvent {
    req_id: String,
    model: String,
    kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    status: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    completed: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    total: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
}

type PullEmit<'a> = dyn Fn(&str, Option<String>, Option<u64>, Option<u64>, Option<String>) + Send + Sync + 'a;

#[derive(Debug, PartialEq)]
pub enum PullLine {
    Progress {
        status: String,
        completed: Option<u64>,
        total: Option<u64>,
    },
    Failed(String),
    Skip,
}

/// /api/pull 的一行 NDJSON → PullLine。真实形状：
/// `{"status":"pulling manifest"}`、`{"status":"Downloading 47%","digest":...,"completed":123,"total":456}`、
/// `{"status":"success"}`，出错是 `{"error":"..."}`。
pub fn parse_pull_line(line: &[u8]) -> PullLine {
    let text = String::from_utf8_lossy(line);
    let t = text.trim();
    if t.is_empty() {
        return PullLine::Skip;
    }
    let Ok(v) = serde_json::from_str::<serde_json::Value>(t) else {
        return PullLine::Skip;
    };
    if let Some(err) = v.get("error").and_then(|e| e.as_str()) {
        let s = err.trim();
        if !s.is_empty() {
            return PullLine::Failed(s.to_string());
        }
    }
    let Some(status) = v.get("status").and_then(|s| s.as_str()).map(|s| s.trim().to_string()) else {
        return PullLine::Skip;
    };
    if status.is_empty() {
        return PullLine::Skip;
    }
    let num = |k: &str| v.get(k).and_then(|x| x.as_u64());
    PullLine::Progress {
        status,
        completed: num("completed"),
        total: num("total"),
    }
}

/// 模型名白名单：ASCII 字母数字与 `: . _ - /`，长度 ≤ 120，禁 `..`。
/// `/` 要收（带命名空间的写法如 `library/foo:latest`、`docker.io/x/y`），所以越界靠 `..`
/// 单独拦；名字直接进请求体，界面只给我们自己建议的那一个，这里防的是以后放开手输时的怪输入。
pub fn pull_model_name_ok(s: &str) -> bool {
    !s.is_empty()
        && s.len() <= 120
        && !s.contains("..")
        && s.chars()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, ':' | '.' | '_' | '-' | '/'))
}

/// 起一个 Ollama 模型拉取。立即返回；进度走 nl:ollama-pull 事件。
/// reqId 登记进与对话同一张任务表，`ai_chat_cancel` 同样能中止它（拉取没有整体超时，
/// 取消是唯一出口，界面上必须给停止按钮或至少告知可取消）。
#[tauri::command]
pub fn ollama_pull(app: tauri::AppHandle, req_id: String, model: String) -> Result<(), String> {
    let req_id = req_id.trim().to_string();
    if req_id.is_empty() {
        return Err("req_id is empty".into());
    }
    let model = model.trim().to_string();
    if !pull_model_name_ok(&model) {
        return Err(format!("模型名不合法：{model}"));
    }
    {
        let mut map = running().lock().map_err(|_| "任务表损坏")?;
        if let Some(old) = map.remove(&req_id) {
            old.handle.abort();
        }
    }

    use tauri::Emitter;
    let emit_app = app.clone();
    let rid = req_id.clone();
    let mid = model.clone();
    let finished = Arc::new(AtomicBool::new(false));
    let finished_task = finished.clone();
    let handle = tauri::async_runtime::spawn(async move {
        let emit = move |kind: &str, status: Option<String>, completed: Option<u64>, total: Option<u64>, error: Option<String>| {
            let _ = emit_app.emit(
                "nl:ollama-pull",
                PullEvent {
                    req_id: rid.clone(),
                    model: mid.clone(),
                    kind: kind.to_string(),
                    status,
                    completed,
                    total,
                    error,
                },
            );
        };
        match run_pull(&model, &emit).await {
            Ok(()) => emit("done", None, None, None, None),
            Err(e) => emit("error", None, None, None, Some(e)),
        }
        finished_task.store(true, Ordering::Relaxed);
    });

    let mut map = running().lock().map_err(|_| "任务表损坏")?;
    map.retain(|_, t| !t.finished.load(Ordering::Relaxed));
    map.insert(req_id, RunningTask { handle, finished });
    Ok(())
}

async fn run_pull(model: &str, emit: &PullEmit<'_>) -> Result<(), String> {
    let client = reqwest::Client::builder()
        // 只设连接超时：几 GB 的拉取没有合理的整体上限，卡住靠 ai_chat_cancel 中止
        .connect_timeout(std::time::Duration::from_secs(3))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let mut resp = client
        .post(OLLAMA_PULL_URL)
        .json(&serde_json::json!({ "model": model, "stream": true }))
        .send()
        .await
        .map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    if !status.is_success() {
        let text = resp.text().await.unwrap_or_default();
        let via_json = extract_error_body(&text);
        return Err(format!(
            "HTTP {status}: {}",
            via_json.unwrap_or_else(|| truncate_utf8(text.trim(), 300))
        ));
    }
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = resp.chunk().await.map_err(|e| format!("读取流失败: {e}"))?;
        let Some(bytes) = chunk else { break };
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(e) = handle_pull_line(&line, emit) {
                return Err(e); // 流内报错（模型名不存在 / 磁盘满）直接收，不再读下去
            }
        }
    }
    if !buf.is_empty() {
        if let Some(e) = handle_pull_line(&buf, emit) {
            return Err(e);
        } // 末行没带换行也要走一趟，别让最后一段进度或错误消失
    }
    Ok(())
}

/// 一行 NDJSON → 进度的 emit 或错误文案（Progress 回 None，Failed 回 Some，Skip 回 None）
fn handle_pull_line(line: &[u8], emit: &PullEmit<'_>) -> Option<String> {
    match parse_pull_line(line) {
        PullLine::Progress { status, completed, total } => {
            emit("progress", Some(status), completed, total, None);
            None
        }
        PullLine::Failed(e) => Some(e),
        PullLine::Skip => None,
    }
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

/// 一条 SSE data 载荷 → 思考增量。推理模型（Qwen3 / DeepSeek-R1 等）把「思考过程」
/// 放在 delta.reasoning / reasoning_content / thinking 里，此时 content 可能整段为空——
/// 只认 content 会得到一个空气泡。非推理模型没有这些字段，回 None（不发空事件）。
pub fn extract_delta_reasoning(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    let choice = v.get("choices")?.get(0)?;
    let obj = choice
        .get("delta")
        .or_else(|| choice.get("message"))?;
    for key in ["reasoning", "reasoning_content", "thinking"] {
        if let Some(serde_json::Value::String(s)) = obj.get(key) {
            if !s.is_empty() {
                return Some(s.clone());
            }
        }
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

/// 部分网关在 200 流里塞 error：{"error":{"message":"…"}} → 错误文案；
/// Ollama 式 error 为字符串（{"error":"… does not support tools"}）直取。
pub fn extract_sse_error(payload: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(payload).ok()?;
    error_value_text(v.get("error")?)
}

/// 非 2xx 错误体 → 文案。OpenAI 取 error.message，error 为字符串直取；
/// SiliconFlow 一类网关把说明放在顶层 message（配数字 code 与 data:null），
/// 只认 error.* 时整串 JSON 会原样糊到界面上（实测 api.siliconflow.cn 的
/// 「Model does not exist」400 就是这个形态）。带 code 时附在后面，报障能直接对服务商文档。
/// 解析不出回 None（调用方回退原始文本截断）。
pub fn extract_error_body(text: &str) -> Option<String> {
    let v: serde_json::Value = serde_json::from_str(text).ok()?;
    if let Some(s) = v.get("error").and_then(error_value_text) {
        if !s.trim().is_empty() {
            return Some(s);
        }
    }
    let msg = ["message", "msg"]
        .iter()
        .find_map(|k| v.get(*k).and_then(|m| m.as_str()))
        .map(|s| s.trim().to_string())
        .filter(|s| !s.is_empty())?;
    Some(match v.get("code") {
        Some(serde_json::Value::String(c)) if !c.is_empty() => format!("{msg}（code {c}）"),
        Some(c) if c.is_i64() || c.is_u64() => format!("{msg}（code {}）", c.as_i64().unwrap_or_default()),
        _ => msg,
    })
}

fn error_value_text(e: &serde_json::Value) -> Option<String> {
    match e {
        serde_json::Value::String(s) => Some(s.clone()),
        _ => {
            let msg = e.get("message").and_then(|m| m.as_str()).unwrap_or("");
            Some(if msg.is_empty() { e.to_string() } else { msg.to_string() })
        }
    }
}

// —— 工具调用累积（Agent 循环的服务端半边） ——

/// 一条流式 tool_calls 增量：OpenAI 碎片式按 index 分片（id/name 只在首片），
/// Ollama 整对象式单 chunk 一次到齐且可能缺 index（按 0 归位）。
pub struct ToolCallDelta {
    pub index: usize,
    pub id: Option<String>,
    pub name: Option<String>,
    pub args_delta: String,
}

/// 一条 SSE data 载荷 → tool_calls 增量列表。delta 与 message（网关忽略 stream 的兜底，
/// 整数组一次返回）同源解析；无工具调用 / 畸形载荷回空列表。
pub fn extract_tool_call_delta(payload: &str) -> Vec<ToolCallDelta> {
    let Ok(v) = serde_json::from_str::<serde_json::Value>(payload) else {
        return Vec::new();
    };
    let Some(choice) = v.get("choices").and_then(|c| c.get(0)) else {
        return Vec::new();
    };
    let raw = choice
        .get("delta")
        .and_then(|d| d.get("tool_calls"))
        .or_else(|| choice.get("message").and_then(|m| m.get("tool_calls")));
    let Some(list) = raw.and_then(|r| r.as_array()) else {
        return Vec::new();
    };
    let mut out = Vec::new();
    for tc in list {
        let func = tc.get("function");
        let id = tc.get("id").and_then(|x| x.as_str()).map(|s| s.to_string());
        let name = func
            .and_then(|f| f.get("name"))
            .and_then(|x| x.as_str())
            .map(|s| s.to_string());
        let args_delta = func
            .and_then(|f| f.get("arguments"))
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string();
        if id.is_none() && name.is_none() && args_delta.is_empty() {
            continue;
        }
        let index = tc.get("index").and_then(|x| x.as_u64()).unwrap_or(0) as usize;
        out.push(ToolCallDelta { index, id, name, args_delta });
    }
    out
}

struct ToolCallAcc {
    id: String,
    name: String,
    arguments: String,
}

/// 按 index 归组的累积器：有 id 视为新调用起始（整对象直接落全量 arguments），
/// 无 id 视为后续碎片追加 arguments。finish 在没有任何调用时回 None。
#[derive(Default)]
struct ToolCallAccumulator {
    calls: Vec<ToolCallAcc>,
}

impl ToolCallAccumulator {
    fn push(&mut self, d: ToolCallDelta) {
        while self.calls.len() <= d.index {
            self.calls.push(ToolCallAcc {
                id: String::new(),
                name: String::new(),
                arguments: String::new(),
            });
        }
        let c = &mut self.calls[d.index];
        if let Some(id) = d.id {
            c.id = id;
        }
        if let Some(name) = d.name {
            c.name = name;
        }
        c.arguments.push_str(&d.args_delta);
    }

    fn finish(self) -> Option<Vec<(String, String, String)>> {
        if self.calls.is_empty() {
            return None;
        }
        Some(
            self.calls
                .into_iter()
                .map(|c| (c.id, c.name, c.arguments))
                .collect(),
        )
    }
}

/// 请求体拼装：model / messages / stream 固定，temperature 与 tools 按需。
/// tools 只在 Agent 模式带（空数组 / 非数组视同未带）。
pub fn build_chat_body(
    model: &str,
    temperature: Option<f64>,
    messages: &[(String, serde_json::Value)],
    tools: Option<&serde_json::Value>,
) -> serde_json::Value {
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
    if let Some(tv) = tools {
        if tv.as_array().map(|a| !a.is_empty()).unwrap_or(false) {
            body["tools"] = tv.clone();
        }
    }
    body
}

/// 发起请求并逐行解析 SSE。emit 由调用方给定（测试里可换成收集器）。
/// 返回累积的 tool_calls（(id, name, arguments) 列表），无工具调用回 None。
async fn run_stream(
    url: &str,
    api_key: &str,
    model: &str,
    temperature: Option<f64>,
    messages: &[(String, serde_json::Value)],
    tools: Option<&serde_json::Value>,
    emit: &EmitFn<'_>,
) -> Result<Option<Vec<(String, String, String)>>, String> {
    let body = build_chat_body(model, temperature, messages, tools);

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
        let via_json = extract_error_body(&text);
        return Err(format!(
            "HTTP {status}: {}",
            via_json.unwrap_or_else(|| truncate_utf8(text.trim(), 300))
        ));
    }

    // 字节缓冲逐行处理：SSE 行以 \n 结尾且 JSON 行是完整 UTF-8，按行转码不会
    // 把跨 chunk 的多字节字符切坏（直接 lossy 每个 chunk 就会）。
    let mut acc = ToolCallAccumulator::default();
    let mut buf: Vec<u8> = Vec::new();
    loop {
        let chunk = resp.chunk().await.map_err(|e| format!("读取流失败: {e}"))?;
        let Some(bytes) = chunk else { break };
        buf.extend_from_slice(&bytes);
        while let Some(pos) = buf.iter().position(|&b| b == b'\n') {
            let line: Vec<u8> = buf.drain(..=pos).collect();
            if let Some(stop) = handle_line(&line, emit, &mut acc) {
                // Ok = [DONE]（带回累积的 tool_calls）；Err = 流内报错（累积丢弃）
                return match stop {
                    Ok(()) => Ok(acc.finish()),
                    Err(e) => Err(e),
                };
            }
        }
    }
    // 流结束：剩余不足一行的尾巴也处理一次（服务端忘写换行的兜底）
    if !buf.is_empty() {
        let tail = std::mem::take(&mut buf);
        if let Some(stop) = handle_line(&tail, emit, &mut acc) {
            return match stop {
                Ok(()) => Ok(acc.finish()),
                Err(e) => Err(e),
            };
        }
    }
    Ok(acc.finish())
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
/// Some(Err(msg)) = 流内 error。正文增量 / 思考增量分别进 emit，tool_calls 进累积器。
fn handle_line(
    line: &[u8],
    emit: &EmitFn<'_>,
    acc: &mut ToolCallAccumulator,
) -> Option<Result<(), String>> {
    let text = String::from_utf8_lossy(line);
    let text = text.trim_end_matches(['\n', '\r']);
    let payload = sse_data_payload(text)?;
    if is_sse_done(payload) {
        return Some(Ok(()));
    }
    if let Some(err) = extract_sse_error(payload) {
        return Some(Err(err));
    }
    for d in extract_tool_call_delta(payload) {
        acc.push(d);
    }
    if let Some(delta) = extract_delta_content(payload) {
        if !delta.is_empty() {
            emit("chunk", Some(delta), None, None);
        }
    }
    // 思考过程单独走 reasoning 事件：前端折叠展示，不混进正文（也就不会被当成回答写进文档）
    if let Some(reasoning) = extract_delta_reasoning(payload) {
        emit("reasoning", Some(reasoning), None, None);
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
    fn models_url_variants() {
        assert_eq!(models_url("https://api.deepseek.com/v1"), "https://api.deepseek.com/v1/models");
        assert_eq!(models_url(" https://api.deepseek.com/v1/ "), "https://api.deepseek.com/v1/models");
        // 用户直接填到端点：不重复追加
        assert_eq!(models_url("https://x/v1/models"), "https://x/v1/models");
        // 填到 /chat/completions：剥回上一级，不再挂出 …/chat/completions/models
        assert_eq!(models_url("https://api.siliconflow.cn/v1/chat/completions"), "https://api.siliconflow.cn/v1/models");
        assert_eq!(models_url("https://api.moonshot.cn/v1/chat/completions/"), "https://api.moonshot.cn/v1/models");
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
    fn reasoning_extraction() {
        // Ollama qwen3 的 OpenAI 兼容流：content 为空串，思考文本在 delta.reasoning
        let chunk = r#"{"choices":[{"delta":{"content":"","reasoning":"用户"}}]}"#;
        assert_eq!(extract_delta_reasoning(chunk).as_deref(), Some("用户"));
        // DeepSeek-R1 / 部分网关用 reasoning_content
        let alt = r#"{"choices":[{"delta":{"reasoning_content":"先想一下"}}]}"#;
        assert_eq!(extract_delta_reasoning(alt).as_deref(), Some("先想一下"));
        // 忽略 stream 的一次性 message 兜底
        let full = r#"{"choices":[{"message":{"content":"答案","reasoning":"思考"}}]}"#;
        assert_eq!(extract_delta_reasoning(full).as_deref(), Some("思考"));
        // 普通 content 流 / 空 reasoning / 坏形状：不产事件
        assert_eq!(extract_delta_reasoning(r#"{"choices":[{"delta":{"content":"hi"}}]}"#), None);
        assert_eq!(extract_delta_reasoning(r#"{"choices":[{"delta":{"reasoning":""}}]}"#), None);
        assert_eq!(extract_delta_reasoning(r#"{"choices":[{"delta":{"reasoning":42}}]}"#), None);
        assert_eq!(extract_delta_reasoning("not json"), None);
        assert_eq!(extract_delta_reasoning("{}"), None);
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

    /// 把 emit 换成收集器跑 handle_line，返回 (返回值, 事件列表, tool_calls 累积)。
    /// Mutex：EmitFn 要求 Send+Sync
    fn run_line(
        line: &[u8],
    ) -> (
        Option<Result<(), String>>,
        Vec<(String, Option<String>)>,
        Option<Vec<(String, String, String)>>,
    ) {
        let out = Mutex::new(Vec::new());
        let emit = |kind: &str,
                    delta: Option<String>,
                    _error: Option<String>,
                    _tc: Option<serde_json::Value>| {
            out.lock().unwrap().push((kind.to_string(), delta));
        };
        let mut acc = ToolCallAccumulator::default();
        let r = handle_line(line, &emit, &mut acc);
        (r, out.into_inner().unwrap(), acc.finish())
    }

    #[test]
    fn handle_line_emits_and_stops() {
        // 普通增量行 → chunk 事件，不终止
        let (r, events, _) = run_line(b"data: {\"choices\":[{\"delta\":{\"content\":\"hi\"}}]}\n");
        assert!(r.is_none());
        assert_eq!(events, vec![("chunk".into(), Some("hi".into()))]);

        // 推理模型帧：content 空、reasoning 有值 → 只发 reasoning 事件
        let (r, events, _) = run_line(
            b"data: {\"choices\":[{\"delta\":{\"content\":\"\",\"reasoning\":\"\xe6\x80\x9d\"}}]}\n",
        );
        assert!(r.is_none());
        assert_eq!(events, vec![("reasoning".into(), Some("思".into()))]);

        // [DONE] → Ok 终止
        let (r, events, _) = run_line(b"data: [DONE]\n");
        assert_eq!(r, Some(Ok(())));
        assert!(events.is_empty());

        // 流内错误 → Err 终止
        let (r, events, _) = run_line(b"data: {\"error\":{\"message\":\"bad key\"}}\n");
        assert_eq!(r, Some(Err("bad key".into())));
        assert!(events.is_empty());

        // 无关行不发事件
        let (r, events, _) = run_line(b": ping\n");
        assert!(r.is_none());
        assert!(events.is_empty());
        let (r, events, _) = run_line(b"\n");
        assert!(r.is_none());
        assert!(events.is_empty());

        // 跨 chunk 拆坏的多字节序列不会 panic（lossy 兜底），无效行回 None
        let (r, _, _) = run_line(&[0xe4, 0xbd, b'\n']);
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

    #[test]
    fn tool_call_delta_fragment_form() {
        // OpenAI 碎片：首片带 id/name/空 arguments，次片只有 index + arguments 增量
        let v = extract_tool_call_delta(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"search_vault","arguments":""}}]}}]}"#,
        );
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].index, 0);
        assert_eq!(v[0].id.as_deref(), Some("call_1"));
        assert_eq!(v[0].name.as_deref(), Some("search_vault"));
        assert_eq!(v[0].args_delta, "");
        let v2 = extract_tool_call_delta(
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}"#,
        );
        assert_eq!(v2.len(), 1);
        assert_eq!(v2[0].id, None);
        assert_eq!(v2[0].args_delta, "{\"query\":");
    }

    #[test]
    fn tool_call_delta_ollama_whole_object() {
        // Ollama：整对象一次到齐，可能缺 index（按 0 归位）
        let v = extract_tool_call_delta(
            r#"{"choices":[{"delta":{"tool_calls":[{"id":"call_9","function":{"name":"read_note","arguments":"{\"path\":\"a.md\"}"}}]}}]}"#,
        );
        assert_eq!(v[0].index, 0);
        assert_eq!(v[0].id.as_deref(), Some("call_9"));
        assert_eq!(v[0].args_delta, "{\"path\":\"a.md\"}");
    }

    #[test]
    fn tool_call_delta_message_fallback_and_content() {
        // 网关忽略 stream：message.tool_calls 整数组一次返回
        let v = extract_tool_call_delta(
            r#"{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"c","function":{"name":"list_notes","arguments":"{}"}}]}}]}"#,
        );
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].name.as_deref(), Some("list_notes"));
        // 纯 content chunk / 畸形载荷不产增量
        assert!(extract_tool_call_delta(r#"{"choices":[{"delta":{"content":"hi"}}]}"#).is_empty());
        assert!(extract_tool_call_delta("not json").is_empty());
        assert!(extract_tool_call_delta("{}").is_empty());
    }

    #[test]
    fn tool_call_accumulator_groups_by_index() {
        let mut acc = ToolCallAccumulator::default();
        for line in [
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"search_vault","arguments":""}},{"index":1,"id":"c2","function":{"name":"read_note","arguments":""}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\"query\":"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":1,"function":{"arguments":"{\"path\":\"a.md\"}"}}]}}]}"#,
            r#"{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"\"x\"}"}}]}}]}"#,
        ] {
            for d in extract_tool_call_delta(line) {
                acc.push(d);
            }
        }
        assert_eq!(
            acc.finish(),
            Some(vec![
                ("c1".into(), "search_vault".into(), "{\"query\":\"x\"}".into()),
                ("c2".into(), "read_note".into(), "{\"path\":\"a.md\"}".into()),
            ])
        );
        assert_eq!(ToolCallAccumulator::default().finish(), None);
    }

    #[test]
    fn error_body_error_as_string() {
        // Ollama 400 实锤形态：error 是字符串
        assert_eq!(
            extract_error_body(r#"{"error":"m does not support tools"}"#).as_deref(),
            Some("m does not support tools")
        );
        // OpenAI 形态照旧
        assert_eq!(
            extract_error_body(r#"{"error":{"message":"bad key"}}"#).as_deref(),
            Some("bad key")
        );
        assert_eq!(extract_error_body("not json"), None);
        assert_eq!(extract_error_body(r#"{"choices":[]}"#), None);
        // SiliconFlow 形态：顶层 message + 数字 code，没有 error 字段
        assert_eq!(
            extract_error_body(r#"{"code":20012,"message":"Model does not exist. Please check it carefully.","data":null}"#)
                .as_deref(),
            Some("Model does not exist. Please check it carefully.（code 20012）")
        );
        // 顶层 message 的字符串 code 与 msg 别名同样收
        assert_eq!(
            extract_error_body(r#"{"code":"E400","msg":"bad model"}"#).as_deref(),
            Some("bad model（code E400）")
        );
        // error.* 优先于顶层 message（OpenAI 两个都有时不取外层的客套话）
        assert_eq!(
            extract_error_body(r#"{"error":{"message":"inner"},"message":"outer"}"#).as_deref(),
            Some("inner")
        );
        // 只有空串 message 时不编文案，回 None 让调用方截原文
        assert_eq!(extract_error_body(r#"{"message":"   "}"#), None);
        // 流内 error 的字符串形态同样兼容
        assert_eq!(
            extract_sse_error(r#"{"error":"oops"}"#).as_deref(),
            Some("oops")
        );
    }

    #[test]
    fn chat_body_tools_field() {
        let msgs = vec![("user".to_string(), serde_json::json!("hi"))];
        let tools = serde_json::json!([{ "type": "function" }]);
        let body = build_chat_body("m", None, &msgs, Some(&tools));
        assert!(body.get("tools").is_some());
        // None / 空数组 / 非数组都不带 tools
        assert!(build_chat_body("m", None, &msgs, None).get("tools").is_none());
        assert!(build_chat_body("m", None, &msgs, Some(&serde_json::json!([]))).get("tools").is_none());
        assert!(build_chat_body("m", None, &msgs, Some(&serde_json::json!("x"))).get("tools").is_none());
    }

    #[test]
    fn ollama_state_four_tiers() {
        assert_eq!(ollama_state(true, 2, true), "ready");
        assert_eq!(ollama_state(true, 0, true), "no_models");
        assert_eq!(ollama_state(true, 0, false), "no_models"); // 可达优先于可执行文件探测
        assert_eq!(ollama_state(false, 0, true), "stopped");
        assert_eq!(ollama_state(false, 0, false), "missing");
    }

    #[test]
    fn ollama_models_parsing() {
        // 真机 /api/tags 形态（name 与 model 同值，还带 capabilities 等一堆字段）
        let real = r#"{"models":[{"name":"qwen3:1.7b","model":"qwen3:1.7b","size":1359293444},{"name":"tinyllama:latest","model":"tinyllama:latest"}]}"#;
        assert_eq!(parse_ollama_models(real), vec!["qwen3:1.7b", "tinyllama:latest"]);
        // 零模型：空数组与缺字段都是空表（与「不可达」在调用点分开判）
        assert!(parse_ollama_models(r#"{"models":[]}"#).is_empty());
        assert!(parse_ollama_models("{}").is_empty());
        assert!(parse_ollama_models("not json").is_empty());
        // name 缺时取 model；大小写升序
        let alt = r#"{"models":[{"model":"Zeta:1"},{"model":"alpha:2"},{"name":"","model":"fallback:1"}]}"#;
        assert_eq!(parse_ollama_models(alt), vec!["alpha:2", "fallback:1", "Zeta:1"]);
    }

    #[test]
    fn ollama_exe_candidates_per_platform() {
        let env = |k: &str| match k {
            "PATH" => Some("D:\\Ollama\\setup;C:\\Windows".to_string()),
            "LOCALAPPDATA" => Some("C:\\Users\\me\\AppData\\Local".to_string()),
            "HOME" => Some("/home/me".to_string()),
            _ => None,
        };
        let win = ollama_exe_candidates(env, "windows");
        assert!(win.iter().any(|p| p.ends_with("setup\\ollama.exe") || p.to_string_lossy().ends_with("setup/ollama.exe")), "PATH 里的自定义安装目录要扫到：{:?}", win);
        assert!(win.iter().any(|p| p.to_string_lossy().contains("AppData") && p.to_string_lossy().contains("Ollama")), "LOCALAPPDATA 常规位置：{:?}", win);
        let lin = ollama_exe_candidates(|k| if k == "HOME" { Some("/home/me".into()) } else { None }, "linux");
        // 在 Windows 上跑 linux 分支时 join 会混进反斜杠，比的是逻辑路径不是分隔符
        let norm = |p: &std::path::PathBuf| p.to_string_lossy().replace('\\', "/");
        assert!(lin.iter().any(|p| norm(p) == "/usr/bin/ollama"));
        assert!(lin.iter().any(|p| norm(p) == "/home/me/.ollama/bin/ollama"), "HOME 候选没拼对：{:?}", lin.iter().map(norm).collect::<Vec<_>>());
        // PATH 空段不产生「./ollama」这种脏候选
        let empty = ollama_exe_candidates(|_| Some("  ;;".into()), "windows");
        assert!(empty.iter().all(|p| !p.to_string_lossy().trim().is_empty()));
    }

    #[test]
    fn pull_line_parsing() {
        // 真机 NDJSON：manifest / 百分比进度 / success / error 四种
        assert_eq!(
            parse_pull_line(br#"{"status":"pulling manifest"}"#),
            PullLine::Progress { status: "pulling manifest".into(), completed: None, total: None }
        );
        assert_eq!(
            parse_pull_line(br#"{"status":"Downloading 47%","digest":"abc","completed":123,"total":456}"#),
            PullLine::Progress { status: "Downloading 47%".into(), completed: Some(123), total: Some(456) }
        );
        assert_eq!(
            parse_pull_line(br#"{"error":"file not found for model nope:latest"}"#),
            PullLine::Failed("file not found for model nope:latest".into())
        );
        assert_eq!(parse_pull_line(b""), PullLine::Skip);
        assert_eq!(parse_pull_line(b"not json"), PullLine::Skip);
        assert_eq!(parse_pull_line(br#"{"status":""}"#), PullLine::Skip);
        // error 字段存在但空：不判失败，接着看 status
        assert_eq!(
            parse_pull_line(br#"{"error":"","status":"verifying sha256"}"#),
            PullLine::Progress { status: "verifying sha256".into(), completed: None, total: None }
        );
    }

    #[test]
    fn pull_model_name_guard() {
        assert!(pull_model_name_ok("qwen3:1.7b"));
        assert!(pull_model_name_ok("library/foo:latest"));
        assert!(pull_model_name_ok("bar-baz_1"));
        assert!(!pull_model_name_ok(""));
        assert!(!pull_model_name_ok("qwen3 1.7b")); // 空白
        assert!(!pull_model_name_ok("../etc/passwd")); // 上跳单独拦，`/` 本身是合法的
        assert!(!pull_model_name_ok("模型:latest")); // 非 ASCII
        assert!(!pull_model_name_ok(&"a".repeat(121)));
    }

    /// 真机跑一次本机 Ollama 探测（手动：`cargo test --lib -- --ignored ollama_status_live`）。
    /// 没装 Ollama 的机器只会得到 missing / stopped，所以不断言具体档位，只验接线通不通。
    #[test]
    #[ignore]
    fn ollama_status_live() {
        let s = tauri::async_runtime::block_on(ollama_status());
        println!("state = {}, models = {:?}", s.state, s.models);
        assert!(matches!(s.state.as_str(), "ready" | "no_models" | "stopped" | "missing"));
    }

    /// 真机跑一次 /api/pull 的 NDJSON 读取（手动：`cargo test --lib -- --ignored ollama_pull_live`）。
    /// 默认拿本机已有的模型名——已拉过就不下载，秒回 success，刚好把 run_pull 的流式读取与
    /// 逐行解析跑完。要真下一个就 `NL_TEST_OLLAMA_MODEL=xxx cargo test --lib -- --ignored ollama_pull_live`。
    #[test]
    #[ignore]
    fn ollama_pull_live() {
        let model = std::env::var("NL_TEST_OLLAMA_MODEL").unwrap_or_else(|_| "qwen3:1.7b".into());
        let lines: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
        let sink = lines.clone();
        let res = tauri::async_runtime::block_on(run_pull(&model, &move |kind, status, completed, total, error| {
            sink.lock().unwrap().push(format!(
                "{}|{}|{:?}|{:?}|{}",
                kind,
                status.unwrap_or_default(),
                completed,
                total,
                error.unwrap_or_default()
            ));
        }));
        let got = lines.lock().unwrap().clone();
        println!("run_pull({}) -> {:?}\n{}", model, res, got.join("\n"));
        assert!(res.is_ok(), "已装模型不该报错：{:?}", res);
        assert!(!got.is_empty(), "应至少收到一条进度");
        assert!(got.iter().any(|l| l.contains("success")), "末条应是 success：{:?}", got);
        assert!(got.iter().all(|l| l.starts_with("progress|")), "只该有 progress 类型");
    }
}

// voice.rs —— AI 面板的语音输入。
//
// 录音放 Rust 侧（cpal 采集默认输入设备 → 16-bit PCM WAV 临时文件），不走 WebView 的
// getUserMedia：WebView2 对 host 没处理的权限请求默认拒绝，而 wry 只自动放行剪贴板读取，
// 主窗口又来自 tauri.conf.json、挂不了 WebviewWindowBuilder 的 on_permission_request——
// Rust 侧采集把 WebView 权限这条路整个绕开，mac/Linux 将来也直接可用。
//
// 识别两路：
// 1. 服务商 ASR：POST OpenAI 兼容的 /audio/transcriptions（multipart），模型名来自 AI
//    设置的 asrModel 字段，地址与对话同源（base_url 推导，见 asr_url）。
// 2. Windows 原生听写（WinRT SpeechRecognizer 持续识别，事件经 nl:dictation 流回前端），
//    未配 ASR 时的回落；依赖系统装了对应语言的语音识别包，mac/Linux 未做。
//
// 浏览器版（Chrome）不经过本模块：前端 ai-panel.js 检测到无 Tauri IPC 时走 Web Speech API。

use serde::Serialize;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use tauri::{AppHandle, Emitter};

/// 单次录音上限（秒）。语音输入是短句场景，到点前端会自动停并送识别，防止忘按停止。
pub const REC_MAX_SECS: u32 = 120;

// ==================== 录音（cpal → WAV 临时文件） ====================

struct RecJob {
    stop: Arc<AtomicBool>,
    join: Option<std::thread::JoinHandle<()>>,
    sample_rate: u32,
    channels: u16,
    samples: Arc<Mutex<Vec<f32>>>,
}

static REC: OnceLock<Mutex<Option<RecJob>>> = OnceLock::new();

fn rec_slot() -> &'static Mutex<Option<RecJob>> {
    REC.get_or_init(|| Mutex::new(None))
}

#[tauri::command]
pub fn ai_rec_start() -> Result<(), String> {
    let mut slot = rec_slot().lock().map_err(|_| "录音状态损坏")?;
    if slot.is_some() {
        return Err("已在录音中".into());
    }
    let stop = Arc::new(AtomicBool::new(false));
    let samples: Arc<Mutex<Vec<f32>>> = Arc::new(Mutex::new(Vec::new()));
    let (init_tx, init_rx) = std::sync::mpsc::channel::<Result<(u32, u16), String>>();

    // cpal 的 Stream 不是 Send（内含平台裸指针），主线程留不住它——流的建立、播放与
    // 停止全部收进这条专用线程，命令线程只通过共享缓冲和 init 通道与它打交道。
    let stop_t = stop.clone();
    let samples_t = samples.clone();
    let join = std::thread::spawn(move || {
        let started = std::time::Instant::now();
        let run = || -> Result<(cpal::Stream, u32, u16), String> {
            use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
            let host = cpal::default_host();
            let device = host
                .default_input_device()
                .ok_or_else(|| "没有可用的麦克风设备".to_string())?;
            let cfg = device
                .default_input_config()
                .map_err(|e| format!("麦克风配置读取失败: {e}"))?;
            let stream = match cfg.sample_format() {
                cpal::SampleFormat::F32 => {
                    build_stream::<f32>(&device, &cfg, samples_t.clone(), stop_t.clone(), |s| s)?
                }
                cpal::SampleFormat::I16 => build_stream::<i16>(
                    &device,
                    &cfg,
                    samples_t.clone(),
                    stop_t.clone(),
                    |s| s as f32 / 32768.0,
                )?,
                cpal::SampleFormat::U16 => build_stream::<u16>(
                    &device,
                    &cfg,
                    samples_t.clone(),
                    stop_t.clone(),
                    |s| (s as f32 - 32768.0) / 32768.0,
                )?,
                fmt => return Err(format!("不支持的采样格式: {fmt}")),
            };
            stream.play().map_err(|e| format!("麦克风启动失败: {e}"))?;
            Ok((stream, cfg.sample_rate().0, cfg.channels()))
        };
        match run() {
            Ok((stream, rate, ch)) => {
                let _ = init_tx.send(Ok((rate, ch)));
                // 等停止信号；上限再加 10s 作后端兜底（前端看门狗先到点自动停）
                while !stop_t.load(Ordering::Relaxed)
                    && started.elapsed() < std::time::Duration::from_secs((REC_MAX_SECS + 10) as u64)
                {
                    std::thread::sleep(std::time::Duration::from_millis(50));
                }
                drop(stream);
            }
            Err(e) => {
                let _ = init_tx.send(Err(e));
            }
        }
    });

    match init_rx.recv_timeout(std::time::Duration::from_secs(5)) {
        Ok(Ok((rate, ch))) => {
            *slot = Some(RecJob { stop, join: Some(join), sample_rate: rate, channels: ch, samples });
            Ok(())
        }
        Ok(Err(e)) => Err(e),
        Err(_) => {
            stop.store(true, Ordering::Relaxed);
            Err("录音流启动超时".into())
        }
    }
}

fn build_stream<T>(
    device: &cpal::Device,
    cfg: &cpal::SupportedStreamConfig,
    out: Arc<Mutex<Vec<f32>>>,
    stop: Arc<AtomicBool>,
    conv: fn(T) -> f32,
) -> Result<cpal::Stream, String>
where
    T: cpal::SizedSample + Copy + Send + 'static,
{
    use cpal::traits::DeviceTrait;
    let max_samples = (cfg.sample_rate().0 as usize) * REC_MAX_SECS as usize * cfg.channels() as usize;
    let err_fn = move |e| eprintln!("NoteLume 录音流错误: {e}");
    device
        .build_input_stream(
            &cfg.config(),
            move |data: &[T], _| {
                if stop.load(Ordering::Relaxed) {
                    return;
                }
                let Ok(mut buf) = out.lock() else { return };
                if buf.len() >= max_samples {
                    return; // 到上限就不再收，前端看门狗会停
                }
                buf.extend(data.iter().map(|&s| conv(s)));
            },
            err_fn,
            None,
        )
        .map_err(|e| format!("麦克风流建立失败: {e}"))
}

/// 停止录音并把已录内容编码成 WAV 写到临时文件，返回文件路径。文件由 ai_asr_transcribe
/// 读走后删除；前端丢弃识别结果（取消）时也应调 ai_rec_cancel 而不是 stop。
#[tauri::command]
pub fn ai_rec_stop() -> Result<String, String> {
    let job = {
        let mut slot = rec_slot().lock().map_err(|_| "录音状态损坏")?;
        slot.take().ok_or_else(|| "没有进行中的录音".to_string())?
    };
    job.stop.store(true, Ordering::Relaxed);
    if let Some(j) = job.join {
        let _ = j.join(); // 流线程退出后样本不再增长
    }

    let samples = job
        .samples
        .lock()
        .map(|b| b.clone())
        .map_err(|_| "录音缓冲损坏".to_string())?;
    if samples.is_empty() {
        return Err("没有录到声音".into());
    }
    let wav = encode_wav(&samples, job.sample_rate, job.channels);
    let path = std::env::temp_dir().join(format!(
        "notelume-rec-{}.wav",
        chrono::Utc::now().timestamp_millis()
    ));
    std::fs::write(&path, &wav).map_err(|e| format!("录音文件写入失败: {e}"))?;
    Ok(path.to_string_lossy().into_owned())
}

/// 丢弃进行中的录音（面板销毁 / 上限看门狗之外的取消路径）
#[tauri::command]
pub fn ai_rec_cancel() -> bool {
    let Ok(mut slot) = rec_slot().lock() else {
        return false;
    };
    match slot.take() {
        Some(job) => {
            job.stop.store(true, Ordering::Relaxed);
            true
        }
        None => false,
    }
}

/// f32 采样 → 16-bit PCM 单文件 WAV（纯函数，可单测）。超界样本 clamp，避免编码溢出绕回。
pub fn encode_wav(samples: &[f32], sample_rate: u32, channels: u16) -> Vec<u8> {
    let data_len = (samples.len() * 2) as u32;
    let mut out = Vec::with_capacity(44 + data_len as usize);
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data_len).to_le_bytes());
    out.extend_from_slice(b"WAVE");
    out.extend_from_slice(b"fmt ");
    out.extend_from_slice(&16u32.to_le_bytes()); // fmt 块长
    out.extend_from_slice(&1u16.to_le_bytes()); // PCM
    out.extend_from_slice(&channels.to_le_bytes());
    out.extend_from_slice(&sample_rate.to_le_bytes());
    out.extend_from_slice(&(sample_rate * channels as u32 * 2).to_le_bytes()); // 字节率
    out.extend_from_slice(&(channels * 2).to_le_bytes()); // 块对齐
    out.extend_from_slice(&16u16.to_le_bytes()); // 位深
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data_len.to_le_bytes());
    for &s in samples {
        let v = (s.clamp(-1.0, 1.0) * 32767.0) as i16;
        out.extend_from_slice(&v.to_le_bytes());
    }
    out
}

// ==================== 服务商 ASR（OpenAI 兼容 /audio/transcriptions） ====================

/// base_url → /audio/transcriptions 完整地址。与 models_url 同口径：
/// 填到 /chat/completions 时剥回上一级；填到 /audio/transcriptions 就不重复追加。
pub fn asr_url(base_url: &str) -> String {
    let mut b = base_url.trim().trim_end_matches('/');
    if let Some(up) = b.strip_suffix("/chat/completions") {
        b = up.trim_end_matches('/');
    }
    if b.ends_with("/audio/transcriptions") {
        return b.to_string();
    }
    format!("{b}/audio/transcriptions")
}

/// 响应 → 识别文本。成功取顶层 text；失败兼容 error.message / 顶层 message
/// （与 chat 的 extract_error_body 同思路，聚合网关把说明放哪的都有），都解析不出才截原文。
pub fn extract_asr_text(body: &str) -> Result<String, String> {
    let v: serde_json::Value =
        serde_json::from_str(body).map_err(|_| crate::ai::truncate_utf8(body.trim(), 300))?;
    if let Some(t) = v.get("text").and_then(|t| t.as_str()) {
        return Ok(t.trim().to_string());
    }
    for key in ["/error/message", "/message"] {
        if let Some(m) = v.pointer(key).and_then(|m| m.as_str()) {
            if !m.trim().is_empty() {
                return Err(m.trim().to_string());
            }
        }
    }
    Err(crate::ai::truncate_utf8(body.trim(), 300))
}

/// 上传 WAV 到服务商并取回识别文本。识别完即删临时文件（无论成败，不落垃圾）。
#[tauri::command]
pub async fn ai_asr_transcribe(
    base_url: String,
    api_key: Option<String>,
    model: String,
    wav_path: String,
) -> Result<String, String> {
    let model = model.trim().to_string();
    if model.is_empty() {
        return Err("未配置语音识别模型".into());
    }
    let data = std::fs::read(&wav_path).map_err(|e| format!("录音文件读取失败: {e}"))?;
    let _ = std::fs::remove_file(&wav_path);
    if data.is_empty() {
        return Err("录音为空".into());
    }
    let url = asr_url(&base_url);
    if url.is_empty() {
        return Err("接口地址为空".into());
    }
    let file = reqwest::multipart::Part::bytes(data)
        .file_name("audio.wav")
        .mime_str("audio/wav")
        .map_err(|e| format!("multipart: {e}"))?;
    let form = reqwest::multipart::Form::new()
        .text("model", model)
        .part("file", file);
    let client = reqwest::Client::builder()
        .timeout(std::time::Duration::from_secs(120))
        .build()
        .map_err(|e| format!("HTTP client: {e}"))?;
    let mut req = client.post(&url).multipart(form);
    if let Some(k) = api_key {
        if !k.trim().is_empty() {
            req = req.bearer_auth(k.trim());
        }
    }
    let resp = req.send().await.map_err(|e| format!("连接失败: {e}"))?;
    let status = resp.status();
    let body = resp.text().await.unwrap_or_default();
    if !status.is_success() {
        return Err(format!("HTTP {status}: {}", crate::ai::truncate_utf8(body.trim(), 200)));
    }
    extract_asr_text(&body)
}

// ==================== Windows 原生听写（WinRT SpeechRecognizer） ====================

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DictationEvent {
    /// 发起方生成的会话 id：事件广播到所有窗口，各窗口按自己的 reqId 过滤
    pub req_id: String,
    /// hypothesis（中间结果）| result（终稿）| end | error
    pub kind: String,
    pub text: String,
}

fn emit_dictation(app: &AppHandle, req_id: &str, kind: &str, text: &str) {
    eprintln!("[voice] emit req={req_id} kind={kind} text={text:?}");
    let _ = app.emit(
        "nl:dictation",
        DictationEvent { req_id: req_id.to_string(), kind: kind.to_string(), text: text.to_string() },
    );
}

#[cfg(windows)]
struct Dictation {
    recognizer: windows::Media::SpeechRecognition::SpeechRecognizer,
    session: windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
    lang: String,
    running: bool,
    /// 当前会话 id（共享单元：会话复用后同一批事件回调要服务多个 reqId）
    rid: Arc<Mutex<String>>,
}

#[cfg(windows)]
static DICT: OnceLock<Mutex<Option<Dictation>>> = OnceLock::new();

#[cfg(windows)]
fn dict_slot() -> &'static Mutex<Option<Dictation>> {
    DICT.get_or_init(|| Mutex::new(None))
}

#[cfg(windows)]
fn com_init() {
    // WinRT 异步对象要求线程初始化过 COM；Tauri async runtime 的工作线程不会自动初始化
    use windows::Win32::System::Com::{CoInitializeEx, COINIT_MULTITHREADED};
    unsafe {
        let _ = CoInitializeEx(None, COINIT_MULTITHREADED);
    }
}

/// 探测指定语言有没有可用的系统识别引擎（缺语言包 / 引擎编译失败都算不可用）
#[cfg(windows)]
fn dictation_probe_sync(lang: &str) -> Result<bool, String> {
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{SpeechRecognitionResultStatus, SpeechRecognizer};
    use windows::core::HSTRING;

    com_init();
    let l = Language::CreateLanguage(&HSTRING::from(lang))
        .map_err(|e| format!("语言代码无效: {e}"))?;
    let rec = match SpeechRecognizer::Create(&l) {
        Ok(r) => r,
        Err(_) => return Ok(false), // 没装该语言的语音包
    };
    let ok = match rec.CompileConstraintsAsync() {
        Ok(op) => match op.join() {
            Ok(r) => r.Status().map(|s| s == SpeechRecognitionResultStatus::Success).unwrap_or(false),
            Err(_) => false,
        },
        Err(_) => false,
    };
    let _ = rec.Close();
    Ok(ok)
}

/// WinRT 错误 → 给前端的错误串。语音隐私政策未接受（0x80045509）是常见首启障碍：
/// 系统「在线语音识别」开关没开。按微软官方 UWP 示例的动作直接打开对应设置页，
/// 并回哨兵码 `speech-privacy` 让前端给本地化指引；其余原样透传。
#[cfg(windows)]
fn winrt_start_err(what: &str, e: windows::core::Error) -> String {
    // 0x80045509 = SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED
    if e.code().0 == 0x80045509u32 as i32 {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", "ms-settings:privacy-speech"])
            .spawn();
        return "speech-privacy".into();
    }
    format!("{what}: {e}")
}

#[cfg(windows)]
fn dictation_start_sync(app: AppHandle, req_id: &str, lang: &str) -> Result<(), String> {
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{SpeechRecognitionResultStatus, SpeechRecognizer};
    use windows::core::HSTRING;

    com_init();
    let mut slot = dict_slot().lock().map_err(|_| "听写状态损坏")?;
    match slot.as_mut() {
        // 会话常驻复用（2026-11-06）：每次点击销毁重建 recognizer 会跟引擎的麦克风
        // 释放赛跑——上一场刚停、下一场立刻 Start，经常撞上 MicrophoneUnavailable(7)。
        // 同一 session 反复 Start/Stop 是 WinRT 持续识别的设计用法；语言没变就一直复用。
        Some(d) => {
            if d.running {
                return Err("已在听写中".into());
            }
            if d.lang != lang {
                // 界面语言变了：旧引擎作废，走下面的重建路径
                let _ = d.recognizer.Close();
                *slot = None;
            } else {
                *d.rid.lock().map_err(|_| "听写状态损坏")? = req_id.to_string();
                d.session
                    .StartAsync()
                    .map_err(|e| winrt_start_err("听写启动失败", e))?
                    .join()
                    .map_err(|e| winrt_start_err("听写启动失败", e))?;
                d.running = true;
                eprintln!("[voice] reused session, req={req_id}");
                return Ok(());
            }
        }
        None => {}
    }

    let l = Language::CreateLanguage(&HSTRING::from(lang))
        .map_err(|e| format!("语言代码无效: {e}"))?;
    let recognizer = SpeechRecognizer::Create(&l)
        .map_err(|e| format!("系统语音识别不可用（可能缺语言包）: {e}"))?;
    let compiled = recognizer
        .CompileConstraintsAsync()
        .map_err(|e| winrt_start_err("语音引擎初始化失败", e))?
        .join()
        .map_err(|e| winrt_start_err("语音引擎初始化失败", e))?;
    let status_ok = compiled
        .Status()
        .map(|s| s == SpeechRecognitionResultStatus::Success)
        .unwrap_or(false);
    if !status_ok {
        let _ = recognizer.Close();
        return Err("语音引擎初始化失败（该语言可能缺识别引擎）".into());
    }
    let session = recognizer
        .ContinuousRecognitionSession()
        .map_err(|e| format!("持续识别会话建立失败: {e}"))?;

    let rid: Arc<Mutex<String>> = Arc::new(Mutex::new(req_id.to_string()));
    dictation_register_events(&app, &recognizer, &session, &rid)?;
    dictation_register_state_log(&recognizer);

    session
        .StartAsync()
        .map_err(|e| winrt_start_err("听写启动失败", e))?
        .join()
        .map_err(|e| winrt_start_err("听写启动失败", e))?;

    *slot = Some(Dictation {
        recognizer,
        session,
        lang: lang.to_string(),
        running: true,
        rid,
    });
    Ok(())
}

/// 事件委托：hypothesis 是中间结果（interim），result 是逐段终稿，completed 收尾。
/// 回调跑在系统线程池上，只做 emit，不碰长锁。rid 用共享单元而不是创建时快照——
/// 会话复用后同一批回调要服务多个 reqId。
#[cfg(windows)]
fn dictation_register_events(
    app: &AppHandle,
    recognizer: &windows::Media::SpeechRecognition::SpeechRecognizer,
    session: &windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
    rid: &Arc<Mutex<String>>,
) -> Result<(), String> {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionResultGeneratedEventArgs,
        SpeechRecognitionHypothesisGeneratedEventArgs,
    };

    let app_h = app.clone();
    let rid_h = rid.clone();
    recognizer
        .HypothesisGenerated(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechRecognizer,
            SpeechRecognitionHypothesisGeneratedEventArgs,
        >::new(move |_, e| {
            if let Ok(t) = e.ok().and_then(|x| x.Hypothesis()).and_then(|h| h.Text()) {
                let rid = rid_h.lock().map(|s| s.clone()).unwrap_or_default();
                emit_dictation(&app_h, &rid, "hypothesis", &t.to_string_lossy());
            }
            Ok(())
        }))
        .map_err(|e| format!("听写事件挂载失败: {e}"))?;

    let app_h = app.clone();
    let rid_h = rid.clone();
    session
        .ResultGenerated(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >::new(move |_, e| {
            if let Ok(t) = e.ok().and_then(|x| x.Result()).and_then(|r| r.Text()) {
                let rid = rid_h.lock().map(|s| s.clone()).unwrap_or_default();
                emit_dictation(&app_h, &rid, "result", &t.to_string_lossy());
            }
            Ok(())
        }))
        .map_err(|e| format!("听写事件挂载失败: {e}"))?;

    let app_h = app.clone();
    session
        .Completed(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionCompletedEventArgs,
        >::new(move |_, e| {
            let code = e.ok().and_then(|c| c.Status()).map(|s| s.0).unwrap_or(-1);
            // 槽位还在且标记 running：引擎自己终止的会话（StopAsync 的正常收尾走
            // stop 路径，已先置 running=false）。常见失败是无包身份被拒麦克风
            // （状态码 7 MicrophoneUnavailable）——清掉死引擎，下次 start 重建。
            let mut handled = None;
            if let Ok(mut slot) = dict_slot().lock() {
                if let Some(d) = slot.as_mut() {
                    if d.running {
                        d.running = false;
                        let d = slot.take().unwrap();
                        let _ = d.recognizer.Close();
                        let rid = d.rid.lock().map(|s| s.clone()).unwrap_or_default();
                        handled = Some((code, rid));
                    }
                }
            }
            if let Some((code, rid)) = handled {
                eprintln!("[voice] session self-terminated, status = {code}");
                // 7 = MicrophoneUnavailable：引擎拿不到麦克风，给前端专项指引。
                // 5 = PauseLimitReached：连续识别的累计时长上限，属正常收尾，发 end。
                if code == 7 {
                    emit_dictation(&app_h, &rid, "error", "mic-unavailable");
                } else {
                    emit_dictation(&app_h, &rid, "end", "");
                }
            }
            // 槽位空或已停：end 由 stop 路径发，这里不重复
            Ok(())
        }))
        .map_err(|e| format!("听写事件挂载失败: {e}"))?;
    Ok(())
}

/// 状态变化日志（诊断：识别器是否真的在收音）
#[cfg(windows)]
fn dictation_register_state_log(recognizer: &windows::Media::SpeechRecognition::SpeechRecognizer) {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{SpeechRecognizer, SpeechRecognizerStateChangedEventArgs};
    let _ = recognizer.StateChanged(&TypedEventHandler::<
        SpeechRecognizer,
        SpeechRecognizerStateChangedEventArgs,
    >::new(|_, e| {
        if let Ok(s) = e.ok().and_then(|x| x.State()) {
            eprintln!("[voice] recognizer state -> {s:?}");
        }
        Ok(())
    }));
}

#[cfg(windows)]
fn dictation_stop_sync(app: AppHandle) -> Result<(), String> {
    let (rid, stop_op) = {
        let mut slot = dict_slot().lock().map_err(|_| "听写状态损坏")?;
        match slot.as_mut() {
            Some(d) if d.running => {
                d.running = false; // 先置位：Completed 回调看到非 running 就不按自终处理
                let rid = d.rid.lock().map(|s| s.clone()).unwrap_or_default();
                (rid, d.session.StopAsync().ok())
            }
            _ => (String::new(), None),
        }
    };
    if let Some(op) = stop_op {
        if let Err(e) = op.join() {
            eprintln!("[voice] stop error: {e}");
        }
    }
    if !rid.is_empty() {
        emit_dictation(&app, &rid, "end", "");
    }
    // 引擎与 session 留在槽位里供下次 start 复用；引擎自终（Completed 时 running 仍
    // 为 true）才整个作废重建
    Ok(())
}

#[tauri::command]
pub async fn ai_dictation_start(app: AppHandle, req_id: String, lang: String) -> Result<(), String> {    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || dictation_start_sync(app, &req_id, &lang))
            .await
            .map_err(|e| format!("听写任务异常: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = (app, req_id, lang);
        Err("系统语音识别仅 Windows 支持".into())
    }
}

#[tauri::command]
pub async fn ai_dictation_stop(app: AppHandle) -> Result<(), String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || dictation_stop_sync(app))
            .await
            .map_err(|e| format!("听写任务异常: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = app;
        Ok(())
    }
}

#[tauri::command]
pub async fn ai_dictation_probe(lang: String) -> Result<bool, String> {
    #[cfg(windows)]
    {
        return tauri::async_runtime::spawn_blocking(move || dictation_probe_sync(&lang))
            .await
            .map_err(|e| format!("探测任务异常: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        let _ = lang;
        Ok(false)
    }
}

// ==================== 单测 ====================

#[cfg(test)]
mod tests {
    use super::*;

    /// 临时排查：独立进程里起 WinRT 持续识别 10 秒，观察状态与事件（需要出声才有 result）
    #[test]
    #[ignore]
    fn dictation_live_diagnose() {
        use windows::Foundation::TypedEventHandler;
        use windows::Globalization::Language;
        use windows::Media::SpeechRecognition::{
            SpeechContinuousRecognitionCompletedEventArgs, SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
            SpeechRecognitionHypothesisGeneratedEventArgs, SpeechRecognizer, SpeechRecognizerStateChangedEventArgs,
        };
        use windows::core::HSTRING;

        com_init();
        let lang = std::env::var("DICT_LANG").unwrap_or_else(|_| "zh-CN".into());
        let l = Language::CreateLanguage(&HSTRING::from(lang.as_str())).unwrap();
        let rec = SpeechRecognizer::Create(&l).unwrap();
        let compiled = rec.CompileConstraintsAsync().unwrap().join().unwrap();
        println!("compile status: {:?}", compiled.Status());
        let _ = rec.StateChanged(&TypedEventHandler::<
            SpeechRecognizer,
            SpeechRecognizerStateChangedEventArgs,
        >::new(|_, e| {
            if let Ok(s) = e.ok().and_then(|x| x.State()) {
                println!("state -> {s:?}");
            }
            Ok(())
        }));
        let _ = rec.HypothesisGenerated(&TypedEventHandler::<
            SpeechRecognizer,
            SpeechRecognitionHypothesisGeneratedEventArgs,
        >::new(|_, e| {
            if let Ok(t) = e.ok().and_then(|x| x.Hypothesis()).and_then(|h| h.Text()) {
                println!("hypothesis: {t}");
            }
            Ok(())
        }));
        let session = rec.ContinuousRecognitionSession().unwrap();
        let _ = session.ResultGenerated(&TypedEventHandler::<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionResultGeneratedEventArgs,
        >::new(|_, e| {
            if let Ok(t) = e.ok().and_then(|x| x.Result()).and_then(|r| r.Text()) {
                println!("result: {t}");
            }
            Ok(())
        }));
        let _ = session.Completed(&TypedEventHandler::<
            SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionCompletedEventArgs,
        >::new(|_, e| {
            if let Ok(c) = e.ok() {
                println!("completed: {:?}", c.Status());
            }
            Ok(())
        }));
        match session.StartAsync().unwrap().join() {
            Ok(_) => println!("started"),
            Err(e) => {
                println!("start failed: {e} hr={:?}", e.code().0);
                return;
            }
        }
        println!("state after start: {:?}", rec.State());
        std::thread::sleep(std::time::Duration::from_secs(10));
        println!("state at 10s: {:?}", rec.State());
        let _ = session.StopAsync().unwrap().join();
        let _ = rec.Close();
    }

    #[test]
    fn asr_url_variants() {
        // 常规：剥尾斜杠追加
        assert_eq!(asr_url("https://api.deepseek.com/v1/"), "https://api.deepseek.com/v1/audio/transcriptions");
        // 用户直接填到 chat 地址：剥回上一级再挂
        assert_eq!(
            asr_url("https://api.siliconflow.cn/v1/chat/completions"),
            "https://api.siliconflow.cn/v1/audio/transcriptions"
        );
        // 已填到 transcription 地址：不重复追加
        assert_eq!(
            asr_url("https://x.cn/v1/audio/transcriptions/"),
            "https://x.cn/v1/audio/transcriptions"
        );
        assert_eq!(asr_url(" https://a.b/v1 "), "https://a.b/v1/audio/transcriptions");
    }

    #[test]
    fn wav_header_and_payload() {
        let samples = [0.0f32, 0.5, -0.5, 1.5]; // 1.5 会被 clamp 到 1.0
        let wav = encode_wav(&samples, 44100, 1);
        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(&wav[12..16], b"fmt ");
        assert_eq!(u16::from_le_bytes([wav[20], wav[21]]), 1); // PCM
        assert_eq!(u16::from_le_bytes([wav[22], wav[23]]), 1); // 单声道
        assert_eq!(u32::from_le_bytes([wav[24], wav[25], wav[26], wav[27]]), 44100);
        assert_eq!(u16::from_le_bytes([wav[34], wav[35]]), 16); // 位深
        assert_eq!(&wav[36..40], b"data");
        assert_eq!(u32::from_le_bytes([wav[40], wav[41], wav[42], wav[43]]), 8); // 4 样本 ×2 字节
        assert_eq!(wav.len(), 44 + 8);
        // 编码值：clamp 与 16-bit 量化
        let v0 = i16::from_le_bytes([wav[44], wav[45]]);
        let v1 = i16::from_le_bytes([wav[46], wav[47]]);
        let v2 = i16::from_le_bytes([wav[48], wav[49]]);
        let v3 = i16::from_le_bytes([wav[50], wav[51]]);
        assert_eq!(v0, 0);
        assert!(v1 > 16000);
        assert!(v2 < -16000);
        assert_eq!(v3, 32767);
        // 立体声的字节率字段
        let wav2 = encode_wav(&[0.0, 0.0], 48000, 2);
        assert_eq!(u32::from_le_bytes([wav2[28], wav2[29], wav2[30], wav2[31]]), 48000 * 2 * 2);
    }

    #[test]
    fn asr_text_extraction() {
        assert_eq!(extract_asr_text(r#"{"text":"你好 世界"}"#).unwrap(), "你好 世界");
        // 首尾空白剥掉
        assert_eq!(extract_asr_text(r#"{"text":"  hi  "}"#).unwrap(), "hi");
        // error.message 兜底
        assert_eq!(
            extract_asr_text(r#"{"error":{"message":"model not found"}}"#).unwrap_err(),
            "model not found"
        );
        // 顶层 message（SiliconFlow 一类网关）
        assert_eq!(extract_asr_text(r#"{"code":20012,"message":"bad model"}"#).unwrap_err(), "bad model");
        // 非 JSON：截原文
        assert_eq!(extract_asr_text("<html>oops</html>").unwrap_err(), "<html>oops</html>");
        // JSON 但没 text 也没 message
        assert!(extract_asr_text(r#"{"data":null}"#).is_err());
    }
}

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
//    听写的生命周期不看微软文档里的「静默上限」——真机实测持续识别只听得约 5 秒静默，
//    到点就 `Completed`（状态码 7）自己收场；收场不是故障，得由前端再 start 一场接上
//    （见 `dictation_done_signal` 的 `auto-ended`），否则用户点完麦克风还没来得及开口就没了。
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
    /// 本场 StartAsync 完成的一刻，用来认「上一场迟到的 Completed」（见 completed_counts）
    started_at: Option<std::time::Instant>,
}

#[cfg(windows)]
static DICT: OnceLock<Mutex<Option<Dictation>>> = OnceLock::new();

#[cfg(windows)]
fn dict_slot() -> &'static Mutex<Option<Dictation>> {
    DICT.get_or_init(|| Mutex::new(None))
}

/// 建立 / 拆除 / 探测会话的串行锁。它和 dict_slot 分成两把是有意的：start/stop 要跨
/// WinRT 的阻塞调用（`join()`），而 Completed 回调只碰状态锁——合成一把时回调等锁、
/// 建立会话的那条线程等回调，整条语音链就死在那儿（此前是持状态跨 StartAsync().join()）。
/// 加锁顺序永远是 ops → 状态，反向没有。
#[cfg(windows)]
static DICT_OPS: OnceLock<Mutex<()>> = OnceLock::new();

#[cfg(windows)]
fn dict_ops() -> &'static Mutex<()> {
    DICT_OPS.get_or_init(|| Mutex::new(()))
}

/// 0x80045509 = SPERR_SPEECH_PRIVACY_POLICY_NOT_ACCEPTED
#[cfg(windows)]
const SPERR_SPEECH_PRIVACY: i32 = 0x80045509u32 as i32;

#[cfg(windows)]
fn is_speech_privacy(e: &windows::core::Error) -> bool {
    e.code().0 == SPERR_SPEECH_PRIVACY
}

/// 启动后多久之内到的 Completed 算「上一场的尾巴」（秒）。见 completed_counts。
pub const DICT_START_GRACE_SECS: u64 = 2;

/// Completed 的状态码 → 发给前端的 (kind, text)。数字按 windows 0.62 的
/// `SpeechRecognitionResultStatus` 常量表来，不是 MSDN 页面里的排列也不是直觉序：
/// Success 0 / TopicLanguageNotSupported 1 / GrammarLanguageMismatch 2 /
/// GrammarCompilationFailure 3 / AudioQualityFailure 4 / UserCanceled 5 / Unknown 6 /
/// TimeoutExceeded 7 / PauseLimitExceeded 8 / NetworkFailure 9 / MicrophoneUnavailable 10。
/// 分档口径来自真机：引擎在「没听到可用语音」时收场用的是 7（本机实测约 6 秒），
/// 听到一段又没下文时收场用 5（本机实测约 22 秒）——两者都不是故障，而是「这一局完了、
/// 下一局还听不听由用户决定」，所以归成一档 `auto-ended`，前端据此原地续场。
/// 此前把 7 当成 MicrophoneUnavailable，于是每次静默自终都在界面上报「拿不到麦克风、
/// 改用服务商 ASR」（看着像整个功能坏了），而真被拒的 10 反倒当正常收尾吞掉。
pub fn dictation_done_signal(code: i32) -> (&'static str, String) {
    match code {
        0 | 4 | 5 | 7 | 8 => ("end", "auto-ended".into()),
        9 => ("error", "network-unavailable".into()),
        10 => ("error", "mic-unavailable".into()),
        c => ("error", format!("engine-error:{c}")),
    }
}

/// 引擎自己收场的那几种状态码（与 dictation_done_signal 的 0|4|5|7|8 同一口径）
pub const fn is_auto_end(code: i32) -> bool {
    matches!(code, 0 | 4 | 5 | 7 | 8)
}

/// 引擎报的音频问题码 → 给前端的哨兵。windows 0.62 的 `SpeechRecognitionAudioProblem`：
/// None 0 / TooNoisy 1 / NoSignal 2 / TooLoud 3 / TooQuiet 4 / TooFast 5 / TooSlow 6。
/// None 不算问题（回空串）；其余都是「引擎听见了但用不了」，得由前端说出来。
pub fn audio_problem_signal(code: i32) -> &'static str {
    match code {
        0 => "",
        1 => "too-noisy",
        2 => "no-signal",
        3 => "too-loud",
        4 => "too-quiet",
        c if c > 0 => "bad-input-speed",
        _ => "",
    }
}

/// 这条 Completed 该不该终止当前会话。
///
/// 刚 StartAsync 之后的窗口里会收到两种收尾类事件：上一场 stop 迟到的尾巴（带
/// Success / TimeoutExceeded 这类状态），与这一场真的秒自终。光看时间分不开——
/// 装机版实测把尾巴挡掉的同时也把真的秒自终挡掉了，结果是 `running` 挂着 true、
/// 引擎早停了，界面蓝着不出字，只能等用户再点一下。所以窗口内还要问一句引擎
/// 还在不在收声：还在收 = 尾巴（不算）；已经 Idle = 真收完了（算）。
/// 故障类（麦克风 / 网络 / 引擎）不受窗口限制：那种必须当场告诉用户，
/// 不然界面停在听写态、下次点击只得到「已在听写中」。
pub fn completed_counts(code: i32, just_started: bool, engine_busy: bool) -> bool {
    if !just_started {
        return true
    }
    if !is_auto_end(code) {
        return true
    }
    !engine_busy
}

/// 自终后引擎要不要留着。静默超时只是「这一局没说话」，session 还能接着用：留着它，
/// 前端原地续一场只要几十毫秒（重建要 0.5s）；麦克风 / 网络 / 引擎异常当它已废，整个
/// 作废重建，否则下一次 start 就在同一条死路上再撞一回。
pub fn dictation_keeps_engine(signal_text: &str) -> bool {
    signal_text == "auto-ended"
}

/// 听写的静默上限（秒），取与 ASR 那路的录音上限同源。
/// 口径说明：这是微软文档里控制「静默多久算说完」的属性，但本机实测它不是今天这个情形的
/// 闸门——设成 120s 并回读到 120s，引擎仍在约 6 秒没有可用语音时自终（status 7）。真正
/// 让听写能连续下去的是 Completed 后的续场，这里只是把能设的先设到位。
pub const DICT_SILENCE_LIMIT_SECS: i64 = REC_MAX_SECS as i64;

/// 秒 → WinRT TimeSpan 的步长数（100 纳秒一格，纯函数）
pub const fn timespan_ticks(secs: i64) -> i64 {
    secs * 10_000_000
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
    use windows::Media::SpeechRecognition::SpeechRecognizer;
    use windows::core::HSTRING;

    com_init();
    // 探测要另起一个 recognizer，与 start/stop 串行才不去抢正在跑的那场麦克风；
    // 已经有会话在跑时直接回 true——引擎显然可用，再起一个只会徒增一次麦克风争用
    //（那个失败会被前端缓存成 nativeDictOk = false，语音就再也排不上这条队）。
    let _ops = dict_ops().lock().map_err(|_| "听写状态损坏")?;
    if dict_running() {
        return Ok(true);
    }
    let l = Language::CreateLanguage(&HSTRING::from(lang))
        .map_err(|e| format!("语言代码无效: {e}"))?;
    let rec = match SpeechRecognizer::Create(&l) {
        Ok(r) => r,
        Err(_) => return Ok(false), // 没装该语言的语音包
    };
    // 探测也要拿听写语法去编译，不然探到的与真正听写用的不是同一套语法
    if let Err(e) = add_dictation_constraint(&rec) {
        let _ = rec.Close();
        return Err(e);
    }
    let ok = {
        let r = rec.clone();
        winrt_block("识别引擎探测", DICT_START_WAIT_SECS, move || {
            r.CompileConstraintsAsync().and_then(|op| op.join())
        })
        .ok()
        .and_then(|inner| inner.ok())
        .map(|rr| {
            let st = rr.Status().map(|s| s.0).unwrap_or(-999);
            let good = st == 0;
            // 把探测到的编译状态打出来：探到 false 会让整条语音输入判成「不可用」并缓存，
            // 没有这一行日志就只能看到「点了不亮」而不知道为什么
            eprintln!("[voice] probe compile status = {st} → {}", if good { "可用" } else { "不可用" });
            good
        })
        .unwrap_or(false)
    };
    let _ = rec.Close();
    Ok(ok)
}

/// 把识别场景切成听写（Dictation）。
///
/// 不加这条约束时用的是系统语法（`WebSearch` 场景，面向搜索短查询）：引擎确实收到了声音
///（状态机走 Capturing → SoundStarted → SpeechDetected → SoundEnded），但 `HypothesisGenerated`
/// 与 `ResultGenerated` 一个也不发、也不报错——用户看到的就是「点了麦克风、话说完了，
/// 输入框一个字也没有，也没任何提示」。微软自己的 DictClient 听写示例就是先 Append
/// 一条 Dictation 的 topic constraint 再 CompileConstraints，这里补上同一个动作。
#[cfg(windows)]
fn add_dictation_constraint(
    recognizer: &windows::Media::SpeechRecognition::SpeechRecognizer,
) -> Result<(), String> {
    use windows::Media::SpeechRecognition::{
        ISpeechRecognitionConstraint, SpeechRecognitionScenario, SpeechRecognitionTopicConstraint,
    };
    use windows::core::{HSTRING, Interface};

    let hint = HSTRING::from(DICT_TOPIC_HINT);
    let constraint = SpeechRecognitionTopicConstraint::Create(SpeechRecognitionScenario::Dictation, &hint)
        .map_err(|e| format!("听写语法建立失败: {e}"))?;
    let constraints = recognizer.Constraints().map_err(|e| format!("听写语法读取失败: {e}"))?;
    // 重入保护：复用会话不重建引擎，但 start 里只在新建时走到这里；万一条目已存在就换掉而不是叠加
    while constraints.Size().map_err(|e| format!("听写语法条目读取失败: {e}"))? > 0 {
        constraints.RemoveAt(0).map_err(|e| format!("听写语法条目清除失败: {e}"))?;
    }
    let item: ISpeechRecognitionConstraint = constraint
        .cast()
        .map_err(|e| format!("听写语法类型转换失败: {e}"))?;
    constraints
        .Append(&item)
        .map_err(|e| format!("听写语法挂载失败: {e}"))?;
    eprintln!("[voice] dictation grammar on, topic hint = {DICT_TOPIC_HINT}");
    Ok(())
}

/// topic constraint 的提示语（只是给引擎的文本标签，不进识别结果；照微软 DictClient 示例给个
/// ASCII 值，免得中文标签在 HSTRING 转换那条链上多一个变量）
pub const DICT_TOPIC_HINT: &str = "Dictation";

/// WinRT 错误 → 给前端的错误串。语音隐私政策未接受（0x80045509）是常见首启障碍：
/// 系统「在线语音识别」开关没开。按微软官方 UWP 示例的动作直接打开对应设置页，
/// 并回哨兵码 `speech-privacy` 让前端给本地化指引；其余原样透传。
#[cfg(windows)]
fn winrt_start_err(what: &str, e: windows::core::Error) -> String {
    if is_speech_privacy(&e) {
        let _ = std::process::Command::new("cmd")
            .args(["/c", "start", "", "ms-settings:privacy-speech"])
            .spawn();
        return "speech-privacy".into();
    }
    format!("{what}: {e}")
}

/// 建立一场会话的等待上限（秒）。
/// 为什么要有这个数：`StartAsync()?.join()` 本身没有上限，而它跑在拿着 `DICT_OPS` 的那条
/// 线程上——引擎真卡住时，之后每次点麦克风都排在这条锁后面，用户看到的就是「语音彻底点不动」。
/// 超时就当场报错并把锁放掉：宁可这一次失败，不要把整个功能卡死。
/// 真机实测确实会卡（2026-11-06）：连续四五场 5 秒自终后点停止，`StopAsync` 等了 12 秒
/// 没回来；有了上限，界面 6 秒后回到空闲并说一句没响应，而不是蓝住再也不应。
/// 停止的上限比启动短：点停要当场给反馈，而启动那一路带了引擎初始化，本来就要上百毫秒到秒级。
pub const DICT_START_WAIT_SECS: u64 = 12;
/// 停一场会话的等待上限（秒）
pub const DICT_STOP_WAIT_SECS: u64 = 6;

/// 把一场 WinRT 阻塞调用搬到独立线程上等，最多等 `secs` 秒。
/// 超时后那条线程不会回来（它卡在 WinRT 里），但锁回来了——这是故意的取舍：
/// 泄一条线程比泄掉整个语音输入便宜，而且下一次 start 失败时会当场作废引擎重建。
#[cfg(windows)]
fn winrt_block<T, F>(label: &str, secs: u64, f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> T + Send + 'static,
{
    let (tx, rx) = std::sync::mpsc::channel::<T>();
    std::thread::spawn(move || {
        let _ = tx.send(f());
    });
    match rx.recv_timeout(std::time::Duration::from_secs(secs)) {
        Ok(v) => Ok(v),
        Err(_) => {
            eprintln!("[voice] {label}超时（>{secs}s），放弃本次操作");
            Err(format!("{label}超时（{secs} 秒），系统语音识别没响应"))
        }
    }
}

/// StartAsync 的两段（拿 op、等它完成）并成一个结果；错误串已经过 `winrt_start_err` 加工
///（隐私未开时回哨兵 `speech-privacy`）。
#[cfg(windows)]
fn session_start(
    session: &windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
) -> Result<(), String> {
    let s = session.clone();
    winrt_block("听写启动", DICT_START_WAIT_SECS, move || s.StartAsync().and_then(|op| op.join()))
        .and_then(|r| r.map_err(|e| winrt_start_err("听写启动失败", e)))
}

/// 引擎现在还在收声吗。按 windows 0.62 的 `SpeechRecognizerState`：Idle 0 / Capturing 1 /
/// Processing 2 / SoundStarted 3 / SoundEnded 4 / SpeechDetected 5 / Paused 6——只有 Idle
/// 算「没在收」。停止那一路靠它分情况，不靠自己的 running 标记（两者会错位）。
pub const fn engine_is_busy(state: i32) -> bool {
    state != 0
}

/// StopAsync 同样上上限；回 Err 的只是「等不到」，不是「没停」
#[cfg(windows)]
fn session_stop(
    session: &windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
    recognizer: &windows::Media::SpeechRecognition::SpeechRecognizer,
) -> Result<(), String> {
    // 引擎早就自己收场了就不要等 StopAsync。真机实测：这种时候 StopAsync 永远不回来，
    // 用户看到的就是「点了停止要等 6 秒才灭」（Completed 与本模块的 running 标记之间会有
    // 错位：启动后短时间窗口内到的收尾类事件会被当成上一场的尾巴丢掉）。State 是只读属性，
    // 不阻塞，问一句比等一个不会回来的操作便宜。
    let busy = recognizer.State().map(|s| engine_is_busy(s.0)).unwrap_or(true);
    if !busy {
        eprintln!("[voice] 引擎已经不在收声，跳过 StopAsync");
        return Ok(());
    }
    let s = session.clone();
    winrt_block("听写停止", DICT_STOP_WAIT_SECS, move || s.StopAsync().and_then(|op| op.join()))
        .map_err(|e| format!("{e}"))
        .and_then(|r| r.map_err(|e| format!("听写停止失败: {e}")))
}

/// 把引擎从槽位里摘掉并关掉（下一次 start 走重建）。
/// Close() 是 WinRT 调用，必须在状态锁外做：锁里只取走对象，否则这里一卡，
/// stop 与 Completed 回调都拿不到状态锁，整个语音输入会从此不应答。
#[cfg(windows)]
fn discard_engine() {
    let old = match dict_slot().lock() {
        Ok(mut slot) => slot.take(),
        Err(_) => None,
    };
    if let Some(d) = old {
        let _ = d.recognizer.Close();
    }
}

/// 现在有没有一场听写在跑
#[cfg(windows)]
fn dict_running() -> bool {
    dict_slot().lock().map(|s| s.as_ref().map(|d| d.running).unwrap_or(false)).unwrap_or(false)
}

#[cfg(windows)]
fn dictation_start_sync(app: AppHandle, req_id: &str, lang: &str) -> Result<(), String> {
    use windows::Globalization::Language;
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionSession, SpeechRecognitionResultStatus, SpeechRecognizer,
    };
    use windows::core::HSTRING;

    enum Plan {
        Reuse(SpeechContinuousRecognitionSession),
        Build,
    }

    com_init();
    // 只串行 start/stop/probe；状态锁在下面只用于几行读写，WinRT 的阻塞调用一律在锁外。
    let _ops = dict_ops().lock().map_err(|_| "听写状态损坏")?;

    // 会话常驻复用：每次点击都销毁重建 recognizer 会跟引擎的麦克风释放赛跑。同一 session
    // 反复 Start/Stop 是 WinRT 持续识别的设计用法；语言变了或引擎已不在了才重建。
    let plan = {
        let mut slot = dict_slot().lock().map_err(|_| "听写状态损坏")?;
        match slot.as_mut() {
            Some(d) if d.running => return Err("已在听写中".into()),
            Some(d) if d.lang == lang => {
                *d.rid.lock().map_err(|_| "听写状态损坏")? = req_id.to_string();
                Plan::Reuse(d.session.clone())
            }
            _ => Plan::Build,
        }
    };
    if matches!(plan, Plan::Build) {
        discard_engine(); // 语言变了或槽位已空：旧引擎不留，下一次从头建
    }

    // 复用那一路：StartAsync 失败不要把坏引擎留在槽位里——那之后每次点击都在同一条
    // 死路上撞（用户视角＝语音彻底打不开），当场作废重建。
    if let Plan::Reuse(session) = plan {
        match session_start(&session) {
            Ok(()) => {
                let mut slot = dict_slot().lock().map_err(|_| "听写状态损坏")?;
                if let Some(d) = slot.as_mut() {
                    d.running = true;
                    d.started_at = Some(std::time::Instant::now());
                }
                eprintln!("[voice] reused session, req={req_id}");
                return Ok(());
            }
            Err(msg) => {
                if msg == "speech-privacy" {
                    return Err(msg);
                }
                eprintln!("[voice] reused session failed: {msg}；作废引擎重建");
                discard_engine();
            }
        }
    }

    let l = Language::CreateLanguage(&HSTRING::from(lang))
        .map_err(|e| format!("语言代码无效: {e}"))?;
    let recognizer = SpeechRecognizer::Create(&l)
        .map_err(|e| format!("系统语音识别不可用（可能缺语言包）: {e}"))?;
    // 听写语法必须在 Compile 之前挂上（见 add_dictation_constraint）
    add_dictation_constraint(&recognizer)?;
    let compiled = {
        let r = recognizer.clone();
        winrt_block("语音引擎初始化", DICT_START_WAIT_SECS, move || {
            r.CompileConstraintsAsync().and_then(|op| op.join())
        })
        .and_then(|inner| inner.map_err(|e| winrt_start_err("语音引擎初始化失败", e)))?
    };
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

    // 静默上限：微软文档里「静默多久算说完」的那个开关。实测不是今天这个情形的闸门
    //（见 DICT_SILENCE_LIMIT_SECS 的注释），但默认值确实比用户想一句话的时间短。
    // 设完读回一次：这个属性接受写入但会被引擎自己夹到允许区间，不看回读值就不知道实际生效多少。
    match session.SetAutoStopSilenceTimeout(windows::Foundation::TimeSpan {
        Duration: timespan_ticks(DICT_SILENCE_LIMIT_SECS),
    }) {
        Ok(()) => {
            let back = session
                .AutoStopSilenceTimeout()
                .map(|t| t.Duration / 10_000_000)
                .unwrap_or(i64::MIN);
            eprintln!("[voice] auto-stop silence limit: 请求 {DICT_SILENCE_LIMIT_SECS}s, 生效 {back}s")
        }
        Err(e) => eprintln!("[voice] 静默上限没设上（{e}），按系统默认继续"),
    }

    let rid: Arc<Mutex<String>> = Arc::new(Mutex::new(req_id.to_string()));
    dictation_register_events(&app, &recognizer, &session, &rid)?;
    dictation_register_diag(&app, &recognizer, &rid);

    if let Err(e) = session_start(&session) {
        // 新引擎也起不来：当场就拆掉，不留一个半死的会话给下一次
        let _ = recognizer.Close();
        return Err(e);
    }

    let mut slot = dict_slot().lock().map_err(|_| "听写状态损坏")?;
    *slot = Some(Dictation {
        recognizer,
        session,
        lang: lang.to_string(),
        running: true,
        rid,
        started_at: Some(std::time::Instant::now()),
    });
    eprintln!("[voice] new session, req={req_id}");
    Ok(())
}

/// 事件委托：hypothesis 是中间结果（interim），result 是逐段终稿，completed 收尾。
/// 回调跑在系统线程池上，只在短锁里读改状态，不等 WinRT 的异步操作。rid 用共享单元
/// 而不是创建时快照——会话复用后同一批回调要服务多个 reqId。
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
    let rec_h = recognizer.clone();
    session
        .Completed(&TypedEventHandler::<
            windows::Media::SpeechRecognition::SpeechContinuousRecognitionSession,
            SpeechContinuousRecognitionCompletedEventArgs,
        >::new(move |_, e| {
            let code = e.ok().and_then(|c| c.Status()).map(|s| s.0).unwrap_or(-1);
            // 引擎此刻还在不在收声（State 是只读属性，先问再拿锁，不把 WinRT 调用带进锁里）
            let busy = rec_h.State().map(|s| engine_is_busy(s.0)).unwrap_or(true);
            // 槽位还在且标记 running、且这条 Completed 不是上一场迟到的尾巴：才算引擎自终。
            // （用户点停的收尾走 stop 路径，那边已先把 running 置假）
            let mut done = None;
            // 作废的引擎先取出来，锁放掉之后再 Close（WinRT 调用不进状态锁）
            let mut stale = None;
            if let Ok(mut slot) = dict_slot().lock() {
                if let Some(d) = slot.as_mut() {
                    let fresh = d
                        .started_at
                        .map(|t| t.elapsed() < std::time::Duration::from_secs(DICT_START_GRACE_SECS))
                        .unwrap_or(false);
                    if d.running && completed_counts(code, fresh, busy) {
                        d.running = false;
                        d.started_at = None;
                        let sig = dictation_done_signal(code);
                        let rid = d.rid.lock().map(|s| s.clone()).unwrap_or_default();
                        if !dictation_keeps_engine(&sig.1) {
                            stale = slot.take(); // 麦克风 / 网络 / 引擎异常：整个作废重建
                        }
                        done = Some((rid, sig));
                    }
                }
            }
            if let Some(d) = stale {
                let _ = d.recognizer.Close();
            }
            match done {
                Some((rid, (kind, text))) => {
                    eprintln!("[voice] session self-terminated, status = {code} -> {kind}/{text}");
                    emit_dictation(&app_h, &rid, kind, &text);
                }
                None => eprintln!("[voice] completed status = {code} 忽略（已停 / 上一场的尾巴）"),
            }
            Ok(())
        }))
        .map_err(|e| format!("听写事件挂载失败: {e}"))?;
    Ok(())
}

/// 诊断日志挂载：状态变化看出「识别器到底在不在收声」，音频问题事件则把引擎看到的
/// 音频状态直接吐出来（NoSignal / TooQuiet 这类）——没这两条时，「引擎自终」只能归给
/// 麦克风，而 2026-11-06 那次误判就是把静默超时当成了麦克风被拒。
///
/// TooQuiet / NoSignal 不只记日志：它们会转成 `audio` 事件上屏（同一个值只发一次）。
/// 本机实测麦克风录进来的峰值只到满量程的 3.7%（约 -40 dBFS），引擎就是靠这两个事件
/// 说「声音太轻」的——不接的话，用户看到的就是「说了话、一个字不出、也没任何提示」。
#[cfg(windows)]
fn dictation_register_diag(
    app: &AppHandle,
    recognizer: &windows::Media::SpeechRecognition::SpeechRecognizer,
    rid: &Arc<Mutex<String>>,
) {
    use windows::Foundation::TypedEventHandler;
    use windows::Media::SpeechRecognition::{
        SpeechRecognitionQualityDegradingEventArgs, SpeechRecognizer, SpeechRecognizerStateChangedEventArgs,
    };
    let _ = recognizer.StateChanged(&TypedEventHandler::<
        SpeechRecognizer,
        SpeechRecognizerStateChangedEventArgs,
    >::new(|_, e| {
        if let Ok(s) = e.ok().and_then(|x| x.State()) {
            eprintln!("[voice] recognizer state -> {s:?}");
        }
        Ok(())
    }));
    let app_h = app.clone();
    let rid_h = rid.clone();
    let last = Arc::new(std::sync::atomic::AtomicI32::new(i32::MIN));
    let _ = recognizer.RecognitionQualityDegrading(&TypedEventHandler::<
        SpeechRecognizer,
        SpeechRecognitionQualityDegradingEventArgs,
    >::new(move |_, e| {
        let Ok(p) = e.ok().and_then(|x| x.Problem()) else { return Ok(()) };
        eprintln!("[voice] audio problem -> {p:?} ({})", p.0);
        // None(0) 不告知；同一个问题也只告知一次，不然会反复弹
        let sig = audio_problem_signal(p.0);
        if sig.is_empty() || last.swap(p.0, Ordering::Relaxed) == p.0 {
            return Ok(());
        }
        // reqId 用共享单元：前端按它过滤，给空串会被当成无关事件丢调
        let rid = rid_h.lock().map(|s| s.clone()).unwrap_or_default();
        emit_dictation(&app_h, &rid, "audio", sig);
        Ok(())
    }));
}

#[cfg(windows)]
fn dictation_stop_sync(app: AppHandle) -> Result<(), String> {
    let _ops = dict_ops().lock().map_err(|_| "听写状态损坏")?;
    let (rid, pair) = {
        let mut slot = dict_slot().lock().map_err(|_| "听写状态损坏")?;
        match slot.as_mut() {
            Some(d) if d.running => {
                d.running = false; // 先置位：Completed 回调看到非 running 就不按自终处理
                d.started_at = None;
                (
                    d.rid.lock().map(|s| s.clone()).unwrap_or_default(),
                    Some((d.session.clone(), d.recognizer.clone())),
                )
            }
            _ => (String::new(), None),
        }
    };
    // StopAsync / join 都放在状态锁外：锁里只留几行字段读写
    let mut stop_err = None;
    if let Some((s, r)) = pair {
        if let Err(e) = session_stop(&s, &r) {
            eprintln!("[voice] stop error: {e}");
            stop_err = Some(e);
        }
    }
    if !rid.is_empty() {
        emit_dictation(&app, &rid, "end", "");
    }
    // 引擎与 session 留在槽位里供下次 start 复用；StartAsync 失败或引擎自终才整个作废重建
    //
    // 等不到停止也要把 end 发出去（上面那一行），让界面先回空闲；但错误得回给调用方——
    // 引擎到底有没有停下来没人知道，前端据此说一句「没响应」比默不作声好。同时把引擎
    // 拆掉：下一场从头建，不要在一个疑似卡死的 session 上再试一次 StartAsync（那会
    // 把启动也等到超时）。
    match stop_err {
        Some(e) => {
            discard_engine();
            Err(e)
        }
        None => Ok(()),
    }
}

#[tauri::command]
pub async fn ai_dictation_start(app: AppHandle, req_id: String, lang: String) -> Result<(), String> {
    #[cfg(windows)]
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
    fn dictation_done_signal_按枚举常量不按直觉序() {
        // windows 0.62: Success 0 / AudioQualityFailure 4 / UserCanceled 5 / TimeoutExceeded 7 /
        // PauseLimitExceeded 8 / NetworkFailure 9 / MicrophoneUnavailable 10。旧代码把 7 当成
        // 麦克风被拒，于是「没听到语音的自终」在界面上变成「拿不到麦克风，改用服务商 ASR」。
        // 真机实测：静默自终回 7，听到一段又没下文回 5，两者归同一档 auto-ended 交给前端续场。
        for code in [0, 4, 5, 7, 8] {
            assert_eq!(dictation_done_signal(code), ("end", "auto-ended".into()), "状态 {code}");
            assert!(is_auto_end(code), "状态 {code} 该算自终");
        }
        assert!(!is_auto_end(10));
        assert!(!is_auto_end(9));
        assert_eq!(dictation_done_signal(9), ("error", "network-unavailable".into()));
        // 真·麦克风被拒走专项指引（前端认这个哨兵）
        assert_eq!(dictation_done_signal(10), ("error", "mic-unavailable".into()));
        // 其余带上状态码，界面上至少能说出是哪个错
        assert_eq!(dictation_done_signal(3), ("error", "engine-error:3".into()));
        assert_eq!(dictation_done_signal(-1), ("error", "engine-error:-1".into()));
    }

    #[test]
    fn completed_迟到的尾巴不算到新会话头上() {
        // 不在启动窗口里：什么状态都算数
        assert!(completed_counts(7, false, true));
        assert!(completed_counts(7, false, false));
        assert!(completed_counts(10, false, true));
        // 窗口内且引擎还在收声：只能是上一场的尾巴
        for code in [0, 4, 5, 7, 8] {
            assert!(!completed_counts(code, true, true), "状态 {code} 在窗口内且还在收声，不该算");
        }
        // 窗口内但引擎已经不收了：这一场真的秒自终，必须算数——装机版实测就是因为
        // 只按时间判，把这一拍当成尾巴挡掉，留下「蓝着不出字」的会话
        for code in [0, 4, 5, 7, 8] {
            assert!(completed_counts(code, true, false), "状态 {code} 引擎已停，该算");
        }
        // 故障类不受窗口与状态限制：当场就要报
        assert!(completed_counts(10, true, true));
        assert!(completed_counts(9, true, false));
        assert!(completed_counts(3, true, true));
    }

    #[test]
    fn 静默超时留着引擎其余自终作废() {
        // 前端靠 end/auto-ended 原地续场，复用路径比重建快一个量级
        assert!(dictation_keeps_engine("auto-ended"));
        assert!(!dictation_keeps_engine(""));
        assert!(!dictation_keeps_engine("mic-unavailable"));
        assert!(!dictation_keeps_engine("network-unavailable"));
        assert!(!dictation_keeps_engine("engine-error:3"));
        // 表与信号函数对得上：只有自终那几档留着引擎
        for code in [1, 3, 6, 9, 10] {
            assert!(!dictation_keeps_engine(&dictation_done_signal(code).1), "状态 {code} 不该留");
        }
        for code in [0, 4, 5, 7, 8] {
            assert!(dictation_keeps_engine(&dictation_done_signal(code).1), "状态 {code} 该留");
        }
    }

    #[test]
    fn 静默上限与录音上限同源且换算成_time_span_步长() {
        // TimeSpan.Duration 以 100 纳秒为一格
        assert_eq!(DICT_SILENCE_LIMIT_SECS, REC_MAX_SECS as i64);
        assert_eq!(timespan_ticks(1), 10_000_000);
        assert_eq!(timespan_ticks(DICT_SILENCE_LIMIT_SECS), 1_200_000_000);
        // 比微软文档里的默认值 5 秒长：用户想一句措辞就不该被当成「说完了」
        assert!(DICT_SILENCE_LIMIT_SECS > 5);
    }

    #[test]
    #[cfg(windows)]
    fn winrt_block_到点就报错而不是把调用方卡死() {
        // 正常那条：回值原样拿到
        assert_eq!(winrt_block("快", 2, || 7u8).unwrap(), 7);
        // 卡住那条：到上限就当场报错——拿锁的线程必须能回来，否则之后每次点麦克风
        // 都排在这条锁后面（真机见过一次这种卡死，日志里从此没有会话建立）
        let t = std::time::Instant::now();
        let e = winrt_block("卡住", 1, || std::thread::sleep(std::time::Duration::from_secs(30))).unwrap_err();
        assert!(e.contains("超时"), "实际：{e}");
        assert!(t.elapsed() < std::time::Duration::from_secs(5), "没在超时点回来");
    }

    #[test]
    fn 会话等待上限比用户耐心短() {
        // 启动带了引擎初始化，上限可以宽松；停止要点完就给反馈，上限必须短
        assert_eq!(DICT_STOP_WAIT_SECS, 6);
        assert!(DICT_STOP_WAIT_SECS < DICT_START_WAIT_SECS);
        // 上限也不能太短：正常一场启动只要 0.1-0.6 秒，但引擎初始化慢时能到秒级
        assert!(DICT_START_WAIT_SECS >= 8);
    }

    #[test]
    fn 引擎状态idle才算空闲() {
        // SpeechRecognizerState: Idle 0 / Capturing 1 / Processing 2 / SoundStarted 3 /
        // SoundEnded 4 / SpeechDetected 5 / Paused 6
        assert!(!engine_is_busy(0));
        for s in [1, 2, 3, 4, 5, 6] {
            assert!(engine_is_busy(s), "状态 {s} 该算在收声");
        }
        // 读不到状态时按「在收声」处理：宁可照旧等 StopAsync，不要直接当已停
        assert!(engine_is_busy(-1));
    }

    #[test]
    fn 音频问题码分档只认表里的值() {
        // SpeechRecognitionAudioProblem: None 0 / TooNoisy 1 / NoSignal 2 / TooLoud 3 /
        // TooQuiet 4 / TooFast 5 / TooSlow 6
        assert_eq!(audio_problem_signal(0), "");
        assert_eq!(audio_problem_signal(1), "too-noisy");
        assert_eq!(audio_problem_signal(2), "no-signal");
        assert_eq!(audio_problem_signal(3), "too-loud");
        // 本机实测最常出的就是这一档
        assert_eq!(audio_problem_signal(4), "too-quiet");
        assert_eq!(audio_problem_signal(5), "bad-input-speed");
        assert_eq!(audio_problem_signal(6), "bad-input-speed");
        assert_eq!(audio_problem_signal(-1), "");
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

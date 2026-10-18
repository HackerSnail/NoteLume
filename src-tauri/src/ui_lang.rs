// ui_lang.rs —— 后端用户可见文案的多语言表。
//
// 与前端 src/locales/ 的五种语言对齐（id 与 LOCALES 一致）：界面文案曾经全部硬编码中文，
// 命令错误弹窗、docx 导入警告、git 远程结果文本、mac 托盘菜单在非中文界面下也显示中文。
// 这里收一张词表：Rust 各处按 key 取当前界面语言的模板，`{name}` 占位符由调用方填入。
//
// 语言来源：前端启动与切换语言时调 `set_ui_lang` 命令上报（main.js boot/switchLocale）。
// 未设置（Node 单测 / 前端还没起来）时默认 zh-CN；未知 id 一律回退 zh-CN。
// 缺词条时返回 key 本身，行为与前端 t() 的「再缺回退键名」一致。

use std::sync::Mutex;

/// 当前界面语言。空串 = 未设置，取值时按 zh-CN。
static UI_LANG: Mutex<String> = Mutex::new(String::new());

/// 五语言固定列序：zh-CN / zh-Hant / en-US / fr-FR / de-DE
const LANGS: [&str; 5] = ["zh-CN", "zh-Hant", "en-US", "fr-FR", "de-DE"];

fn column_of(lang: &str) -> usize {
    match LANGS.iter().position(|l| *l == lang) {
        Some(i) => i,
        None => 0, // 未知语言回退简体中文
    }
}

/// 上报界面语言。返回是否被接受（与 LOCALES 对齐的 id 才落）。
pub fn set_lang(lang: &str) -> bool {
    if !LANGS.contains(&lang) {
        return false;
    }
    match UI_LANG.lock() {
        Ok(mut g) => *g = lang.to_string(),
        Err(_) => return false,
    }
    true
}

/// 当前界面语言（未设置 → zh-CN）。
pub fn current_lang() -> String {
    match UI_LANG.lock() {
        Ok(g) => {
            if g.is_empty() {
                "zh-CN".to_string()
            } else {
                g.clone()
            }
        }
        Err(_) => "zh-CN".to_string(),
    }
}

struct Entry {
    key: &'static str,
    /// 五语言模板，列序同 LANGS
    texts: [&'static str; 5],
}

/// 占位符替换：`{name}` → vars 里同名变量的值。
fn interpolate(template: &str, vars: &[(&str, String)]) -> String {
    if vars.is_empty() {
        return template.to_string();
    }
    let mut out = template.to_string();
    for (name, value) in vars {
        out = out.replace(&format!("{{{}}}", name), value);
    }
    out
}

/// 取当前语言的一条文案。缺词条 → 返回 key 本身。
pub fn msg(key: &str, vars: &[(&str, String)]) -> String {
    let lang = current_lang();
    let col = column_of(&lang);
    let hit = TABLE.iter().find(|e| e.key == key);
    match hit {
        Some(e) => interpolate(e.texts[col], vars),
        None => key.to_string(),
    }
}

/// 快速构造：`ui_msg!("readFailed", "err" => e)`（变量值经 Display 转 String）
#[macro_export]
macro_rules! ui_msg {
    ($key:expr $(,)?) => {
        $crate::ui_lang::msg($key, &[])
    };
    ($key:expr, $($name:literal => $val:expr),+ $(,)?) => {
        $crate::ui_lang::msg($key, &[$( ($name, $val.to_string()) ),+])
    };
}

/// Result 错误用的快捷别名（语义上就是取一条文案）。
#[macro_export]
macro_rules! ui_err {
    ($($arg:tt)*) => {
        $crate::ui_msg!($($arg)*)
    };
}

// ==================== 词表 ====================
// key 走 camelCase；分段注释仅给人看。占位符名与调用点一一对应。

const TABLE: &[Entry] = &[
    // ---------- 路径与库根校验 ----------
    Entry { key: "pathResolveFailed", texts: [
        "路径解析失败 {path}：{err}",
        "路徑解析失敗 {path}：{err}",
        "Failed to resolve path {path}: {err}",
        "Échec de résolution du chemin {path} : {err}",
        "Pfad {path} konnte nicht aufgelöst werden: {err}",
    ]},
    Entry { key: "pathOutsideVault", texts: [
        "非法路径：目标不在知识库根目录内",
        "非法路徑：目標不在知識庫根目錄內",
        "Invalid path: the target is outside the vault root",
        "Chemin invalide : la cible se trouve hors du coffre",
        "Ungültiger Pfad: Das Ziel liegt außerhalb des Vault",
    ]},
    Entry { key: "pathEscapeVault", texts: [
        "非法路径：不允许跳出知识库根目录",
        "非法路徑：不允許跳出知識庫根目錄",
        "Invalid path: escaping the vault root is not allowed",
        "Chemin invalide : sortir du coffre est interdit",
        "Ungültiger Pfad: Verlassen des Vault ist nicht erlaubt",
    ]},
    Entry { key: "badFilePath", texts: [
        "非法文件路径",
        "非法文件路徑",
        "Invalid file path",
        "Chemin de fichier invalide",
        "Ungültiger Dateipfad",
    ]},
    Entry { key: "badPath", texts: [
        "非法路径",
        "非法路徑",
        "Invalid path",
        "Chemin invalide",
        "Ungültiger Pfad",
    ]},
    Entry { key: "badImportFileName", texts: [
        "非法文件名",
        "非法文件名",
        "Invalid file name",
        "Nom de fichier invalide",
        "Ungültiger Dateiname",
    ]},
    Entry { key: "badBase64", texts: [
        "非法 base64 字符",
        "非法 base64 字符",
        "Invalid base64 character",
        "Caractère base64 invalide",
        "Ungültiges Base64-Zeichen",
    ]},
    Entry { key: "vaultPathInvalid", texts: [
        "知识库路径无效：{err}",
        "知識庫路徑無效：{err}",
        "Invalid vault path: {err}",
        "Chemin de coffre invalide : {err}",
        "Ungültiger Vault-Pfad: {err}",
    ]},
    Entry { key: "vaultNotDir", texts: [
        "知识库路径不是目录",
        "知識庫路徑不是目錄",
        "The vault path is not a directory",
        "Le chemin du coffre n’est pas un dossier",
        "Der Vault-Pfad ist kein Verzeichnis",
    ]},

    // ---------- 文件读写（库内） ----------
    Entry { key: "readFailed", texts: [
        "读取失败：{err}",
        "讀取失敗：{err}",
        "Read failed: {err}",
        "Échec de lecture : {err}",
        "Lesen fehlgeschlagen: {err}",
    ]},
    Entry { key: "readFileFailed", texts: [
        "读取文件失败 {path}：{err}",
        "讀取文件失敗 {path}：{err}",
        "Failed to read file {path}: {err}",
        "Échec de lecture du fichier {path} : {err}",
        "Datei {path} konnte nicht gelesen werden: {err}",
    ]},
    Entry { key: "readDirFailed", texts: [
        "读取目录失败 {path}：{err}",
        "讀取目錄失敗 {path}：{err}",
        "Failed to read directory {path}: {err}",
        "Échec de lecture du dossier {path} : {err}",
        "Verzeichnis {path} konnte nicht gelesen werden: {err}",
    ]},
    Entry { key: "saveFailed", texts: [
        "保存失败：{err}",
        "儲存失敗：{err}",
        "Save failed: {err}",
        "Échec d’enregistrement : {err}",
        "Speichern fehlgeschlagen: {err}",
    ]},
    Entry { key: "writeFailed", texts: [
        "写入失败 {path}：{err}",
        "寫入失敗 {path}：{err}",
        "Failed to write {path}: {err}",
        "Échec d’écriture de {path} : {err}",
        "Schreiben von {path} fehlgeschlagen: {err}",
    ]},
    Entry { key: "createDirFailed", texts: [
        "创建目录失败：{err}",
        "創建目錄失敗：{err}",
        "Failed to create directory: {err}",
        "Échec de création du dossier : {err}",
        "Verzeichnis konnte nicht erstellt werden: {err}",
    ]},
    Entry { key: "copyFailed", texts: [
        "复制失败 {src}→{dst}：{err}",
        "複製失敗 {src}→{dst}：{err}",
        "Copy failed {src}→{dst}: {err}",
        "Échec de copie {src}→{dst} : {err}",
        "Kopieren fehlgeschlagen {src}→{dst}: {err}",
    ]},
    Entry { key: "copyFailedRel", texts: [
        "复制失败 {rel}：{err}",
        "複製失敗 {rel}：{err}",
        "Copy failed {rel}: {err}",
        "Échec de copie {rel} : {err}",
        "Kopieren fehlgeschlagen {rel}: {err}",
    ]},
    Entry { key: "exportFailed", texts: [
        "导出失败：{err}",
        "導出失敗：{err}",
        "Export failed: {err}",
        "Échec de l’export : {err}",
        "Export fehlgeschlagen: {err}",
    ]},
    Entry { key: "createOutDirFailed", texts: [
        "创建输出目录失败：{err}",
        "創建輸出目錄失敗：{err}",
        "Failed to create the output directory: {err}",
        "Échec de création du dossier de sortie : {err}",
        "Ausgabeverzeichnis konnte nicht erstellt werden: {err}",
    ]},

    // ---------- 库内条目操作 ----------
    Entry { key: "emptyFileName", texts: [
        "文件名不能为空",
        "文件名不能為空",
        "The file name cannot be empty",
        "Le nom de fichier ne peut pas être vide",
        "Der Dateiname darf nicht leer sein",
    ]},
    Entry { key: "emptyFolderName", texts: [
        "文件夹名不能为空",
        "文件夹名不能為空",
        "The folder name cannot be empty",
        "Le nom de dossier ne peut pas être vide",
        "Der Ordnername darf nicht leer sein",
    ]},
    Entry { key: "newNameEmpty", texts: [
        "新名称不能为空",
        "新名稱不能為空",
        "The new name cannot be empty",
        "Le nouveau nom ne peut pas être vide",
        "Der neue Name darf nicht leer sein",
    ]},
    Entry { key: "targetExists", texts: [
        "目标已存在",
        "目標已存在",
        "The target already exists",
        "La cible existe déjà",
        "Das Ziel existiert bereits",
    ]},
    Entry { key: "renameExists", texts: [
        "目标已存在，无法重命名 / 移动",
        "目標已存在，無法重新命名 / 移動",
        "The target already exists; rename / move rejected",
        "La cible existe déjà ; renommage / déplacement refusé",
        "Das Ziel existiert; Umbenennen / Verschieben abgelehnt",
    ]},
    Entry { key: "targetDirMissing", texts: [
        "目标目录不存在：{err}",
        "目標目錄不存在：{err}",
        "The target directory does not exist: {err}",
        "Le dossier cible n’existe pas : {err}",
        "Das Zielverzeichnis existiert nicht: {err}",
    ]},
    Entry { key: "moveIntoSelf", texts: [
        "不能把文件夹移动到自身内部",
        "不能把文件夾移動到自身內部",
        "A folder cannot be moved into itself",
        "Un dossier ne peut pas être déplacé dans lui-même",
        "Ein Ordner kann nicht in sich selbst verschoben werden",
    ]},
    Entry { key: "renameFailed", texts: [
        "重命名失败：{err}",
        "重新命名失敗：{err}",
        "Rename failed: {err}",
        "Échec du renommage : {err}",
        "Umbenennen fehlgeschlagen: {err}",
    ]},
    Entry { key: "noFolderDelete", texts: [
        "不支持删除文件夹",
        "不支援刪除文件夾",
        "Deleting folders is not supported",
        "La suppression de dossiers n’est pas prise en charge",
        "Löschen von Ordnern wird nicht unterstützt",
    ]},
    Entry { key: "trashFailed", texts: [
        "移入回收站失败：{err}",
        "移入回收站失敗：{err}",
        "Failed to move to the recycle bin: {err}",
        "Échec du déplacement vers la corbeille : {err}",
        "Verschieben in den Papierkorb fehlgeschlagen: {err}",
    ]},
    Entry { key: "importFailed", texts: [
        "导入失败：{err}",
        "導入失敗：{err}",
        "Import failed: {err}",
        "Échec de l’import : {err}",
        "Import fehlgeschlagen: {err}",
    ]},
    Entry { key: "srcNotExists", texts: [
        "源文件不存在：{path}",
        "來源文件不存在：{path}",
        "Source file does not exist: {path}",
        "Le fichier source n’existe pas : {path}",
        "Quelldatei existiert nicht: {path}",
    ]},
    Entry { key: "unsupportedImgType", texts: [
        "不支持的图片类型：{ext}",
        "不支援的圖片類型：{ext}",
        "Unsupported image type: {ext}",
        "Type d’image non pris en charge : {ext}",
        "Nicht unterstützter Bildtyp: {ext}",
    ]},
    Entry { key: "readImgFailed", texts: [
        "读取图片失败：{err}",
        "讀取圖片失敗：{err}",
        "Failed to read the image: {err}",
        "Échec de lecture de l’image : {err}",
        "Bild konnte nicht gelesen werden: {err}",
    ]},
    Entry { key: "copyImgFailed", texts: [
        "复制图片失败：{err}",
        "複製圖片失敗：{err}",
        "Failed to copy the image: {err}",
        "Échec de copie de l’image : {err}",
        "Bild konnte nicht kopiert werden: {err}",
    ]},
    Entry { key: "writeImgFailed", texts: [
        "写入图片失败：{err}",
        "寫入圖片失敗：{err}",
        "Failed to write the image: {err}",
        "Échec d’écriture de l’image : {err}",
        "Bild konnte nicht geschrieben werden: {err}",
    ]},
    Entry { key: "imgNotFound", texts: [
        "找不到图片：{src}",
        "找不到圖片：{src}",
        "Image not found: {src}",
        "Image introuvable : {src}",
        "Bild nicht gefunden: {src}",
    ]},

    // ---------- 索引 / 备份 / 插件 ----------
    Entry { key: "writeBackupFailed", texts: [
        "写入备份失败：{err}",
        "寫入備份失敗：{err}",
        "Failed to write the backup: {err}",
        "Échec d’écriture de la sauvegarde : {err}",
        "Sicherung konnte nicht geschrieben werden: {err}",
    ]},
    Entry { key: "backupOnly", texts: [
        "非法路径：只能读取备份目录内的快照",
        "非法路徑：只能讀取備份目錄內的快照",
        "Invalid path: only snapshots inside the backup directory can be read",
        "Chemin invalide : seuls les instantanés du dossier de sauvegarde peuvent être lus",
        "Ungültiger Pfad: Nur Snapshots im Sicherungsverzeichnis können gelesen werden",
    ]},
    Entry { key: "readBackupFailed", texts: [
        "读取备份失败：{err}",
        "讀取備份失敗：{err}",
        "Failed to read the backup: {err}",
        "Échec de lecture de la sauvegarde : {err}",
        "Sicherung konnte nicht gelesen werden: {err}",
    ]},
    Entry { key: "pluginOnly", texts: [
        "非法路径：只能读取插件目录内的文件",
        "非法路徑：只能讀取插件目錄內的文件",
        "Invalid path: only files inside the plugin directory can be read",
        "Chemin invalide : seuls les fichiers du dossier de plugins peuvent être lus",
        "Ungültiger Pfad: Nur Dateien im Plugin-Verzeichnis können gelesen werden",
    ]},
    Entry { key: "readPluginFailed", texts: [
        "读取插件失败：{err}",
        "讀取插件失敗：{err}",
        "Failed to read the plugin: {err}",
        "Échec de lecture du plugin : {err}",
        "Plugin konnte nicht gelesen werden: {err}",
    ]},
    Entry { key: "indexLockPoisoned", texts: [
        "索引状态锁 poisoned",
        "索引狀態鎖 poisoned",
        "Index state lock poisoned",
        "Verrou d’état de l’index empoisonné",
        "Sperre des Index-Status vergiftet",
    ]},

    // ---------- 本地 Git（git2 只读 + 提交） ----------
    Entry { key: "gitOpenRepoFailed", texts: [
        "打开仓库失败：{err}",
        "打開倉庫失敗：{err}",
        "Failed to open the repository: {err}",
        "Échec de l’ouverture du dépôt : {err}",
        "Repository konnte nicht geöffnet werden: {err}",
    ]},
    Entry { key: "gitNoWorkdir", texts: [
        "仓库无工作目录",
        "倉庫無工作目錄",
        "The repository has no working directory",
        "Le dépôt n’a pas de répertoire de travail",
        "Das Repository hat kein Arbeitsverzeichnis",
    ]},
    Entry { key: "gitInitFailed", texts: [
        "初始化仓库失败：{err}",
        "初始化倉庫失敗：{err}",
        "Failed to initialize the repository: {err}",
        "Échec de l’initialisation du dépôt : {err}",
        "Repository konnte nicht initialisiert werden: {err}",
    ]},
    Entry { key: "gitignoreWriteFailed", texts: [
        "写 .gitignore 失败：{err}",
        "寫 .gitignore 失敗：{err}",
        "Failed to write .gitignore: {err}",
        "Échec d’écriture de .gitignore : {err}",
        "Schreiben von .gitignore fehlgeschlagen: {err}",
    ]},
    Entry { key: "gitIdentityMissing", texts: [
        "缺少提交身份：请配置 git user.name / user.email",
        "缺少提交身份：請配置 git user.name / user.email",
        "No commit identity: set git user.name / user.email first",
        "Identité de commit manquante : configurez git user.name / user.email",
        "Keine Commit-Identität: konfigurieren Sie git user.name / user.email",
    ]},
    Entry { key: "gitCommitMsgEmpty", texts: [
        "提交信息不能为空",
        "提交信息不能為空",
        "The commit message cannot be empty",
        "Le message de commit ne peut pas être vide",
        "Die Commit-Nachricht darf nicht leer sein",
    ]},
    Entry { key: "gitNothingToCommit", texts: [
        "没有需要提交的改动",
        "沒有需要提交的改動",
        "No changes to commit",
        "Aucune modification à valider",
        "Keine Änderungen zum Committen",
    ]},

    // ---------- Git 远程：System 后端（shell-out 系统 git） ----------
    Entry { key: "gitExitCode", texts: [
        "git 退出码 {code}",
        "git 退出碼 {code}",
        "git exited with code {code}",
        "git s’est terminé avec le code {code}",
        "git wurde mit Code {code} beendet",
    ]},
    Entry { key: "gitSpawnFailed", texts: [
        "调用系统 git 失败：{err}（请确认已安装并在 PATH 中）",
        "調用系統 git 失敗：{err}（請確認已安裝並在 PATH 中）",
        "Failed to launch system git: {err} (make sure it is installed and on PATH)",
        "Échec du lancement de git système : {err} (vérifiez qu’il est installé et dans le PATH)",
        "System-git konnte nicht gestartet werden: {err} (ist es installiert und im PATH?)",
    ]},
    Entry { key: "gitTaskFailed", texts: [
        "git 任务调度失败：{err}",
        "git 任務排程失敗：{err}",
        "Failed to schedule the git task: {err}",
        "Échec de planification de la tâche git : {err}",
        "git-Aufgabe konnte nicht eingeplant werden: {err}",
    ]},

    // ---------- Git 远程：Builtin 后端（内置 git2） ----------
    // 带 [code] 前串的错误：code 由后端分类写死，前端 handleRemoteErr 按前串分派，
    // 因此前串原文保留，只把后面的说明文字本地化。
    Entry { key: "gitNoHead", texts: [
        "无 HEAD（仓库可能为空）",
        "無 HEAD（倉庫可能為空）",
        "no HEAD (the repository may be empty)",
        "pas de HEAD (le dépôt est peut-être vide)",
        "kein HEAD (das Repository ist möglicherweise leer)",
    ]},
    Entry { key: "gitDetachedPull", texts: [
        "内置 pull 需要 HEAD 在分支上（当前 detached）",
        "內建 pull 需要 HEAD 在分支上（當前 detached）",
        "the builtin pull needs HEAD on a branch (currently detached)",
        "le pull intégré nécessite HEAD sur une branche (actuellement détachée)",
        "der integrierte Pull benötigt HEAD auf einem Branch (derzeit detached)",
    ]},
    Entry { key: "gitDetachedPush", texts: [
        "内置 push 需要 HEAD 在分支上（当前 detached）",
        "內建 push 需要 HEAD 在分支上（當前 detached）",
        "the builtin push needs HEAD on a branch (currently detached)",
        "le push intégré nécessite HEAD sur une branche (actuellement détachée)",
        "der integrierte Push benötigt HEAD auf einem Branch (derzeit detached)",
    ]},
    Entry { key: "gitNoBranchName", texts: [
        "无分支名",
        "無分支名",
        "no branch name",
        "aucun nom de branche",
        "kein Branch-Name",
    ]},
    Entry { key: "gitNoUpstreamBuiltin", texts: [
        "当前分支无上游；先安装系统 git 运行 `git branch --set-upstream-to=origin/<br>`、或在面板里配置",
        "當前分支無上游；先安裝系統 git 執行 `git branch --set-upstream-to=origin/<br>`、或在面板裡配置",
        "the current branch has no upstream; install system git and run `git branch --set-upstream-to=origin/<branch>` or configure it in the panel",
        "la branche actuelle n’a pas d’amont ; installez git système et lancez `git branch --set-upstream-to=origin/<branch>`, ou configurez-le dans le panneau",
        "der aktuelle Branch hat keinen Upstream; installieren Sie System-git und führen `git branch --set-upstream-to=origin/<branch>` aus oder konfigurieren Sie ihn im Panel",
    ]},
    Entry { key: "gitUpstreamNotUtf8", texts: [
        "上游 refname 非 UTF8",
        "上游 refname 非 UTF8",
        "the upstream refname is not UTF-8",
        "le nom de réf de l’amont n’est pas en UTF-8",
        "der Upstream-Refname ist nicht UTF-8",
    ]},
    Entry { key: "gitRemoteNameUnresolved", texts: [
        "无法解析 remote 名",
        "無法解析 remote 名",
        "unable to resolve the remote name",
        "impossible de résoudre le nom du remote",
        "Remote-Name konnte nicht aufgelöst werden",
    ]},
    Entry { key: "gitNoUpstreamPush", texts: [
        "当前分支无上游，无法推——先安装系统 git 跑一次 `git push -u origin <branch>`、或在面板里配置",
        "當前分支無上游，無法推——先安裝系統 git 跑一次 `git push -u origin <branch>`、或在面板裡配置",
        "the current branch has no upstream, cannot push; run `git push -u origin <branch>` once with system git, or configure it in the panel",
        "la branche actuelle n’a pas d’amont, push impossible ; lancez `git push -u origin <branch>` une fois avec git système, ou configurez-le dans le panneau",
        "der aktuelle Branch hat keinen Upstream, Push nicht möglich; führen Sie einmal `git push -u origin <branch>` mit System-git aus oder konfigurieren Sie ihn im Panel",
    ]},
    Entry { key: "gitUpstreamUnresolved", texts: [
        "无法解析 upstream：{up}",
        "無法解析 upstream：{up}",
        "unable to resolve upstream: {up}",
        "impossible de résoudre l’amont : {up}",
        "Upstream konnte nicht aufgelöst werden: {up}",
    ]},
    // 证书回调里的分类标记（from_str 的英文 token）：map_err 按 map_err_text 分类后，
    // 正文替换成本地化文案，token 本身不显示给用户。
    Entry { key: "gitHostkeyMismatch", texts: [
        "主机密钥与记录不一致（known_hosts 里已是另一个 key），连接已中止。若确认是服务器换了密钥，更新 ~/.ssh/known_hosts 后重试",
        "主機金鑰與記錄不一致（known_hosts 裡已是另一個 key），連線已中止。若確認是伺服器換了金鑰，更新 ~/.ssh/known_hosts 後重試",
        "the host key does not match the one recorded in known_hosts; the connection was aborted. If the server key really changed, update ~/.ssh/known_hosts and retry",
        "la clé d’hôte ne correspond pas à celle enregistrée dans known_hosts ; la connexion a été interrompue. Si la clé du serveur a vraiment changé, mettez à jour ~/.ssh/known_hosts et réessayez",
        "der Host-Schlüssel passt nicht zum Eintrag in known_hosts; die Verbindung wurde abgebrochen. Wenn sich der Serverschlüssel wirklich geändert hat, aktualisieren Sie ~/.ssh/known_hosts und versuchen Sie es erneut",
    ]},
    Entry { key: "gitHostNotTrusted", texts: [
        "主机密钥未被信任",
        "主機金鑰未被信任",
        "the host key is not trusted",
        "la clé d’hôte n’est pas approuvée",
        "der Host-Schlüssel ist nicht vertrauenswürdig",
    ]},
    Entry { key: "gitPushRejectedToken", texts: [
        "push 被远端拒绝（未给出原因）",
        "push 被遠端拒絕（未給出原因）",
        "push rejected by the remote (no reason given)",
        "push refusé par le distant (aucune raison indiquée)",
        "Push vom Remote abgelehnt (kein Grund angegeben)",
    ]},
    Entry { key: "gitNonFfDivergent", texts: [
        "分叉：ahead={ahead} behind={behind}；本 R1-B 不自动 merge/rebase，请用系统 git 工作流或批次 L 快照手动处理",
        "分叉：ahead={ahead} behind={behind}；本 R1-B 不自動 merge/rebase，請用系統 git 工作流或批次 L 快照手動處理",
        "diverged: ahead={ahead} behind={behind}; this backend does not auto merge/rebase, handle it with system git or the batch-L snapshots",
        "divergence : ahead={ahead} behind={behind} ; ce backend ne fait pas de merge/rebase automatique, à traiter avec git système ou les instantanés du lot L",
        "Divergenz: ahead={ahead} behind={behind}; dieses Backend führt kein automatisches merge/rebase durch, bitte mit System-git oder den Batch-L-Snapshots behandeln",
    ]},
    Entry { key: "gitAlreadyUp", texts: [
        "已经是最新",
        "已經是最新",
        "Already up to date",
        "Déjà à jour",
        "Bereits auf dem neuesten Stand",
    ]},
    Entry { key: "gitFastForward", texts: [
        "快进 {from} → {to}",
        "快進 {from} → {to}",
        "Fast-forward {from} → {to}",
        "Avance rapide {from} → {to}",
        "Fast-Forward {from} → {to}",
    ]},
    Entry { key: "gitPushRejected", texts: [
        "push 被远端拒绝：{reason}",
        "push 被遠端拒絕：{reason}",
        "push rejected by the remote: {reason}",
        "push refusé par le distant : {reason}",
        "Push vom Remote abgelehnt: {reason}",
    ]},
    Entry { key: "gitPushedRefs", texts: [
        "已推 refs/heads/{branch} -> {remote}/{remoteBranch}",
        "已推 refs/heads/{branch} -> {remote}/{remoteBranch}",
        "Pushed refs/heads/{branch} -> {remote}/{remoteBranch}",
        "Réfs poussées refs/heads/{branch} -> {remote}/{remoteBranch}",
        "refs/heads/{branch} -> {remote}/{remoteBranch} gepusht",
    ]},
    Entry { key: "gitMergeOk", texts: [
        "合并成功",
        "合併成功",
        "Merge succeeded",
        "Fusion réussie",
        "Merge erfolgreich",
    ]},
    Entry { key: "gitMergeConflicts", texts: [
        "合并产生了冲突，请在面板解决",
        "合併產生了衝突，請在面板解決",
        "The merge produced conflicts; resolve them in the panel",
        "La fusion a produit des conflits ; résolvez-les dans le panneau",
        "Der Merge hat Konflikte erzeugt; bitte im Panel lösen",
    ]},
    Entry { key: "gitMergeImpossible", texts: [
        "无法执行合并（非正常 merge 场景）",
        "無法執行合併（非正常 merge 場景）",
        "cannot merge (not a normal merge scenario)",
        "fusion impossible (scénario de merge anormal)",
        "Merge nicht möglich (kein normales Merge-Szenario)",
    ]},
    Entry { key: "gitSideInvalid", texts: [
        "side 必须是 ours 或 theirs",
        "side 必須是 ours 或 theirs",
        "side must be ours or theirs",
        "side doit être ours ou theirs",
        "side muss ours oder theirs sein",
    ]},
    Entry { key: "gitNoSideVersion", texts: [
        "{path} 无 {side} 版本",
        "{path} 無 {side} 版本",
        "{path} has no {side} version",
        "{path} n’a pas de version {side}",
        "{path} hat keine {side}-Version",
    ]},
    Entry { key: "gitNotConflicted", texts: [
        "{path} 不在冲突状态",
        "{path} 不在衝突狀態",
        "{path} is not in conflict",
        "{path} n’est pas en conflit",
        "{path} ist nicht im Konfliktzustand",
    ]},
    Entry { key: "gitBareNoWorkdir", texts: [
        "裸仓库无工作区",
        "裸倉庫無工作區",
        "bare repository has no working tree",
        "un dépôt nu n’a pas de copie de travail",
        "ein Bare-Repository hat keinen Arbeitsbaum",
    ]},
    Entry { key: "gitWriteWorkdirFailed", texts: [
        "写工作区失败：{err}",
        "寫工作區失敗：{err}",
        "Failed to write the working tree: {err}",
        "Échec d’écriture de la copie de travail : {err}",
        "Schreiben des Arbeitsbaums fehlgeschlagen: {err}",
    ]},
    Entry { key: "gitNoMergeHead", texts: [
        "无 MERGE_HEAD，不在合并状态",
        "無 MERGE_HEAD，不在合併狀態",
        "no MERGE_HEAD, not in a merge state",
        "pas de MERGE_HEAD, pas d’état de fusion",
        "kein MERGE_HEAD, kein Merge-Zustand",
    ]},
    Entry { key: "gitKnownHostsHome", texts: [
        "无法定位 HOME/USERPROFILE，不能写 ~/.ssh/known_hosts",
        "無法定位 HOME/USERPROFILE，不能寫 ~/.ssh/known_hosts",
        "cannot locate HOME/USERPROFILE; ~/.ssh/known_hosts cannot be written",
        "impossible de localiser HOME/USERPROFILE ; ~/.ssh/known_hosts ne peut pas être écrit",
        "HOME/USERPROFILE nicht gefunden; ~/.ssh/known_hosts kann nicht geschrieben werden",
    ]},
    Entry { key: "gitKnownHostsCreate", texts: [
        "创建 ~/.ssh 失败：{err}",
        "創建 ~/.ssh 失敗：{err}",
        "Failed to create ~/.ssh: {err}",
        "Échec de création de ~/.ssh : {err}",
        "Erstellen von ~/.ssh fehlgeschlagen: {err}",
    ]},
    Entry { key: "gitKnownHostsOpen", texts: [
        "打开 ~/.ssh/known_hosts 失败：{err}",
        "打開 ~/.ssh/known_hosts 失敗：{err}",
        "Failed to open ~/.ssh/known_hosts: {err}",
        "Échec d’ouverture de ~/.ssh/known_hosts : {err}",
        "Öffnen von ~/.ssh/known_hosts fehlgeschlagen: {err}",
    ]},
    Entry { key: "gitKnownHostsWrite", texts: [
        "写 ~/.ssh/known_hosts 失败：{err}",
        "寫 ~/.ssh/known_hosts 失敗：{err}",
        "Failed to write ~/.ssh/known_hosts: {err}",
        "Échec d’écriture de ~/.ssh/known_hosts : {err}",
        "Schreiben von ~/.ssh/known_hosts fehlgeschlagen: {err}",
    ]},
    Entry { key: "gitKnownHostsStoreHome", texts: [
        "无法定位 APPDATA/XDG_CONFIG_HOME/HOME，不能写 known_hosts 私库",
        "無法定位 APPDATA/XDG_CONFIG_HOME/HOME，不能寫 known_hosts 私庫",
        "cannot locate APPDATA/XDG_CONFIG_HOME/HOME; the known_hosts store cannot be written",
        "impossible de localiser APPDATA/XDG_CONFIG_HOME/HOME ; le magasin known_hosts ne peut pas être écrit",
        "APPDATA/XDG_CONFIG_HOME/HOME nicht gefunden; der known_hosts-Speicher kann nicht geschrieben werden",
    ]},
    Entry { key: "gitKnownHostsStoreDir", texts: [
        "创建私库目录失败：{err}",
        "創建私庫目錄失敗：{err}",
        "Failed to create the store directory: {err}",
        "Échec de création du dossier du magasin : {err}",
        "Speicherverzeichnis konnte nicht erstellt werden: {err}",
    ]},
    Entry { key: "gitKnownHostsStoreOpen", texts: [
        "打开私库失败：{err}",
        "打開私庫失敗：{err}",
        "Failed to open the store: {err}",
        "Échec d’ouverture du magasin : {err}",
        "Speicher konnte nicht geöffnet werden: {err}",
    ]},
    Entry { key: "gitKnownHostsStoreWrite", texts: [
        "写私库失败：{err}",
        "寫私庫失敗：{err}",
        "Failed to write the store: {err}",
        "Échec d’écriture du magasin : {err}",
        "Schreiben des Speichers fehlgeschlagen: {err}",
    ]},
    Entry { key: "gitSpawnBlockingFailed", texts: [
        "spawn_blocking 失败：{err}",
        "spawn_blocking 失敗：{err}",
        "spawn_blocking failed: {err}",
        "échec de spawn_blocking : {err}",
        "spawn_blocking fehlgeschlagen: {err}",
    ]},

    // ---------- mac 原生菜单 / 托盘 ----------
    Entry { key: "unknownMenuRole", texts: [
        "未知的系统菜单项：{role}",
        "未知的系統菜單項：{role}",
        "Unknown system menu item: {role}",
        "Élément de menu système inconnu : {role}",
        "Unbekannter Systemmenü-Eintrag: {role}",
    ]},
    Entry { key: "emptyMenuGroups", texts: [
        "菜单组为空",
        "菜單組為空",
        "The menu spec has no groups",
        "La spécification de menu n’a aucun groupe",
        "Die Menü-Spezifikation hat keine Gruppen",
    ]},
    Entry { key: "trayShow", texts: [
        "显示主窗口",
        "顯示主窗口",
        "Show Main Window",
        "Afficher la fenêtre principale",
        "Hauptfenster anzeigen",
    ]},
    Entry { key: "trayNewNote", texts: [
        "新建笔记",
        "新建筆記",
        "New Note",
        "Nouvelle note",
        "Neue Notiz",
    ]},
    Entry { key: "trayOpenRecent", texts: [
        "打开最近",
        "打開最近",
        "Open Recent",
        "Ouvrir récents",
        "Zuletzt geöffnet",
    ]},
    Entry { key: "trayNoRecent", texts: [
        "（暂无最近文件）",
        "（暫無最近文件）",
        "(No recent files)",
        "(Aucun fichier récent)",
        "(Keine zuletzt geöffneten Dateien)",
    ]},
    Entry { key: "trayQuit", texts: [
        "退出 NoteLume",
        "退出 NoteLume",
        "Quit NoteLume",
        "Quitter NoteLume",
        "NoteLume beenden",
    ]},

    // ---------- docx 导入（警告按 code 键取名，前端据此显示） ----------
    Entry { key: "warnTocSdt", texts: [
        "目录域已按可见文本降级（域码不执行）",
        "目錄域已按可見文字降級（域碼不執行）",
        "table of contents copied as plain text (field codes not executed)",
        "table des matières recopiée en texte brut (codes de champ non exécutés)",
        "Inhaltsverzeichnis als reiner Text übernommen (Feldcodes nicht ausgeführt)",
    ]},
    Entry { key: "warnTocFldSimple", texts: [
        "目录域已按可见文本降级",
        "目錄域已按可見文字降級",
        "table of contents copied as plain text",
        "table des matières recopiée en texte brut",
        "Inhaltsverzeichnis als reiner Text übernommen",
    ]},
    Entry { key: "warnTextbox", texts: [
        "文本框内容已按顺序段落输出（位置/浮动信息丢失）",
        "文本框內容已按順序段落輸出（位置/浮動資訊丟失）",
        "text box content written as sequential paragraphs (position/floating lost)",
        "contenu de la zone de texte écrit en paragraphes séquentiels (position/flottement perdus)",
        "Textfeld-Inhalt als fortlaufende Absätze ausgegeben (Position/Schwebend verloren)",
    ]},
    Entry { key: "warnUnknownAccent", texts: [
        "未知重音字符 {chr}，已原样前置",
        "未知重音符號 {chr}，已原樣前置",
        "unknown accent character {chr}, kept as-is",
        "caractère d’accent inconnu {chr}, conservé tel quel",
        "unbekanntes Akzentzeichen {chr}, unverändert übernommen",
    ]},
    Entry { key: "warnOmmlUnsupported", texts: [
        "OMML 构造 m:{tag} 未支持，已降级为内容拼接",
        "OMML 構造 m:{tag} 未支援，已降級為內容拼接",
        "OMML construct m:{tag} unsupported, flattened to plain content",
        "construction OMML m:{tag} non prise en charge, réduite à du contenu brut",
        "OMML-Konstrukt m:{tag} nicht unterstützt, auf reinen Inhalt reduziert",
    ]},
    Entry { key: "warnOMathPara", texts: [
        "显示公式与正文混排，已内联为 $..$",
        "顯示公式與正文混排，已內聯為 $..$",
        "display equation mixed with body text, inlined as $..$",
        "équation affichée mêlée au texte, intégrée en $..$",
        "Anzeige-Gleichung im Fließtext, eingebettet als $..$",
    ]},
    Entry { key: "warnXrefMissing", texts: [
        "交叉引用目标书签未找到，已降级为可见文本",
        "交叉引用目標書籤未找到，已降級為可見文字",
        "cross-reference target bookmark not found, kept as visible text",
        "signet cible de la référence croisée introuvable, conservé en texte visible",
        "Ziellesezeichen des Querverweises nicht gefunden, als sichtbarer Text übernommen",
    ]},
    Entry { key: "warnTrackedDel", texts: [
        "已忽略删除痕迹（tracked deletion）内的文本",
        "已忽略刪除痕跡（tracked deletion）內的文字",
        "text inside tracked deletions was dropped",
        "le texte des suppressions suivies a été ignoré",
        "Text innerhalb verfolgter Löschungen wurde verworfen",
    ]},
    Entry { key: "warnFootnoteRef", texts: [
        "脚注/尾注引用已降为 [^id] + 文末定义",
        "腳註/尾註引用已降為 [^id] + 文末定義",
        "footnote/endnote references kept as [^id] with definitions at the end",
        "références de note de bas de page / de fin ramenées à [^id] + définitions en fin de document",
        "Fußnoten-/Endnoten-Verweise als [^id] mit Definitionen am Dokumentende übernommen",
    ]},
    Entry { key: "warnSuperscript", texts: [
        "上标 GFM 无对应语法，已降级为 ^ 前缀",
        "上標 GFM 無對應語法，已降級為 ^ 前綴",
        "GFM has no superscript, kept as a ^ prefix",
        "GFM n’a pas d’exposant, conservé avec un préfixe ^",
        "GFM hat kein Hochstellung, als ^-Präfix übernommen",
    ]},
    Entry { key: "warnSubscript", texts: [
        "下标 GFM 无对应语法，已降级为 ~ 前缀",
        "下標 GFM 無對應語法，已降級為 ~ 前綴",
        "GFM has no subscript, kept as a ~ prefix",
        "GFM n’a pas d’indice, conservé avec un préfixe ~",
        "GFM hat keine Tiefstellung, als ~-Präfix übernommen",
    ]},
    Entry { key: "warnImgTooLarge", texts: [
        "图片超过 max_image_bytes（{bytes} 字节）已跳过",
        "圖片超過 max_image_bytes（{bytes} 位元組）已跳過",
        "image over max_image_bytes ({bytes} bytes) was skipped",
        "image dépassant max_image_bytes ({bytes} octets), ignorée",
        "Bild über max_image_bytes ({bytes} Bytes) wurde übersprungen",
    ]},
    Entry { key: "warnLayoutTable", texts: [
        "检测到版式表格（单元格含多段/嵌套表），已按文档顺序展开为普通块（标题/列表/段落保留）",
        "偵測到版式表格（儲存格含多段/巢狀表），已按文件順序展開為普通塊（標題/列表/段落保留）",
        "layout table detected (cells hold multiple paragraphs/nested tables); expanded to plain blocks in document order (headings/lists/paragraphs kept)",
        "tableau de mise en page détecté (cellules à plusieurs paragraphes/tableaux imbriqués) ; développé en blocs simples dans l’ordre du document (titres/listes/paragraphes conservés)",
        "Layout-Tabelle erkannt (Zellen mit mehreren Absätzen/verschachtelten Tabellen); in Dokumentreihenfolge in normale Blöcke entpackt (Überschriften/Listen/Absätze bleiben)",
    ]},
    Entry { key: "warnMergedTable", texts: [
        "合并单元格 GFM 无法表达，已输出原样 <table> HTML",
        "合併儲存格 GFM 無法表達，已輸出原樣 <table> HTML",
        "GFM cannot express merged cells; original <table> HTML kept",
        "GFM ne peut pas représenter les cellules fusionnées ; le HTML <table> d’origine est conservé",
        "GFM kann verbundene Zellen nicht darstellen; Original-<table>-HTML beibehalten",
    ]},
    Entry { key: "docxZipOpenFailed", texts: [
        "打开 docx（ZIP）失败：{err}",
        "打開 docx（ZIP）失敗：{err}",
        "Failed to open the docx (ZIP): {err}",
        "Échec de l’ouverture du docx (ZIP) : {err}",
        "docx (ZIP) konnte nicht geöffnet werden: {err}",
    ]},
    Entry { key: "docxInvalid", texts: [
        "非有效 .docx（缺 word/document.xml）",
        "非有效 .docx（缺 word/document.xml）",
        "Not a valid .docx (word/document.xml missing)",
        "docx non valide (word/document.xml manquant)",
        "Keine gültige .docx (word/document.xml fehlt)",
    ]},
    Entry { key: "docxBadRel", texts: [
        "非法 doc_rel：须为 .md 库内相对路径",
        "非法 doc_rel：須為 .md 庫內相對路徑",
        "Invalid doc_rel: must be a .md path inside the vault",
        "doc_rel invalide : doit être un chemin .md dans le coffre",
        "Ungültiges doc_rel: muss ein .md-Pfad im Vault sein",
    ]},
    Entry { key: "docxImgOutsideVault", texts: [
        "非法路径：图片目标不在知识库根目录内",
        "非法路徑：圖片目標不在知識庫根目錄內",
        "Invalid path: the image target is outside the vault root",
        "Chemin invalide : la cible de l’image est hors du coffre",
        "Ungültiger Pfad: Das Bildziel liegt außerhalb des Vault",
    ]},
    Entry { key: "docxXmlParseFailed", texts: [
        "document.xml 解析失败：{err}",
        "document.xml 解析失敗：{err}",
        "Failed to parse document.xml: {err}",
        "Échec de l’analyse de document.xml : {err}",
        "document.xml konnte nicht analysiert werden: {err}",
    ]},

    // ---------- docx 导出 ----------
    Entry { key: "createOutFileFailed", texts: [
        "创建输出文件失败：{err}",
        "創建輸出文件失敗：{err}",
        "Failed to create the output file: {err}",
        "Échec de création du fichier de sortie : {err}",
        "Ausgabedatei konnte nicht erstellt werden: {err}",
    ]},
    Entry { key: "docxPackFailed", texts: [
        "打包 docx 失败：{err}",
        "打包 docx 失敗：{err}",
        "Failed to pack the docx: {err}",
        "Échec de l’empaquetage du docx : {err}",
        "docx konnte nicht gepackt werden: {err}",
    ]},
    Entry { key: "warnMissingImage", texts: [
        "以下图片在库内未找到，已跳过：{list}",
        "以下圖片在庫內未找到，已跳過：{list}",
        "these images were not found in the vault and were skipped: {list}",
        "ces images n’ont pas été trouvées dans le coffre et ont été ignorées : {list}",
        "diese Bilder wurden im Vault nicht gefunden und übersprungen: {list}",
    ]},
    Entry { key: "warnBadImage", texts: [
        "图片无法解码，已跳过：{rel}",
        "圖片無法解碼，已跳過：{rel}",
        "the image could not be decoded and was skipped: {rel}",
        "l’image n’a pas pu être décodée et a été ignorée : {rel}",
        "das Bild konnte nicht dekodiert werden und wurde übersprungen: {rel}",
    ]},
];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn set_lang_accepts_known_and_rejects_unknown() {
        // 单测之间共享进程内静态量，显式归位避免相互影响
        assert!(set_lang("en-US"));
        assert_eq!(current_lang(), "en-US");
        assert!(!set_lang("xx-XX"));
        assert_eq!(current_lang(), "en-US");
        assert!(set_lang("zh-CN"));
        assert_eq!(current_lang(), "zh-CN");
    }

    #[test]
    fn msg_returns_localized_text() {
        set_lang("zh-CN");
        assert_eq!(msg("readFailed", &[("err", "boom".to_string())]), "读取失败：boom");
        set_lang("en-US");
        assert_eq!(msg("readFailed", &[("err", "boom".to_string())]), "Read failed: boom");
        set_lang("fr-FR");
        assert_eq!(msg("pathOutsideVault", &[]), "Chemin invalide : la cible se trouve hors du coffre");
        set_lang("de-DE");
        assert_eq!(msg("gitNothingToCommit", &[]), "Keine Änderungen zum Committen");
        set_lang("zh-Hant");
        assert_eq!(msg("saveFailed", &[("err", "boom".to_string())]), "儲存失敗：boom");
    }

    #[test]
    fn msg_unknown_key_returns_key_and_unknown_lang_falls_back() {
        set_lang("en-US");
        assert_eq!(msg("__nope__", &[]), "__nope__");
        set_lang("qq-QQ"); // set_lang 拒绝，不应改当前语言
        assert_eq!(current_lang(), "en-US");
        // 缺占位符变量时保留 {name}
        assert_eq!(msg("readFailed", &[]), "Read failed: {err}");
        set_lang("zh-CN");
    }

    #[test]
    fn every_entry_has_all_five_languages_non_empty() {
        for e in TABLE {
            for (i, t) in e.texts.iter().enumerate() {
                assert!(!t.is_empty(), "{} 的 {} 列为空", e.key, LANGS[i]);
            }
        }
    }

    #[test]
    fn table_keys_are_unique() {
        let mut keys: Vec<&str> = TABLE.iter().map(|e| e.key).collect();
        keys.sort_unstable();
        let before = keys.len();
        keys.dedup();
        assert_eq!(keys.len(), before, "词表有重复 key");
    }
}

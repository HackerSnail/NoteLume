// uiLang.mjs —— 后端返回给前端的错误文案，按界面语言取词
//
// 词表是 src-tauri/src/ui_lang.rs 的子集：只抄 server 侧真会用到的键，键名、占位符名、
// 五种语言的顺序（zh-CN / zh-Hant / en-US / fr-FR / de-DE）与 Rust 侧保持一致。
// 前端启动与切语言时经 set_ui_lang 上报，未上报默认 zh-CN。
// 新增命令时若用到表外的键，msg() 回键名本身（同 Rust 的行为），一眼能看出缺词。

const LANGS = ['zh-CN', 'zh-Hant', 'en-US', 'fr-FR', 'de-DE']

// key -> [zh-CN, zh-Hant, en, fr, de]
const TABLE = {
  // 路径与库根校验
  pathResolveFailed: [
    '路径解析失败 {path}：{err}',
    '路徑解析失敗 {path}：{err}',
    'Failed to resolve path {path}: {err}',
    'Échec de résolution du chemin {path} : {err}',
    'Pfad {path} konnte nicht aufgelöst werden: {err}',
  ],
  pathOutsideVault: [
    '非法路径：目标不在知识库根目录内',
    '非法路徑：目標不在知識庫根目錄內',
    'Invalid path: the target is outside the vault root',
    'Chemin invalide : la cible se trouve hors du coffre',
    'Ungültiger Pfad: Das Ziel liegt außerhalb des Vault',
  ],
  pathEscapeVault: [
    '非法路径：不允许跳出知识库根目录',
    '非法路徑：不允許跳出知識庫根目錄',
    'Invalid path: escaping the vault root is not allowed',
    'Chemin invalide : sortir du coffre est interdit',
    'Ungültiger Pfad: Verlassen des Vault ist nicht erlaubt',
  ],
  badFilePath: ['非法文件路径', '非法文件路徑', 'Invalid file path', 'Chemin de fichier invalide', 'Ungültiger Dateipfad'],
  badPath: ['非法路径', '非法路徑', 'Invalid path', 'Chemin invalide', 'Ungültiger Pfad'],
  badImportFileName: ['非法文件名', '非法文件名', 'Invalid file name', 'Nom de fichier invalide', 'Ungültiger Dateiname'],
  badBase64: ['非法 base64 字符', '非法 base64 字符', 'Invalid base64 character', 'Caractère base64 invalide', 'Ungültiges Base64-Zeichen'],
  vaultPathInvalid: [
    '知识库路径无效：{err}',
    '知識庫路徑無效：{err}',
    'Invalid vault path: {err}',
    'Chemin de coffre invalide : {err}',
    'Ungültiger Vault-Pfad: {err}',
  ],
  vaultNotDir: [
    '知识库路径不是目录',
    '知識庫路徑不是目錄',
    'The vault path is not a directory',
    "Le chemin du coffre n’est pas un dossier",
    'Der Vault-Pfad ist kein Verzeichnis',
  ],

  // 文件读写
  readFailed: ['读取失败：{err}', '讀取失敗：{err}', 'Read failed: {err}', 'Échec de lecture : {err}', 'Lesen fehlgeschlagen: {err}'],
  saveFailed: ['保存失败：{err}', '儲存失敗：{err}', 'Save failed: {err}', 'Échec d’enregistrement : {err}', 'Speichern fehlgeschlagen: {err}'],
  createDirFailed: [
    '创建目录失败：{err}',
    '創建目錄失敗：{err}',
    'Failed to create directory: {err}',
    'Échec de création du dossier : {err}',
    'Verzeichnis konnte nicht erstellt werden: {err}',
  ],
  exportFailed: ['导出失败：{err}', '導出失敗：{err}', 'Export failed: {err}', "Échec de l’export : {err}", 'Export fehlgeschlagen: {err}'],
  srcNotExists: [
    '源文件不存在：{path}',
    '來源文件不存在：{path}',
    'Source file does not exist: {path}',
    "Le fichier source n’existe pas : {path}",
    'Quelldatei existiert nicht: {path}',
  ],
  readDirFailed: [
    '读取目录失败',
    '讀取目錄失敗',
    'Failed to read directory',
    'Échec de lecture du dossier',
    'Verzeichnis konnte nicht gelesen werden',
  ],

  // 快照（.notelume-backup）
  writeBackupFailed: [
    '写入备份失败：{err}',
    '寫入備份失敗：{err}',
    'Failed to write the backup: {err}',
    'Échec d’écriture de la sauvegarde : {err}',
    'Sicherung konnte nicht geschrieben werden: {err}',
  ],
  readBackupFailed: [
    '读取备份失败：{err}',
    '讀取備份失敗：{err}',
    'Failed to read the backup: {err}',
    'Échec de lecture de la sauvegarde : {err}',
    'Sicherung konnte nicht gelesen werden: {err}',
  ],
  backupOnly: [
    '非法路径：只能读取备份目录内的快照',
    '非法路徑：只能讀取備份目錄內的快照',
    'Invalid path: only snapshots inside the backup directory can be read',
    'Chemin invalide : seuls les instantanés du dossier de sauvegarde peuvent être lus',
    'Ungültiger Pfad: Nur Snapshots im Sicherungsverzeichnis können gelesen werden',
  ],

  // 库内条目操作
  emptyFileName: [
    '文件名不能为空',
    '文件名不能為空',
    'The file name cannot be empty',
    'Le nom de fichier ne peut pas être vide',
    'Der Dateiname darf nicht leer sein',
  ],
  emptyFolderName: [
    '文件夹名不能为空',
    '文件夹名不能為空',
    'The folder name cannot be empty',
    'Le nom de dossier ne peut pas être vide',
    'Der Ordnername darf nicht leer sein',
  ],
  newNameEmpty: [
    '新名称不能为空',
    '新名稱不能為空',
    'The new name cannot be empty',
    'Le nouveau nom ne peut pas être vide',
    'Der neue Name darf nicht leer sein',
  ],
  targetExists: [
    '目标已存在',
    '目標已存在',
    'The target already exists',
    'La cible existe déjà',
    'Das Ziel existiert bereits',
  ],
  renameExists: [
    '目标已存在，无法重命名 / 移动',
    '目標已存在，無法重新命名 / 移動',
    'The target already exists; rename / move rejected',
    'La cible existe déjà ; renommage / déplacement refusé',
    'Das Ziel existiert; Umbenennen / Verschieben abgelehnt',
  ],
  targetDirMissing: [
    '目标目录不存在：{err}',
    '目標目錄不存在：{err}',
    'The target directory does not exist: {err}',
    "Le dossier cible n’existe pas : {err}",
    'Das Zielverzeichnis existiert nicht: {err}',
  ],
  moveIntoSelf: [
    '不能把文件夹移动到自身内部',
    '不能把文件夾移動到自身內部',
    'A folder cannot be moved into itself',
    'Un dossier ne peut pas être déplacé dans lui-même',
    'Ein Ordner kann nicht in sich selbst verschoben werden',
  ],
  renameFailed: [
    '重命名失败：{err}',
    '重新命名失敗：{err}',
    'Rename failed: {err}',
    'Échec du renommage : {err}',
    'Umbenennen fehlgeschlagen: {err}',
  ],
  noFolderDelete: [
    '不支持删除文件夹',
    '不支援刪除文件夾',
    'Deleting folders is not supported',
    "La suppression de dossiers n’est pas prise en charge",
    'Löschen von Ordnern wird nicht unterstützt',
  ],
  trashFailed: [
    '移入回收站失败：{err}',
    '移入回收站失敗：{err}',
    'Failed to move to the recycle bin: {err}',
    'Échec du déplacement vers la corbeille : {err}',
    'Verschieben in den Papierkorb fehlgeschlagen: {err}',
  ],
  importFailed: ['导入失败：{err}', '導入失敗：{err}', 'Import failed: {err}', "Échec de l’import : {err}", 'Import fehlgeschlagen: {err}'],

  // 图片
  unsupportedImgType: [
    '不支持的图片类型：{ext}',
    '不支援的圖片類型：{ext}',
    'Unsupported image type: {ext}',
    "Type d’image non pris en charge : {ext}",
    'Nicht unterstützter Bildtyp: {ext}',
  ],
  readImgFailed: [
    '读取图片失败：{err}',
    '讀取圖片失敗：{err}',
    'Failed to read the image: {err}',
    "Échec de lecture de l’image : {err}",
    'Bild konnte nicht gelesen werden: {err}',
  ],
  writeImgFailed: [
    '写入图片失败：{err}',
    '寫入圖片失敗：{err}',
    'Failed to write the image: {err}',
    "Échec d’écriture de l’image : {err}",
    'Bild konnte nicht geschrieben werden: {err}',
  ],
  imgNotFound: [
    '找不到图片：{src}',
    '找不到圖片：{src}',
    'Image not found: {src}',
    'Image introuvable : {src}',
    'Bild nicht gefunden: {src}',
  ],

  // 只属于网页版（桌面版走原生能力，后端不实现）
  webUnsupported: [
    '该功能在网页版不可用：桌面版支持，网页沙盒只做了编辑与知识库能力。',
    '該功能在網頁版不可用：桌面版支持，網頁沙盒只做了編輯與知識庫能力。',
    'Not available in the web build: the sandbox covers editing and the knowledge base only.',
    'Non disponible dans la version web : la sandbox ne couvre que l’édition et la base de connaissances.',
    'Im Webbau nicht verfügbar: Die Sandbox deckt nur Editing und Wissensbasis ab.',
  ],
  webNetFailed: [
    '连不上本地服务（server/serve.mjs 是否已启动？）：{err}',
    '連不上本地服務（server/serve.mjs 是否已啟動？）：{err}',
    'Cannot reach the local service (is server/serve.mjs running?): {err}',
    'Service local injoignable (server/serve.mjs lancé ?) : {err}',
    'Lokaler Dienst nicht erreichbar (läuft server/serve.mjs?): {err}',
  ],
}

let lang = 'zh-CN'

/** 前端 set_ui_lang 上报的语言；不在五种之内时保持原值 */
export function setLang(next) {
  if (LANGS.includes(next)) lang = next
  return lang
}

export function getLang() {
  return lang
}

function indexOfLang() {
  const i = LANGS.indexOf(lang)
  return i < 0 ? 0 : i
}

/** 取词并插值：vars 是 { 占位符名: 值 }；缺键回键名本身（同 Rust 的 msg） */
export function msg(key, vars) {
  const texts = TABLE[key]
  if (!texts) return key
  return texts[indexOfLang()].replace(/\{(\w+)\}/g, (m, name) => {
    const v = vars && Object.prototype.hasOwnProperty.call(vars, name) ? vars[name] : m
    return String(v)
  })
}

export const LANG_LIST = LANGS

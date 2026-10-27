# 全量前端测试：逐个跑 tests/*.test.mjs，汇总失败项
$fails = @()
$files = Get-ChildItem (Join-Path $PSScriptRoot '..\tests\*.test.mjs')
foreach ($f in $files) {
  node $f.FullName *> $null
  if ($LASTEXITCODE -ne 0) { $fails += $f.Name }
}
if ($fails.Count) { "FAILED: " + ($fails -join ', ') } else { "ALL PASSED (" + $files.Count + " files)" }

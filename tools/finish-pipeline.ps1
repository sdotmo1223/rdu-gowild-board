# Finishes the refresh pipeline once a verified token is in place.
#
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\finish-pipeline.ps1 -DryRun
#   powershell -NoProfile -ExecutionPolicy Bypass -File tools\finish-pipeline.ps1
#
# Enables the 15-minute cron, dispatches exactly ONE sweep, waits for it, then
# reads the live page to prove the whole chain: Frontier -> collector -> KV ->
# Worker -> HTML. No credentials are passed here on purpose: gh holds its own,
# and the final check reads the same page a browser would.
#
# -DryRun changes nothing; it reports state and what it would do.

param([switch]$DryRun)

$ErrorActionPreference = 'Continue'
$root = Split-Path -Parent $PSScriptRoot
$repo = 'sdotmo1223/rdu-gowild-board'
$wf   = '405623067'
$base = 'https://rdu-gowild-board.sdotmo1223.workers.dev'

$gh = (Get-Command gh -ErrorAction SilentlyContinue).Source
if (-not $gh) {
    $fallback = 'C:\Program Files\GitHub CLI\gh.exe'
    if (Test-Path $fallback) { $gh = $fallback }
}
if (-not $gh) { Write-Host 'gh CLI not found; cannot drive the workflow.'; exit 2 }

$tokFile = Join-Path $root '.board-token'
if (-not (Test-Path $tokFile)) { Write-Host '.board-token is missing; cannot read the board.'; exit 2 }
$tok = (Get-Content $tokFile -Raw).Trim()

function Get-BoardStamp {
    try {
        $r = Invoke-WebRequest -Uri ($base + '/s/' + $tok) -UseBasicParsing -TimeoutSec 30
        $html = [string]$r.Content
        $m = [regex]::Match($html, '<span class="stamp[^"]*">([^<]*)</span>')
        $rows = ([regex]::Matches($html, 'class="row"')).Count
        $stamp = '?'
        if ($m.Success) { $stamp = $m.Groups[1].Value.Trim() }
        return [pscustomobject]@{ stamp = $stamp; rows = $rows; reachable = $true }
    } catch {
        return [pscustomobject]@{ stamp = 'UNREACHABLE'; rows = 0; reachable = $false }
    }
}

Write-Host '=== the board as a visitor sees it right now ==='
$before = Get-BoardStamp
Write-Host ("  snapshot age: {0}  |  rows: {1}" -f $before.stamp, $before.rows)
Write-Host ''

Write-Host '=== workflow state ==='
$list = & $gh workflow list --all --repo $repo --json name,state,id 2>&1 | ConvertFrom-Json
$found = $null
foreach ($w in $list) { if ([string]$w.id -eq $wf) { $found = $w } }
if ($found) { Write-Host ("  {0}: {1}" -f $found.name, $found.state) }
else { Write-Host '  workflow id 405623067 not found on the repo' }
Write-Host ''

if ($DryRun) {
    Write-Host '=== DRY RUN: nothing changed ==='
    Write-Host '  would enable the cron, dispatch ONE run, wait, and re-read the page.'
    exit 0
}

Write-Host '=== enabling the 15-minute cron ==='
& $gh workflow enable $wf --repo $repo 2>&1 | Out-Host
Write-Host ''
Write-Host '=== dispatching exactly one sweep ==='
& $gh workflow run board.yml --repo $repo 2>&1 | Out-Host

$runId = $null
for ($i = 0; $i -lt 4; $i++) {
    Start-Sleep -Seconds 5
    $runs = & $gh run list --repo $repo --workflow board.yml --limit 1 --json databaseId 2>&1 | ConvertFrom-Json
    if ($runs -and $runs.Count -ge 1) { $runId = $runs[0].databaseId; break }
}
if (-not $runId) { Write-Host '  no run appeared; check the Actions tab.'; exit 1 }
Write-Host ("  run id: {0}" -f $runId)
Write-Host ''

Write-Host '=== waiting (a sweep is ~2-3 min; 28 sequential requests) ==='
$status = $null
for ($i = 0; $i -lt 20; $i++) {
    Start-Sleep -Seconds 15
    $s = & $gh run view $runId --repo $repo --json status,conclusion 2>&1 | ConvertFrom-Json
    Write-Host ("  [{0}] {1} / {2}" -f (($i + 1) * 15), $s.status, $s.conclusion)
    if ($s.status -eq 'completed') { $status = $s; break }
}
Write-Host ''

if ($status -and $status.conclusion -ne 'success') {
    Write-Host '=== the run failed; failing step tail ==='
    & $gh run view $runId --repo $repo --log-failed 2>&1 | Select-Object -Last 20 | Out-Host
    Write-Host ''
}

Write-Host '=== the board after the run ==='
$after = Get-BoardStamp
Write-Host ("  snapshot age: {0}  |  rows: {1}" -f $after.stamp, $after.rows)
Write-Host ''

Write-Host '=== verdict ==='
if ($after.reachable -and $after.stamp -ne $before.stamp) {
    Write-Host '  PASS: the page changed, so KV was written and the Worker is serving it.'
    exit 0
} elseif ($after.reachable -and $after.stamp -eq $before.stamp) {
    Write-Host '  INCONCLUSIVE: the page did not change. If the run failed above, the'
    Write-Host '  credential is still wrong; disabling the cron is the safe next move.'
    exit 1
} else {
    Write-Host '  UNREACHABLE: could not read the board page at all.'
    exit 1
}

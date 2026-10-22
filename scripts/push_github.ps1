# Windows version of push_github.command: publishes this folder to GitHub.
# After it runs, the repository's main branch holds exactly what is in this
# folder: additions, changes AND removals. Start it with push_github.bat
# (double-click), which runs this file with PowerShell.
#
# Same steps as the Mac script:
#   1. checks that version.json and package.json give the same version;
#   2. clones the repository into a temporary folder (this folder is never
#      touched, and needs no .git of its own);
#   3. refuses unless that version is strictly higher than the one on GitHub;
#   4. makes the clone identical to this folder (node_modules, dist, .git and
#      .DS_Store excepted);
#   5. holds version.json back while the GitHub Release vX.Y.Z does not exist
#      (except for the very first publication: nothing is installed yet);
#   6. lists the changes and waits for "y" before sending anything;
#   7. commits and pushes to main. Never forced.
#
# Windows specifics:
#   - line endings are kept exactly as they are in the folder (core.autocrlf
#     off in the temporary clone): a .command or .sh script with Windows line
#     endings would no longer run on a Mac or on Linux;
#   - Windows has no "executable" flag, so the .command and .sh scripts are
#     marked executable for GitHub here, or they would arrive broken on a Mac.
#
# Needs Git for Windows (https://git-scm.com/download/win). Its Credential
# Manager opens a GitHub sign-in window the first time.
#
# Plain ASCII on purpose: Windows PowerShell 5.1 reads a file without a BOM
# in the local code page.
#
# For tests only: PUSH_GITHUB_REMOTE replaces the repository address,
# PUSH_GITHUB_RELEASE (yes/no) replaces the check of the GitHub Release,
# PUSH_GITHUB_ANSWER answers the final question, PUSH_GITHUB_NOPAUSE=1 does
# not wait for Enter at the end.

$ErrorActionPreference = 'Continue'
$Src = Split-Path -Parent $PSScriptRoot

function Done([int]$code) {
  Write-Host ''
  if (-not $env:PUSH_GITHUB_NOPAUSE) { [void](Read-Host 'Press Enter to close this window') }
  exit $code
}
function Fail([string]$msg) { Write-Host ''; Write-Host "X $msg" -ForegroundColor Red; Done 1 }

function Read-Json([string]$file) {
  try { return (Get-Content -LiteralPath $file -Raw -Encoding UTF8 | ConvertFrom-Json) } catch { return $null }
}
function Parse-Version([string]$v) {
  $p = @(0, 0, 0)
  $parts = ([string]$v).Split('.')
  for ($i = 0; $i -lt 3 -and $i -lt $parts.Count; $i++) { $n = 0; [void][int]::TryParse($parts[$i], [ref]$n); $p[$i] = $n }
  return $p
}
function Is-Newer([string]$a, [string]$b) {
  $x = Parse-Version $a; $y = Parse-Version $b
  for ($i = 0; $i -lt 3; $i++) { if ($x[$i] -ne $y[$i]) { return ($x[$i] -gt $y[$i]) } }
  return $false
}

if (-not (Get-Command git -ErrorAction SilentlyContinue)) { Fail 'git is not installed. Install Git for Windows: https://git-scm.com/download/win' }
$vj = Join-Path $Src 'version.json'
$pj = Join-Path $Src 'package.json'
if (-not (Test-Path -LiteralPath $vj)) { Fail "No version.json in $Src." }
if (-not (Test-Path -LiteralPath $pj)) { Fail "No package.json in $Src." }

# -- Versions and address ----------------------------------------------------
$v = Read-Json $vj
$p = Read-Json $pj
if (-not $v -or -not $v.version) { Fail 'version.json has no version.' }
$Ver = [string]$v.version
$Name = [string]$p.name
if ($Ver -ne [string]$p.version) { Fail "version.json says $Ver but package.json says $($p.version). Fix the bump first." }

$Url = ''
if ($p.repository -is [string]) { $Url = $p.repository } elseif ($p.repository -and $p.repository.url) { $Url = [string]$p.repository.url }
if (-not $Url -and $v.url) { $Url = [string]$v.url }
$Slug = ($Url -replace '^(git\+)?https?://github\.com/', '' -replace '^git@github\.com:', '' -replace '\.git$', '')
$Slug = (($Slug -split '/') | Select-Object -First 2) -join '/'
if ($Slug -notmatch '^[^/]+/[^/]+$') { Fail 'No GitHub address found in package.json or version.json.' }
$Remote = $env:PUSH_GITHUB_REMOTE
if (-not $Remote) { $Remote = "https://github.com/$Slug.git" }

Write-Host "Project : $Name $Ver"
Write-Host "Folder  : $Src"
Write-Host "GitHub  : $Slug (branch main)"
Write-Host ''

# -- Temporary clone -----------------------------------------------------------
$Tmp = Join-Path ([System.IO.Path]::GetTempPath()) ('push_github.' + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Path $Tmp | Out-Null
$Repo = Join-Path $Tmp 'repo'
try {
  Write-Host 'Downloading the current state of GitHub...'
  $First = $false
  git clone --quiet -c core.autocrlf=false -c core.safecrlf=false --branch main $Remote $Repo 2>$null
  if ($LASTEXITCODE -ne 0) {
    # A repository created empty on GitHub has no main branch yet.
    if (Test-Path -LiteralPath $Repo) { Remove-Item -LiteralPath $Repo -Recurse -Force }
    git clone --quiet -c core.autocrlf=false -c core.safecrlf=false $Remote $Repo 2>$null
    if ($LASTEXITCODE -ne 0) { Fail "Could not download $Remote (network, address or permissions). Create the repository on GitHub first (empty, no README)." }
    git -C $Repo rev-parse --verify -q HEAD 2>$null | Out-Null
    if ($LASTEXITCODE -eq 0) { Fail "$Remote exists but has no branch named main." }
    $First = $true
    git -C $Repo checkout --quiet -b main 2>$null
    Write-Host 'The repository is empty: this is its first publication.'
  }

  $PubVer = ''
  $pv = Read-Json (Join-Path $Repo 'version.json')
  if ($pv -and $pv.version) { $PubVer = [string]$pv.version }
  $shown = $PubVer; if (-not $shown) { $shown = 'none' }
  Write-Host "Version on GitHub: $shown   -   version here: $Ver"
  if (-not (Is-Newer $Ver $PubVer)) {
    $was = $PubVer; if (-not $was) { $was = 'the published one' }
    Fail "Every publication carries a new version: $Ver is not higher than $was. Bump first."
  }

  # -- Make the clone identical to the folder ------------------------------------
  Get-ChildItem -LiteralPath $Repo -Force | Where-Object { $_.Name -ne '.git' } | Remove-Item -Recurse -Force
  Get-ChildItem -LiteralPath $Src -Force | Where-Object { @('.git', 'node_modules', 'dist') -notcontains $_.Name } |
    ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination $Repo -Recurse -Force }
  Get-ChildItem -LiteralPath $Repo -Recurse -Force -Filter '.DS_Store' -File -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -notlike (Join-Path $Repo '.git') + '*' } | Remove-Item -Force
  # The maintainer's own files (Noar, 22/10/2026): rules for the AIs, the
  # project's internal state, the texts pasted into the Releases. They stay in
  # the ZIP but never go to GitHub; already there, they are removed by this push.
  foreach ($f in @('CLAUDE.md', 'AGENTS.md', 'ETAT_PROJET.md')) { Remove-Item -LiteralPath (Join-Path $Repo $f) -Force -ErrorAction SilentlyContinue }
  Get-ChildItem -LiteralPath (Join-Path $Repo 'docs') -Filter 'RELEASE-*.md' -File -ErrorAction SilentlyContinue | Remove-Item -Force

  Set-Location -LiteralPath $Repo

  # -- version.json waits for its Release ----------------------------------------
  $released = $false
  if ($env:PUSH_GITHUB_RELEASE -eq 'yes') { $released = $true }
  elseif ($env:PUSH_GITHUB_RELEASE -eq 'no') { $released = $false }
  else {
    try {
      [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
      $r = Invoke-WebRequest -UseBasicParsing -Uri "https://api.github.com/repos/$Slug/releases/tags/v$Ver" -Headers @{ 'User-Agent' = 'push_github' }
      $released = ($r.StatusCode -eq 200)
    } catch { $released = $false }
  }
  if ($First) { $released = $true }   # nothing installed anywhere yet: no notice to hold back
  $held = $false
  if (-not $released) {
    git cat-file -e HEAD:version.json 2>$null
    if ($LASTEXITCODE -eq 0) { git checkout --quiet HEAD -- version.json; $held = $true }
  }

  git add -A 2>$null
  # Executable on GitHub, as they are on a Mac: Windows has no such flag.
  $scripts = @(git ls-files -- '*.command' '*.sh')
  foreach ($f in $scripts) { if ($f) { git update-index --chmod=+x -- $f } }

  git diff --cached --quiet
  if ($LASTEXITCODE -eq 0) {
    Write-Host ''
    if ($held) {
      Write-Host "OK The code of $Ver is already on GitHub." -ForegroundColor Green
      Write-Host "   version.json is waiting for the GitHub Release v$Ver (with its binaries)."
      Write-Host '   Publish it, then run this script again.'
    } else {
      Write-Host 'OK GitHub is already identical to this folder. Nothing to send.' -ForegroundColor Green
    }
    Done 0
  }

  Write-Host ''
  Write-Host 'Changes to send (A added, M modified, D deleted, R renamed):'
  git status --short | ForEach-Object { Write-Host "  $_" }
  Write-Host ''
  if ($held) {
    Write-Host "version.json is NOT sent: the Release v$Ver does not exist on GitHub yet."
    Write-Host "Installed copies will only announce $Ver once you publish the Release"
    Write-Host 'with its binaries and run this script again.'
  } else {
    Write-Host "version.json IS sent: every installed copy will announce $Ver."
  }
  Write-Host ''
  $answer = $env:PUSH_GITHUB_ANSWER
  if (-not $answer) { $answer = Read-Host 'Send these changes to GitHub? (y/n)' }
  if ($answer -ne 'y' -and $answer -ne 'Y') { Write-Host 'Nothing sent.'; Done 0 }

  $owner = ($Slug -split '/')[0]
  if (-not (git config user.name)) { git config user.name $owner }
  if (-not (git config user.email)) { git config user.email "$owner@users.noreply.github.com" }

  $label = $Name; if (-not $label) { $label = 'release' }
  $changed = @(git diff --cached --name-only)
  if (-not $held -and $changed.Count -eq 1 -and $changed[0] -eq 'version.json') { $msg = "$label ${Ver}: version.json (update notice)" }
  else { $msg = "$label $Ver" }
  git commit --quiet -m $msg
  if ($LASTEXITCODE -ne 0) { Fail 'The commit failed.' }

  $useGh = $false
  if (Get-Command gh -ErrorAction SilentlyContinue) { gh auth status 2>$null | Out-Null; if ($LASTEXITCODE -eq 0) { $useGh = $true } }
  if ($useGh) { git -c credential.helper= -c 'credential.helper=!gh auth git-credential' push origin HEAD:main }
  else { git push origin HEAD:main }
  if ($LASTEXITCODE -ne 0) { Fail 'The push was refused. Nothing was changed on GitHub.' }

  Write-Host ''
  Write-Host "OK Sent: $msg" -ForegroundColor Green
  if ($held) {
    Write-Host ''
    Write-Host "Next: publish the GitHub Release v$Ver with its binaries,"
    Write-Host 'then run this script again to send version.json.'
  }
  Done 0
}
finally {
  Set-Location -LiteralPath $Src
  Remove-Item -LiteralPath $Tmp -Recurse -Force -ErrorAction SilentlyContinue
}

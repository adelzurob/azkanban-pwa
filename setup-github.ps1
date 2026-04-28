<#
.SYNOPSIS
    One-shot GitHub setup for azkanban-pwa: push the scaffold and enable Pages.

.DESCRIPTION
    Initializes the local git repo (if needed), verifies that .gitignore is
    protecting your Azure client ID, pushes to a pre-existing GitHub repo,
    and enables GitHub Pages on main / (root). Idempotent — safe to re-run
    if anything fails partway through.

.PARAMETER GithubUser
    Your GitHub username. Prompted interactively if omitted.

.PARAMETER RepoName
    The repo name on GitHub. Defaults to "azkanban-pwa".

.EXAMPLE
    .\setup-github.ps1 -GithubUser adel-zurob

    Run from inside the azkanban-pwa folder. The repo MUST already exist on
    GitHub (created as empty — no README, no .gitignore, no license).

.NOTES
    Prerequisites:
      - git installed:                winget install Git.Git
      - GitHub CLI installed:         winget install GitHub.cli
      - GitHub CLI authenticated:     gh auth login
      - Repo already created on GitHub at https://github.com/new
        (do NOT check Add README / .gitignore / license — leave it empty)
#>
[CmdletBinding()]
param(
    [string]$GithubUser,
    [string]$RepoName = "azkanban-pwa"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

# --- Output helpers ----------------------------------------------------------

function Write-Step($msg) { Write-Host "==> $msg" -ForegroundColor Cyan }
function Write-Ok($msg)   { Write-Host "    [OK]   $msg" -ForegroundColor Green }
function Write-Warn2($msg) { Write-Host "    [WARN] $msg" -ForegroundColor Yellow }
function Write-Fail($msg) {
    Write-Host "    [FAIL] $msg" -ForegroundColor Red
    Write-Host ""
    exit 1
}

# --- 1. Prerequisites --------------------------------------------------------

Write-Step "Checking prerequisites"

if (-not (Get-Command git -ErrorAction SilentlyContinue)) {
    Write-Fail "git is not installed. Run: winget install Git.Git"
}
Write-Ok "git installed"

if (-not (Get-Command gh -ErrorAction SilentlyContinue)) {
    Write-Fail "GitHub CLI (gh) is not installed. Run: winget install GitHub.cli"
}
Write-Ok "gh installed"

$null = & gh auth status 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail "GitHub CLI is not authenticated. Run: gh auth login"
}
Write-Ok "gh authenticated"

# --- 2. Verify we're in the right folder -------------------------------------

if (-not (Test-Path "manifest.webmanifest") -or -not (Test-Path "index.html")) {
    Write-Fail "Run this script from inside the azkanban-pwa folder. Current dir does not look like the PWA project."
}
Write-Ok "Running from azkanban-pwa folder"

# --- 3. Collect config -------------------------------------------------------

if (-not $GithubUser) {
    $GithubUser = Read-Host "GitHub username"
}
if (-not $GithubUser -or $GithubUser -match '\s') {
    Write-Fail "GitHub username is required and must contain no spaces."
}

$remoteUrl = "https://github.com/$GithubUser/$RepoName.git"
$pagesUrl  = "https://$GithubUser.github.io/$RepoName/"

Write-Step "Target repo:  $remoteUrl"
Write-Step "Future Pages: $pagesUrl"

# --- 4. Verify the repo exists on GitHub -------------------------------------

$null = & gh repo view "$GithubUser/$RepoName" 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Fail "Repo $GithubUser/$RepoName not found on GitHub. Create it first at https://github.com/new (DO NOT add README, .gitignore, or license)."
}
Write-Ok "Repo $GithubUser/$RepoName exists on GitHub"

# --- 5. git init / branch ----------------------------------------------------

Write-Step "Initializing local git repo"

if (-not (Test-Path ".git")) {
    git init -q
    Write-Ok "git init done"
} else {
    Write-Ok "git already initialized"
}

$currentBranch = & git symbolic-ref --short HEAD 2>$null
if (-not $currentBranch -or $currentBranch -ne "main") {
    git branch -M main 2>$null
    Write-Ok "Branch set to main"
} else {
    Write-Ok "Already on main"
}

# --- 6. CRITICAL: verify gitignore protection for config.js ------------------
# This block is the single most important defense in the script. config.js
# contains your Azure client ID. We enforce three independent checks before
# allowing any push.

Write-Step "Verifying src/config.js is protected from being committed"

# 6a. Check .gitignore exists and lists src/config.js
if (-not (Test-Path ".gitignore")) {
    Write-Fail ".gitignore is missing. Aborting before any push could leak your client ID."
}
$ignoreContent = Get-Content .gitignore -Raw
if ($ignoreContent -notmatch "src/config\.js") {
    Write-Fail ".gitignore does NOT exclude src/config.js. Add the line: src/config.js"
}
Write-Ok ".gitignore excludes src/config.js"

# 6b. Make sure it isn't already tracked from a previous accident
$tracked = & git ls-files "src/config.js" 2>$null
if ($tracked) {
    Write-Host ""
    Write-Host "    src/config.js is already tracked in git history." -ForegroundColor Red
    Write-Host "    To remove it, run these commands and then re-run this script:" -ForegroundColor Red
    Write-Host ""
    Write-Host "      git rm --cached src/config.js" -ForegroundColor White
    Write-Host "      git commit -m 'Remove gitignored config'" -ForegroundColor White
    Write-Host ""
    Write-Host "    If you already pushed it anywhere, regenerate the Azure client ID." -ForegroundColor Red
    Write-Fail "Aborting to protect your client ID."
}
Write-Ok "src/config.js not tracked in git history"

# 6c. If the file exists, check git agrees it's ignored
if (Test-Path "src/config.js") {
    $null = & git check-ignore "src/config.js" 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Fail "git check-ignore disagrees: src/config.js would be staged. Inspect .gitignore syntax."
    }
    Write-Ok "git check-ignore confirms src/config.js is excluded"
} else {
    Write-Warn2 "src/config.js does not exist yet. That's fine if you haven't done Azure registration; create it from the template afterwards."
}

# --- 7. Stage --------------------------------------------------------------

Write-Step "Staging files"
git add -A

# Defense-in-depth: re-check after staging that config.js was not slipped in
$stagedConfig = & git diff --cached --name-only | Where-Object { $_ -eq "src/config.js" }
if ($stagedConfig) {
    Write-Fail "src/config.js was staged anyway. Aborting. Inspect .gitignore."
}
Write-Ok "config.js confirmed NOT staged"

# --- 8. Commit ---------------------------------------------------------------

Write-Step "Committing"
$staged = & git diff --cached --name-only
$count = ($staged | Measure-Object).Count
if ($count -eq 0) {
    Write-Ok "Nothing new to commit"
} else {
    git commit -q -m "Initial PWA scaffold (sign-in + read-only board list)"
    Write-Ok "Committed $count file(s)"
}

# --- 9. Configure remote -----------------------------------------------------

Write-Step "Configuring remote 'origin'"

$existing = $null
try { $existing = & git remote get-url origin 2>$null } catch { $existing = $null }

if (-not $existing) {
    git remote add origin $remoteUrl
    Write-Ok "Added origin -> $remoteUrl"
} elseif ($existing -ne $remoteUrl) {
    Write-Warn2 "origin currently points to $existing"
    git remote set-url origin $remoteUrl
    Write-Ok "Updated origin -> $remoteUrl"
} else {
    Write-Ok "origin already correct"
}

# --- 10. Push ---------------------------------------------------------------

Write-Step "Pushing to GitHub"
git push -u origin main
if ($LASTEXITCODE -ne 0) {
    Write-Fail "git push failed. See message above. Common causes: gh auth scope, branch protection, network."
}
Write-Ok "Push complete"

# --- 11. Enable GitHub Pages -------------------------------------------------

Write-Step "Configuring GitHub Pages (deploy from main / root)"

$null = & gh api "repos/$GithubUser/$RepoName/pages" 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Ok "Pages already enabled"
} else {
    $null = & gh api -X POST "repos/$GithubUser/$RepoName/pages" `
        -f 'source[branch]=main' `
        -f 'source[path]=/' 2>&1
    if ($LASTEXITCODE -ne 0) {
        Write-Warn2 "Could not enable Pages via API automatically."
        Write-Warn2 "Enable it manually here:"
        Write-Warn2 "  https://github.com/$GithubUser/$RepoName/settings/pages"
        Write-Warn2 "  Source = Deploy from a branch  |  Branch = main  |  Folder = / (root)"
    } else {
        Write-Ok "Pages enabled (build will start automatically)"
    }
}

# --- 12. Done ----------------------------------------------------------------

Write-Host ""
Write-Host "============================================================" -ForegroundColor Green
Write-Host " GitHub setup complete" -ForegroundColor Green
Write-Host "============================================================" -ForegroundColor Green
Write-Host ""
Write-Host "Repository:  https://github.com/$GithubUser/$RepoName"
Write-Host "Live URL:    $pagesUrl"
Write-Host ""
Write-Host "Pages takes ~30-60 seconds to build on first deploy."
Write-Host "Watch progress at:"
Write-Host "  https://github.com/$GithubUser/$RepoName/actions"
Write-Host ""
Write-Host "Next steps:"
Write-Host "  1. Wait ~1 min, then visit Live URL above. You should see the sign-in screen."
Write-Host "  2. Add this redirect URI to your Azure app registration:"
Write-Host "       ${pagesUrl}redirect.html"
Write-Host "     (Entra portal -> App registrations -> AZKanban PWA -> Authentication -> Add a platform -> SPA)"
Write-Host "  3. On iPhone, open Live URL in Safari -> Share -> Add to Home Screen."
Write-Host ""

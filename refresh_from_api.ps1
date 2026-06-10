# JitBit Cockpit: Live Sync and Regenerate Dashboard
# This PowerShell script pulls the latest tickets from the JitBit REST API,
# preserves existing AI triage analysis, heuristically triages any new tickets,
# and regenerates the self-contained dashboard.html.

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "      JITBIT COCKPIT - LIVE SYNC         " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

# 1. Configuration & Credentials Setup
$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$EnvFile = Join-Path $ScriptDir ".env"
$JsonDbFile = Join-Path $ScriptDir "triage_data.json"
$DashboardFile = Join-Path $ScriptDir "dashboard.html"

$TenantUrl = ""
$Username = ""
$Password = ""
$OpenRouterApiKey = ""
$LocationsRaw = ""

# Load from .env file if it exists
if (Test-Path $EnvFile) {
    Write-Host "Loading credentials from .env file..." -ForegroundColor Gray
    Get-Content $EnvFile | ForEach-Object {
        if ($_ -match "^\s*([^#=\s]+)\s*=\s*(.*)$") {
            $Key = $Matches[1].Trim()
            $Value = $Matches[2].Trim().Trim('"').Trim("'")
            if ($Key -eq "JITBIT_TENANT_URL") { $TenantUrl = $Value }
            elseif ($Key -eq "JITBIT_USERNAME") { $Username = $Value }
            elseif ($Key -eq "JITBIT_PASSWORD") { $Password = $Value }
            elseif ($Key -eq "OPENROUTER_API_KEY") { $OpenRouterApiKey = $Value }
            elseif ($Key -eq "LOCATIONS") { $LocationsRaw = $Value }
        }
    }
}

# Prompt user for missing values
if ([string]::IsNullOrEmpty($TenantUrl)) {
    $TenantUrl = Read-Host "Enter JitBit Base URL (e.g. https://yourdomain.jitbit.com/helpdesk)"
}
if ([string]::IsNullOrEmpty($Username)) {
    $Username = Read-Host "Enter JitBit Username/Email"
}
if ([string]::IsNullOrEmpty($Password)) {
    $PasswordInput = Read-Host "Enter JitBit Password or API Token" -AsSecureString
    $BSTR = [System.Runtime.InteropServices.Marshal]::SecureStringToBSTR($PasswordInput)
    $Password = [System.Runtime.InteropServices.Marshal]::PtrToStringAuto($BSTR)
}

# Normalize Tenant URL
$TenantUrl = $TenantUrl.TrimEnd('/')
if (-not $TenantUrl.StartsWith("http")) {
    $TenantUrl = "https://" + $TenantUrl
}

Write-Host "Syncing with: $TenantUrl" -ForegroundColor Yellow
Write-Host "User: $Username" -ForegroundColor Yellow

# Parse LOCATIONS from .env (format: KEY:Full Name,KEY2:Full Name2,...)
$LocationList = @()
if (-not [string]::IsNullOrEmpty($LocationsRaw)) {
    foreach ($entry in $LocationsRaw.Split(',')) {
        $parts = $entry.Trim().Split(':')
        if ($parts.Length -ge 2) {
            $LocationList += @{
                key   = $parts[0].Trim()
                label = ($parts[1..($parts.Length - 1)] -join ':').Trim()
            }
        }
    }
    Write-Host "Loaded $($LocationList.Count) location(s): $(($LocationList | ForEach-Object { $_.key }) -join ', ')" -ForegroundColor Gray
} else {
    Write-Host "No LOCATIONS configured in .env - location detection will be skipped." -ForegroundColor Yellow
}

# 2. Build Authentication Header
$Headers = @{
    "Authorization" = "Bearer $Password"
    "Accept"        = "application/json"
}

# 3. Load Existing Local Database (to preserve AI Triage metadata)
$ExistingDatabase = @()
if (Test-Path $JsonDbFile) {
    try {
        $RawJson = Get-Content $JsonDbFile -Raw -ErrorAction SilentlyContinue
        $ExistingDatabase = ConvertFrom-Json $RawJson
        Write-Host "Loaded $($ExistingDatabase.Count) existing tickets from local cache." -ForegroundColor Gray
    } catch {
        Write-Host "Could not load existing triage_data.json, starting fresh." -ForegroundColor Yellow
    }
}

# 4. AI Triage Function (OpenRouter / Gemma)
function Invoke-AITriage {
    param(
        [string]$ApiKey,
        [string]$Subject,
        [string]$Description,
        [string]$SubmitterName,
        [array]$Comments
    )

    $ConversationText = ""
    if ($Comments.Count -gt 0) {
        $ConversationText = "`n`nConversation thread:`n"
        foreach ($c in $Comments) {
            $ConversationText += "[$($c.date)] $($c.sender): $($c.body)`n"
        }
    }

    $Prompt = @"
You are a school IT helpdesk triage assistant. Analyze this support ticket and respond with ONLY a valid JSON object — no markdown fences, no explanation, nothing else.

Ticket Subject: $Subject
Submitted by: $SubmitterName
Description: $Description$ConversationText

Return exactly this JSON structure:
{
  "priority": "Critical|High|Medium|Low",
  "justification": "One sentence explaining the priority.",
  "recommended_actions": ["Action 1", "Action 2", "Action 3"],
  "draft_response": "A professional, friendly reply to the submitter."
}

Priority guide:
- Critical: IEP/special ed accommodations, safety issues, complete system failure blocking a class
- High: Hardware broken/cracked, multiple users affected, time-sensitive instructional impact
- Medium: Single user inconvenienced, workaround exists
- Low: Project/enhancement, deferred work, cosmetic issue
"@

    $RequestBody = @{
        model    = "openrouter/free"
        messages = @(
            @{ role = "user"; content = $Prompt }
        )
    } | ConvertTo-Json -Depth 10

    $ApiHeaders = @{
        "Authorization" = "Bearer $ApiKey"
        "Content-Type"  = "application/json"
        "HTTP-Referer"  = $TenantUrl
    }

    $MaxRetries = 3
    $Delay      = 15
    for ($Attempt = 1; $Attempt -le $MaxRetries; $Attempt++) {
        try {
            # WebClient with explicit UTF-8 encoding avoids PS 5.1 Latin-1 fallback on Invoke-RestMethod
            $wc = New-Object System.Net.WebClient
            foreach ($k in $ApiHeaders.Keys) { $wc.Headers.Add($k, $ApiHeaders[$k]) }
            $wc.Encoding = [System.Text.Encoding]::UTF8
            $RawJson     = $wc.UploadString("https://openrouter.ai/api/v1/chat/completions", "POST", $RequestBody)
            $Response    = $RawJson | ConvertFrom-Json
            $RawContent  = $Response.choices[0].message.content.Trim()
            $StartBrace  = $RawContent.IndexOf('{')
            $EndBrace    = $RawContent.LastIndexOf('}')
            if ($StartBrace -ge 0 -and $EndBrace -gt $StartBrace) {
                $RawContent = $RawContent.Substring($StartBrace, $EndBrace - $StartBrace + 1)
            }
            $Parsed = $RawContent | ConvertFrom-Json
            # Normalize fancy Unicode typography to plain ASCII so the dashboard renders cleanly
            $FixChars = @{
                [char]0x2018 = "'"   # left single quotation mark
                [char]0x2019 = "'"   # right single quotation mark
                [char]0x201C = '"'   # left double quotation mark
                [char]0x201D = '"'   # right double quotation mark
                [char]0x2013 = '-'   # en dash
                [char]0x2014 = '-'   # em dash
                [char]0x2011 = '-'   # non-breaking hyphen
                [char]0x00A0 = ' '   # non-breaking space
                [char]0x202F = ' '   # narrow non-breaking space
                [char]0x2026 = '...' # ellipsis
                [char]0x2192 = '->'  # right arrow
                [char]0x2190 = '<-'  # left arrow
                [char]0x2022 = '-'   # bullet
                [char]0x00B7 = '-'   # middle dot
            }
            foreach ($Field in @('draft_response', 'justification')) {
                if ($Parsed.$Field) {
                    $Clean = $Parsed.$Field
                    foreach ($Bad in $FixChars.Keys) { $Clean = $Clean.Replace([string]$Bad, $FixChars[$Bad]) }
                    $Parsed.$Field = $Clean
                }
            }
            return $Parsed
        } catch {
            $Msg = $_.ToString()
            if ($Msg -like "*429*" -and $Attempt -lt $MaxRetries) {
                Write-Host "    Rate limited (429). Waiting ${Delay}s before retry $Attempt/$($MaxRetries - 1)..." -ForegroundColor Yellow
                Start-Sleep -Seconds $Delay
                $Delay = $Delay * 2
            } else {
                Write-Host "    AI triage failed: $Msg" -ForegroundColor Yellow
                return $null
            }
        }
    }
    return $null
}

# 5. Fetch Tickets from JitBit API (paginated)
Write-Host "Fetching assigned tickets from JitBit API..." -ForegroundColor Cyan
$LiveTickets = @()
$PageSize    = 50
$Offset      = 0

do {
    try {
        $Page = Invoke-RestMethod -Uri "$TenantUrl/api/Tickets?mode=handledbyme&count=$PageSize&offset=$Offset" -Method Get -Headers $Headers
        $LiveTickets += $Page
        $Offset += $PageSize
        Write-Host "  Fetched $($Page.Count) tickets (running total: $($LiveTickets.Count))..." -ForegroundColor Gray
    } catch {
        Write-Host "API Request failed: $_" -ForegroundColor Red
        Write-Host "Please check your credentials in .env and your internet connection." -ForegroundColor Red
        Exit 1
    }
} while ($Page.Count -eq $PageSize)

Write-Host "Successfully fetched $($LiveTickets.Count) assigned tickets from JitBit." -ForegroundColor Green

# 5. Process Tickets & Detail Threading
$ProcessedTickets = @()
$Index = 1

foreach ($ticket in $LiveTickets) {
    $TicketId = $ticket.IssueID
    Write-Host "[$Index/$($LiveTickets.Count)] Fetching thread detail for Ticket #$($TicketId): $($ticket.Subject)..." -ForegroundColor Gray
    $Index++

    # Fetch individual ticket details
    $DetailUrl = "$TenantUrl/api/Ticket?id=$TicketId"
    $FullTicket = $null
    try {
        $FullTicket = Invoke-RestMethod -Uri $DetailUrl -Method Get -Headers $Headers
    } catch {
        Write-Host "  Warning: Failed to fetch detail for #$($TicketId). Using basic info." -ForegroundColor Yellow
        $FullTicket = $ticket
    }

    # Extract tags
    $Tags = @()
    if ($FullTicket.Tags) {
        $Tags = @($FullTicket.Tags)
    }

    # Extract description (strip HTML tags for plain text)
    $Description = $FullTicket.Body
    if ([string]::IsNullOrEmpty($Description)) {
        $Description = "No description provided."
    }

    # Fetch comments from the correct JitBit endpoint (/api/Comments, not /api/TicketComments)
    $Comments = @()
    try {
        $RawComments = Invoke-RestMethod -Uri "$TenantUrl/api/Comments?id=$TicketId" -Method Get -Headers $Headers
        foreach ($c in $RawComments) {
            # Skip pure system-generated noise (e.g. "ticket taken by", "new ticket submitted")
            if ($c.IsSystem -eq $true -and [string]::IsNullOrEmpty($c.Email)) { continue }
            $SenderName = if ($c.FirstName) { "$($c.FirstName) $($c.LastName)".Trim() } elseif ($c.UserName) { $c.UserName } elseif ($c.Email) { $c.Email } else { "Unknown" }
            $Comments += @{
                "sender" = $SenderName
                "email"  = if ($c.Email) { $c.Email } else { "" }
                "date"   = if ($c.CommentDate) { $c.CommentDate } else { "" }
                "body"   = if ($c.Body) { $c.Body } else { "" }
            }
        }
        Write-Host "  -> Loaded $($Comments.Count) comment(s)." -ForegroundColor DarkGreen
    } catch {
        Write-Host "  Warning: Could not fetch comments: $($_.Exception.Message)" -ForegroundColor Yellow
    }

    # Calculate staleness
    $CreatedDate = [DateTime]::Parse($ticket.IssueDate)
    $StaleDays = [Math]::Floor(((Get-Date) - $CreatedDate).TotalDays)
    $StaleAlert = ($StaleDays -gt 14) -and ($ticket.Status -ne "Closed")

    # Inferred Location — keyword match against configured LOCATIONS list
    $Location = "District/Other"
    $SubjectLower = $ticket.Subject.ToLower()
    $DescLower = $Description.ToLower()

    foreach ($loc in $LocationList) {
        if ($SubjectLower.Contains($loc.key.ToLower()) -or $DescLower.Contains($loc.key.ToLower())) {
            $Location = "$($loc.key) ($($loc.label))"
            break
        }
    }

    # Check if we already have this ticket in our database to preserve AI triage
    $ExistingMatch = $ExistingDatabase | Where-Object { $_.id -eq $TicketId }
    $AiTriage = $null

    if ($ExistingMatch) {
        $AiTriage = $ExistingMatch.ai_triage
        $AiTriage.stale_days = $StaleDays
        $AiTriage.stale_alert = $StaleAlert

        # Re-triage if new comments have arrived since last analysis
        $PrevCommentCount = if ($null -ne $AiTriage.last_triage_comment_count) { [int]$AiTriage.last_triage_comment_count } else { -1 }
        $CurrentCommentCount = $Comments.Count

        if ($CurrentCommentCount -ne $PrevCommentCount -and -not [string]::IsNullOrEmpty($OpenRouterApiKey) -and $OpenRouterApiKey -ne "YOUR_OPENROUTER_API_KEY_HERE") {
            Write-Host "  -> New comments detected ($PrevCommentCount -> $CurrentCommentCount). Re-triaging with AI..." -ForegroundColor Blue
            $SubmitterName = if ($ticket.FirstName) { "$($ticket.FirstName) $($ticket.LastName)".Trim() } else { $ticket.UserName }
            Start-Sleep -Seconds 10
            $AiResult = Invoke-AITriage -ApiKey $OpenRouterApiKey -Subject $ticket.Subject -Description $Description -SubmitterName $SubmitterName -Comments $Comments
            if ($AiResult) {
                $AiTriage.priority             = $AiResult.priority
                $AiTriage.justification        = $AiResult.justification
                $AiTriage.recommended_actions  = $AiResult.recommended_actions
                $AiTriage.draft_response       = $AiResult.draft_response
                $AiTriage.last_triage_comment_count = $CurrentCommentCount
                Write-Host "  -> AI re-triage complete (Priority: $($AiTriage.priority))" -ForegroundColor Green
            } else {
                Write-Host "  -> AI re-triage failed, keeping previous analysis." -ForegroundColor Yellow
            }
        } else {
            Write-Host "  -> Retained existing AI triage (Priority: $($AiTriage.priority))" -ForegroundColor DarkGreen
        }
    } else {
        # AI Triage for new tickets (with heuristic fallback)
        $SubmitterName = if ($ticket.FirstName) { "$($ticket.FirstName) $($ticket.LastName)".Trim() } else { "submitter" }
        $AiResult = $null

        if (-not [string]::IsNullOrEmpty($OpenRouterApiKey) -and $OpenRouterApiKey -ne "YOUR_OPENROUTER_API_KEY_HERE") {
            Write-Host "  -> New ticket! Calling AI triage (Gemma via OpenRouter)..." -ForegroundColor Blue
            Start-Sleep -Seconds 10
            $AiResult = Invoke-AITriage -ApiKey $OpenRouterApiKey -Subject $ticket.Subject -Description $Description -SubmitterName $SubmitterName -Comments $Comments
        }

        if ($AiResult) {
            Write-Host "  -> AI triage complete (Priority: $($AiResult.priority))" -ForegroundColor Green
            $Priority      = $AiResult.priority
            $Justification = $AiResult.justification
            $Actions       = $AiResult.recommended_actions
            $DraftResponse = $AiResult.draft_response
        } else {
            # Heuristic fallback when AI is unavailable or key not set
            Write-Host "  -> Falling back to heuristic triage..." -ForegroundColor Yellow
            $Priority      = "Medium"
            $Justification = "Automatically triaged during sync. This ticket is new to the dashboard."
            if ($SubjectLower.Contains("iep") -or $DescLower.Contains("iep") -or $SubjectLower.Contains("special ed") -or $DescLower.Contains("special ed")) {
                $Priority      = "Critical"
                $Justification = "High probability of special education / IEP accommodation dependency."
            } elseif ($SubjectLower.Contains("broken") -or $DescLower.Contains("cracked") -or $SubjectLower.Contains("not working")) {
                $Priority      = "High"
                $Justification = "Physical device failure affecting instructional time."
            } elseif ($ticket.Status -eq "Project") {
                $Priority      = "Low"
                $Justification = "Ticket is classified as a deferred project task."
            }
            $Actions       = @(
                "Review full ticket details in the dashboard.",
                "Physically inspect or contact $SubmitterName regarding: $($ticket.Subject)",
                "Resolve core issues and update the ticket status."
            )
            $DraftResponse = "Hi $SubmitterName,`n`nThank you for reaching out! I have received your ticket regarding '$($ticket.Subject)'. I am looking into this and will be by to assist you shortly.`n`nBest,`n$TechUserPrefix"
        }

        $AiTriage = @{
            "priority"                   = $Priority
            "justification"              = $Justification
            "location"                   = $Location
            "classroom"                  = "Room: TBD"
            "stale_days"                 = $StaleDays
            "stale_alert"                = $StaleAlert
            "recommended_actions"        = $Actions
            "draft_response"             = $DraftResponse
            "last_triage_comment_count"  = $Comments.Count
        }
    }

    # Add compiled ticket to list
    $ProcessedTickets += @{
        "id"           = $ticket.IssueID
        "subject"      = $ticket.Subject
        "status"       = $ticket.Status
        "priority"     = $ticket.Priority
        "category"     = if ($FullTicket.CategoryName) { $FullTicket.CategoryName } else { $ticket.Category }
        "from"         = if ($ticket.FirstName) { "$($ticket.FirstName) $($ticket.LastName)".Trim() } else { $ticket.UserName }
        "fromEmail"    = $ticket.Email
        "assigned"     = $ticket.Technician
        "created"      = $ticket.IssueDate
        "updated"      = $ticket.LastUpdated
        "tags"         = $Tags
        "description"  = $Description
        "conversation" = $Comments
        "ai_triage"    = $AiTriage
    }
}

# 6. Save JSON Database
$JsonOutput = (ConvertTo-Json @($ProcessedTickets) -Depth 100).TrimEnd()
Set-Content -Path $JsonDbFile -Value $JsonOutput -Encoding utf8
Write-Host "Updated triage_data.json successfully with $($ProcessedTickets.Count) tickets." -ForegroundColor Green

# 7. Write data to triage_data.js
$TriageJsFile = Join-Path $ScriptDir "triage_data.js"
try {
    Write-Host "Writing triage_data.js with live data..." -ForegroundColor Cyan
    $TechUserPrefix = $Username.Split('@')[0]
    $SyncTimestamp = (Get-Date).ToUniversalTime().ToString("yyyy-MM-ddTHH:mm:ssZ")
    $LocationsJs = if ($LocationList.Count -gt 0) {
        $entries = $LocationList | ForEach-Object { "{`"key`":`"$($_.key)`",`"label`":`"$($_.label)`"}" }
        "[" + ($entries -join ",") + "]"
    } else { "[]" }
    $JsContent = "const JITBIT_TENANT_URL = '$TenantUrl';`r`nconst TECHNICIAN_USERNAME = '$TechUserPrefix';`r`nconst LAST_SYNC = '$SyncTimestamp';`r`nconst LOCATIONS = $LocationsJs;`r`nconst TRIAGE_DATA = $JsonOutput;"
    Set-Content -Path $TriageJsFile -Value $JsContent -Encoding utf8
    Write-Host "triage_data.js updated successfully!" -ForegroundColor Green
} catch {
    Write-Host "Error: Failed to write triage_data.js: $_" -ForegroundColor Red
}

Write-Host "=========================================" -ForegroundColor Green
Write-Host "           SYNC COMPLETED!               " -ForegroundColor Green
Write-Host "=========================================" -ForegroundColor Green

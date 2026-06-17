# JitBit Cockpit: Create Desktop Shortcut
# This script converts logo.png into a Windows-compatible logo.ico file,
# then creates a quick-access shortcut on your Desktop with the custom logo.

$ErrorActionPreference = "Stop"

Write-Host "=========================================" -ForegroundColor Cyan
Write-Host "    JITBIT COCKPIT - DESKTOP SHORTCUT    " -ForegroundColor Cyan
Write-Host "=========================================" -ForegroundColor Cyan

$ScriptDir = Split-Path -Parent $MyInvocation.MyCommand.Definition
$PngPath = Join-Path $ScriptDir "logo.png"
$IcoPath = Join-Path $ScriptDir "logo.ico"
$HtmlPath = Join-Path $ScriptDir "dashboard.html"

# 1. Convert logo.png to logo.ico if it exists
if (Test-Path $PngPath) {
    Write-Host "Converting logo.png to logo.ico..." -ForegroundColor Gray
    try {
        # Load and resize logo.png to 256x256 to ensure Windows compatibility
        Add-Type -AssemblyName System.Drawing
        $OriginalBmp = [System.Drawing.Bitmap]::FromFile($PngPath)
        $ResizedBmp = New-Object System.Drawing.Bitmap(256, 256)
        $Graphics = [System.Drawing.Graphics]::FromImage($ResizedBmp)

        # Set high quality resize settings
        $Graphics.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
        $Graphics.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
        $Graphics.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
        $Graphics.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality

        $Graphics.DrawImage($OriginalBmp, 0, 0, 256, 256)

        $Ms = New-Object System.IO.MemoryStream
        $ResizedBmp.Save($Ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $PngBytes = $Ms.ToArray()

        $Ms.Dispose()
        $Graphics.Dispose()
        $ResizedBmp.Dispose()
        $OriginalBmp.Dispose()

        # 22-byte ICO header for a single 256x256 image
        $IcoHeader = [byte[]]@(
            0, 0,           # Reserved. Must always be 0.
            1, 0,           # Specifier: 1 for Icon (.ICO)
            1, 0,           # Number of images in the file (1)
            0,              # Width: 256 pixels (0 means 256)
            0,              # Height: 256 pixels (0 means 256)
            0,              # Color count (0 if >= 256 colors)
            0,              # Reserved
            1, 0,           # Color planes (1)
            32, 0,          # Bits per pixel (32)
            0, 0, 0, 0,     # Size of image data in bytes (will overwrite below)
            22, 0, 0, 0     # Offset of image data from beginning of file (22)
        )

        # Set size of image data in bytes (little-endian, 4 bytes at index 14)
        $PngSize = $PngBytes.Length
        $IcoHeader[14] = [byte]($PngSize -band 0xFF)
        $IcoHeader[15] = [byte](($PngSize -shr 8) -band 0xFF)
        $IcoHeader[16] = [byte](($PngSize -shr 16) -band 0xFF)
        $IcoHeader[17] = [byte](($PngSize -shr 24) -band 0xFF)

        # Combine Header and PNG Bytes
        $IcoBytes = New-Object byte[] ($IcoHeader.Length + $PngBytes.Length)
        [System.Buffer]::BlockCopy($IcoHeader, 0, $IcoBytes, 0, $IcoHeader.Length)
        [System.Buffer]::BlockCopy($PngBytes, 0, $IcoBytes, $IcoHeader.Length, $PngBytes.Length)

        # Write to logo.ico
        [System.IO.File]::WriteAllBytes($IcoPath, $IcoBytes)
        Write-Host "Successfully generated logo.ico" -ForegroundColor Green
    } catch {
        Write-Host "Warning: Failed to convert logo.png to logo.ico: $_" -ForegroundColor Yellow
        Write-Host "The shortcut will be created with the default browser icon." -ForegroundColor Yellow
    }
} else {
    Write-Host "Warning: logo.png not found at $PngPath." -ForegroundColor Yellow
    Write-Host "The shortcut will be created with the default browser icon." -ForegroundColor Yellow
}

# 2. Create the Desktop Shortcut
try {
    Write-Host "Creating Desktop shortcut..." -ForegroundColor Gray
    
    $WshShell = New-Object -ComObject WScript.Shell
    $DesktopPath = [System.Environment]::GetFolderPath("Desktop")
    $ShortcutPath = Join-Path $DesktopPath "JitBit Cockpit.lnk"
    
    $Shortcut = $WshShell.CreateShortcut($ShortcutPath)
    $Shortcut.TargetPath = "explorer.exe"
    $Shortcut.Arguments = "`"$HtmlPath`""
    $Shortcut.WorkingDirectory = $ScriptDir
    $Shortcut.Description = "JitBit Cockpit AI-Triage Dashboard"
    
    # If the icon was generated successfully, assign it
    if (Test-Path $IcoPath) {
        $Shortcut.IconLocation = "$IcoPath,0"
    }
    
    $Shortcut.Save()

    # Notify Windows Explorer of change to rebuild the icon cache immediately
    try {
        if (-not ([System.Management.Automation.PSTypeName]"Win32.Shell32").Type) {
            $Signature = @"
            [System.Runtime.InteropServices.DllImport("shell32.dll")]
            public static extern void SHChangeNotify(int wEventId, int uFlags, System.IntPtr dwItem1, System.IntPtr dwItem2);
"@
            Add-Type -MemberDefinition $Signature -Name "Shell32" -Namespace "Win32" -ErrorAction SilentlyContinue
        }
        [Win32.Shell32]::SHChangeNotify(0x08000000, 0x0000, [System.IntPtr]::Zero, [System.IntPtr]::Zero)
    } catch {
        # Fallback if Add-Type fails or is restricted
    }
    
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "  SHORTCUT CREATED ON YOUR DESKTOP!      " -ForegroundColor Green
    Write-Host "=========================================" -ForegroundColor Green
    Write-Host "Look for 'JitBit Cockpit' on your Desktop." -ForegroundColor Gray
} catch {
    Write-Host "Error: Failed to create shortcut: $_" -ForegroundColor Red
}

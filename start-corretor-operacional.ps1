param(
    [int]$CorretorPort = 8080,
    [int]$PwaPort = 8092
)

$ErrorActionPreference = "Stop"
$Root = Split-Path -Parent $MyInvocation.MyCommand.Path
$Python = "C:\Users\fabia\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe"

Set-Location $Root

foreach ($Port in @($CorretorPort, $PwaPort)) {
    $Lines = netstat -ano | Select-String ":$Port"
    foreach ($Line in $Lines) {
        $PidText = ($Line.ToString().Trim() -split "\s+")[-1]
        if ($PidText -match "^\d+$" -and [int]$PidText -ne 0) {
            Stop-Process -Id ([int]$PidText) -Force -ErrorAction SilentlyContinue
        }
    }
}

Start-Sleep -Seconds 1

Start-Process -WindowStyle Hidden -FilePath $Python -ArgumentList @("-u", "corretor_gabaritos.py", "$CorretorPort") -WorkingDirectory $Root
Start-Process -WindowStyle Hidden -FilePath $Python -ArgumentList @("-m", "http.server", "$PwaPort", "--directory", "corretor_pwa") -WorkingDirectory $Root

Start-Sleep -Seconds 2

$Ip = ((ipconfig | Select-String "IPv4" | Select-Object -First 1).ToString() -replace ".*:\s*", "").Trim()

Write-Host ""
Write-Host "Corretor local:" -ForegroundColor Green
Write-Host "  http://localhost:$CorretorPort/"
Write-Host "  http://$Ip`:$CorretorPort/"
Write-Host ""
Write-Host "PWA local:" -ForegroundColor Green
Write-Host "  http://localhost:$PwaPort/"
Write-Host "  http://$Ip`:$PwaPort/"
Write-Host ""
Write-Host "Se celular/tablet nao abrir pelo IP, rode liberar-firewall-corretor-admin.ps1 como Administradora ou use o PWA publicado em HTTPS."

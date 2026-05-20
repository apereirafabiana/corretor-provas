$ErrorActionPreference = "Stop"

Write-Host "Liberando acesso local ao corretor nas portas 8080 e 8092..." -ForegroundColor Cyan

netsh advfirewall firewall add rule name="Corretor Gabaritos 8080" dir=in action=allow protocol=TCP localport=8080 profile=any | Out-Host
netsh advfirewall firewall add rule name="Corretor Gabaritos PWA 8092" dir=in action=allow protocol=TCP localport=8092 profile=any | Out-Host

Write-Host ""
Write-Host "Pronto. Se o celular/tablet estiver na mesma rede e a rede nao bloquear isolamento entre dispositivos, acesse:" -ForegroundColor Green
$ips = Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object {
        $_.IPAddress -notlike "127.*" -and
        $_.IPAddress -notlike "169.254.*" -and
        $_.PrefixOrigin -ne "WellKnown"
    } |
    Select-Object -ExpandProperty IPAddress

foreach ($ip in $ips) {
    Write-Host "  http://$ip:8080/"
    Write-Host "  http://$ip:8092/"
}

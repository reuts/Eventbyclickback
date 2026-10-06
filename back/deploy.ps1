# deploy.ps1
# Deploy the image pushed by build_push.ps1 to the Lightsail host.
# Follows docs/data-migration.md: compose v2 only, never docker-compose (v1) or docker run.
#
#   .\deploy.ps1                  # deploys the $VERSION set in build_push.ps1
#   .\deploy.ps1 -Version 1.0.12  # deploy (or roll back to) a specific tag

param(
    [string]$Version,
    [string]$KeyPath = "C:\Users\babay\Downloads\LightsailDefaultKey-eu-west-1.pem",
    [string]$HostName = "ubuntu@34.247.244.34"
)

# Default to the version build_push.ps1 just pushed, so the two scripts stay in step
if (-not $Version) {
    $buildScript = Join-Path $PSScriptRoot "build_push.ps1"
    $match = Select-String -Path $buildScript -Pattern '^\$VERSION\s*=\s*"([^"]+)"' | Select-Object -First 1
    if (-not $match) {
        Write-Host "Could not read `$VERSION from build_push.ps1; pass -Version." -ForegroundColor Red
        exit 1
    }
    $Version = $match.Matches[0].Groups[1].Value
}

if ($Version -notmatch '^[0-9]+(\.[0-9]+)*$') {
    Write-Host "Version '$Version' is not a dotted number." -ForegroundColor Red
    exit 1
}

if (-not (Test-Path $KeyPath)) {
    Write-Host "SSH key not found: $KeyPath" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Deploying strapievent:$Version" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Host: $HostName" -ForegroundColor Yellow
Write-Host ""

# Runs on the server. `pull` comes before `up`: if the tag was rebuilt under the same
# number, `up` alone would keep the copy already on the host.
$remote = @'
set -e
VERSION="$1"
cd /home/ubuntu/strapi/back

PREVIOUS=$(grep -o 'strapievent:[0-9.]*' docker-compose.yml | head -1 | cut -d: -f2)
echo "Running now: $PREVIOUS  ->  deploying: $VERSION"

sudo sed -i "s|strapievent:[0-9.]*|strapievent:$VERSION|" docker-compose.yml
sudo docker compose pull
sudo docker compose up -d

echo "Waiting for /_health ..."
for i in $(seq 1 36); do
    CODE=$(curl -s -o /dev/null -w '%{http_code}' http://localhost:1337/_health || true)
    if [ "$CODE" = "204" ]; then
        echo "HEALTHY after $((i * 5))s"
        sudo docker ps --filter name=strapi-app --format '{{.Names}}  {{.Image}}  {{.Status}}'
        exit 0
    fi
    sleep 5
done

echo "NOT HEALTHY after 3 minutes (last code: $CODE). Last log lines:"
sudo docker logs --tail 60 strapi-app
echo ""
echo "Previous version was $PREVIOUS. To roll back:  .\\deploy.ps1 -Version $PREVIOUS"
echo "(only if this release did not change the schema - the old image may crash against it)"
exit 2
'@

# Ship the script as base64 so Windows quoting and CRLF line endings never reach bash
$bytes = [System.Text.Encoding]::UTF8.GetBytes($remote.Replace("`r`n", "`n"))
$encoded = [Convert]::ToBase64String($bytes)

ssh -i $KeyPath -o ConnectTimeout=20 $HostName "echo $encoded | base64 -d | bash -s -- $Version"
$code = $LASTEXITCODE

Write-Host ""
if ($code -eq 0) {
    Write-Host "=====================================" -ForegroundColor Green
    Write-Host "DEPLOY COMPLETED - strapievent:$Version is up" -ForegroundColor Green
    Write-Host "=====================================" -ForegroundColor Green
} else {
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host "DEPLOY FAILED (exit $code) - see output above" -ForegroundColor Red
    Write-Host "=====================================" -ForegroundColor Red
}
Write-Host ""
exit $code

# build-and-push.ps1
# Build and Push Docker Image to GHCR

# Configuration - UPDATE THESE VALUES
$GITHUB_USERNAME = "avi-adam"
$REPO_NAME = "strapievent"
$IMAGE_NAME = "ghcr.io/${GITHUB_USERNAME}/${REPO_NAME}"
$VERSION = "1.0.13"
$TIMESTAMP = Get-Date -Format "yyyyMMdd-HHmmss"

Write-Host ""
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Building Docker Image" -ForegroundColor Cyan
Write-Host "=====================================" -ForegroundColor Cyan
Write-Host "Image: ${IMAGE_NAME}:${VERSION}" -ForegroundColor Yellow
Write-Host ""

# Build with admin panel
docker build `
    --build-arg BUILD_ADMIN=true `
    --platform linux/amd64 `
    -t "${IMAGE_NAME}:${VERSION}" `
    -t "${IMAGE_NAME}:${TIMESTAMP}" `
    .

if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host "BUILD FAILED!" -ForegroundColor Red
    Write-Host "=====================================" -ForegroundColor Red
    Write-Host ""
    Write-Host "Please check the error messages above." -ForegroundColor Yellow
    Write-Host "Common issues:" -ForegroundColor Yellow
    Write-Host "  1. Docker Desktop is not running" -ForegroundColor Gray
    Write-Host "  2. Missing package.json or Dockerfile" -ForegroundColor Gray
    Write-Host "  3. Syntax errors in Dockerfile" -ForegroundColor Gray
    Write-Host ""
    exit 1
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Green
Write-Host "BUILD COMPLETED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Green
Write-Host ""

Write-Host "Pushing to GitHub Container Registry..." -ForegroundColor Cyan
Write-Host ""

# Push version tag
Write-Host "Pushing ${IMAGE_NAME}:${VERSION}..." -ForegroundColor Yellow
docker push "${IMAGE_NAME}:${VERSION}"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push failed for version tag!" -ForegroundColor Red
    exit 1
}

# Push timestamp tag
Write-Host "Pushing ${IMAGE_NAME}:${TIMESTAMP}..." -ForegroundColor Yellow
docker push "${IMAGE_NAME}:${TIMESTAMP}"
if ($LASTEXITCODE -ne 0) {
    Write-Host ""
    Write-Host "Push failed for timestamp tag!" -ForegroundColor Red
    exit 1
}

Write-Host ""
Write-Host "=====================================" -ForegroundColor Green
Write-Host "PUSH COMPLETED SUCCESSFULLY!" -ForegroundColor Green
Write-Host "=====================================" -ForegroundColor Green
Write-Host ""
Write-Host "Images pushed:" -ForegroundColor Cyan
Write-Host "  - ${IMAGE_NAME}:${VERSION}" -ForegroundColor Gray
Write-Host "  - ${IMAGE_NAME}:${TIMESTAMP}" -ForegroundColor Gray
Write-Host ""
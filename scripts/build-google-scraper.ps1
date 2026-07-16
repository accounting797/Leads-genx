$ErrorActionPreference = 'Stop'

$image = 'leads-genx/google-maps-scraper:1.16.3-local'
$sourceSetting = $env:GOOGLE_MAPS_SCRAPER_SOURCE
if ([string]::IsNullOrWhiteSpace($sourceSetting)) {
  $sourceSetting = Join-Path $HOME 'Downloads\New folder\google-maps-scraper'
}

$source = (Resolve-Path -LiteralPath $sourceSetting).Path
foreach ($required in @('go.mod', 'Dockerfile')) {
  if (-not (Test-Path -LiteralPath (Join-Path $source $required))) {
    throw "Invalid Google Maps scraper source: missing $required"
  }
}

$dirty = & git -C $source status --porcelain
if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect Google Maps scraper Git state.' }
if ($dirty) { throw 'Google Maps scraper source must be committed and clean before building.' }

$revision = (& git -C $source rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or -not $revision) { throw 'Unable to resolve scraper revision.' }

[string]$imageId = & docker image ls --quiet $image
$imageId = $imageId.Trim()
$imageFound = [bool]$imageId
$labelsJson = $null
if ($imageFound) {
  $labelsJson = & docker image inspect $image --format '{{json .Config.Labels}}'
}
$existingRevision = $null
if ($imageFound -and $labelsJson) {
  $labels = $labelsJson | ConvertFrom-Json
  $existingRevision = $labels.'leads-genx.scraper.revision'
}
if ($imageFound -and $existingRevision -eq $revision) {
  Write-Host "Scraper image already matches $revision"
  exit 0
}

& docker build --label "leads-genx.scraper.revision=$revision" --tag $image $source
if ($LASTEXITCODE -ne 0) { throw 'Google Maps scraper image build failed.' }

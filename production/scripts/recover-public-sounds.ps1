param([string]$StoryDir)
$ErrorActionPreference='Stop'
$storyPath=(Resolve-Path -LiteralPath $StoryDir).Path
$batch=Get-Content (Join-Path $storyPath 'music-download.json') -Raw|ConvertFrom-Json
$candidates=Get-Content (Join-Path $storyPath 'audio-candidates.json') -Raw|ConvertFrom-Json
$choices=@{opening=557811;tension=730222;climax=422274;creak=559469;footsteps=555116;whisper=680839;bell=578543;heartbeat=382025;scream=676314;wind=726317;fire=680476;sting=513330}
$music=@();$effects=@()
foreach($cue in $choices.Keys){
 $id=$choices[$cue]
 if($id -in $batch.exclude_ids){throw "Previously used sound $id"}
 if($id -eq 557811){$sound=[pscustomobject]@{id=$id;name='futuristic horror music.mp3';username='ZHRØ';license='https://creativecommons.org/publicdomain/zero/1.0/';url='https://freesound.org/people/ZHR%C3%98/sounds/557811/';duration=149.356;previews=@{'preview-hq-mp3'='https://cdn.freesound.org/previews/557/557811_10859468-lq.mp3'}}}
 else{$sound=@($candidates|ForEach-Object {$_.candidates}|Where-Object {$_.id -eq $id})[0]}
 if(-not $sound -or $sound.license -notmatch 'creativecommons.org/publicdomain/zero/1.0'){throw "Missing CC0 evidence $cue"}
 $isMusic=$cue -in @('opening','tension','climax')
 $name=if($isMusic){"music-$cue.mp3"}else{"sfx-$cue.mp3"}
 $file=Join-Path $storyPath "audio\$name"
 if(-not(Test-Path -LiteralPath $file)){
  $temp="$file.part"
  Invoke-WebRequest -Uri $sound.previews.'preview-hq-mp3' -OutFile $temp -TimeoutSec 45
  Move-Item -LiteralPath $temp -Destination $file
 }
 $record=[pscustomobject]@{cue=$cue;id=$id;name=$sound.name;creator=$sound.username;license=$sound.license;source=$sound.url;duration=$sound.duration;file=$file;downloaded_at=[DateTime]::UtcNow.ToString('o');sha256=(Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash.ToLowerInvariant()}
 $record|ConvertTo-Json|Set-Content -LiteralPath "$file.license.json" -Encoding utf8
 if($isMusic){$music+= $record}else{$effects+=$record}
 Write-Output "Recovered $cue $id"
}
$music|Sort-Object @{Expression={@('opening','tension','climax').IndexOf($_.cue)}}|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $storyPath 'audio\selected-music.json') -Encoding utf8
$effects|ConvertTo-Json -Depth 5|Set-Content -LiteralPath (Join-Path $storyPath 'audio\selected-sfx.json') -Encoding utf8

$Server = "vorstieg@100.85.95.46"
$RemoteDir = "~/felslager"
$LocalPath = "C:\Users\Robin\IdeaProjects\Felslager"

Write-Host "Downloading Felslager backend (excluding 'data' and 'node_modules') from $Server..." -ForegroundColor Cyan
Write-Host "You will be prompted for your password: W0rst!egS0ftware" -ForegroundColor Yellow

# Use tar over SSH to compress the files on the fly (excluding huge/unnecessary folders) 
# and extract them directly into the local directory.
ssh $Server "tar -czf - --exclude='data' --exclude='node_modules' --exclude='app.log' -C $RemoteDir ." | tar -xzf - -C $LocalPath

Write-Host "Download complete. Preparing Git commit..." -ForegroundColor Cyan

cd $LocalPath

# Create a standard .gitignore
if (!(Test-Path ".gitignore")) {
    Set-Content -Path ".gitignore" -Value "node_modules/`n.env`n.DS_Store`napp.log`ndata/"
    Write-Host "Created default .gitignore" -ForegroundColor Green
}

git add .
git commit -m "Initial commit of Node.js backend from server"

Write-Host "Pushing to GitHub..." -ForegroundColor Cyan
git push -u origin main

Write-Host "Done!" -ForegroundColor Green

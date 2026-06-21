\# MOQtail Browser Player



Browser-based Media over QUIC (MoQ) video player built on top of MOQtail.



\## Features



\- WebTransport subscriber

\- Media Source Extensions (MSE)

\- MP4 segment playback

\- Multiple quality tracks (480p / 720p / 1080p)

\- Runtime track switching

\- Buffer monitoring

\- Gap detection

\- QUIC-based media delivery



\## Architecture



Publisher

&#x20;   ↓

Relay

&#x20;   ↓

Browser Player

&#x20;   ↓

MediaSource

&#x20;   ↓

Video Element



\## Requirements



\- Ubuntu 22.04

\- Rust

\- Node.js

\- Google Chrome

\- mkcert



\## Installation



\### Clone repository



```bash

git clone ...

cd moqtail

```



\### Install mkcert



```bash

sudo apt install mkcert

mkcert -install

```



\### Generate certificates



```bash

mkcert \\

&#x20; -cert-file apps/relay/cert/cert.pem \\

&#x20; -key-file apps/relay/cert/key.pem \\

&#x20; localhost 127.0.0.1 <CLIENT IP ADDRESSES>

```



\## Running Relay



```bash

cargo run -p relay -- \\

&#x20; --port <PORT> \\

&#x20; --host <HOST IP> \\

&#x20; --cert-file apps/relay/cert/cert.pem \\

&#x20; --key-file apps/relay/cert/key.pem

```



\## Running Publisher



\### 480p



```bash

cargo run -p publisher -- ...

```



\### 720p



```bash

cargo run -p publisher -- ...

```



\### 1080p



```bash

cargo run -p publisher -- ...

```



\## Running Browser Player



```bash

cd moqtail-player

python -m http.server 8080

```



Open:



```text

http://localhost:8080

```



\## Connecting



\### Local VM



```text

192.168.56.103

```



\### Other computers



```text

10.28.97.151

```



\## Installing certificates on client machines



Export CA:



```bash

mkcert -CAROOT

```



Copy:



```text

rootCA.pem

```



to client PC.



Rename:



```text

rootCA.pem → rootCA.cer

```



Install into:



```text

Trusted Root Certification Authorities

```



\## Screenshots



\### Certificate generation



!\[Certificate generation](docs/images/cert-generation.jpg)



\### Successful connection



!\[Connected player](docs/images/player-connected.jpg)



\### Video playback



!\[Video playback](docs/images/player-playback.jpg)



\## Project Structure



```text

apps/

&#x20;├── relay

&#x20;├── publisher

&#x20;└── subscriber



moqtail-player/

&#x20;├── js/

&#x20;├── css/

&#x20;└── index.html

```






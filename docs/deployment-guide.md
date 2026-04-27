# Photonic Wallet — VPS Deployment Guide

## Overview

Photonic Wallet can be deployed as:
1. **Web App** — Static SPA served via nginx/Caddy (recommended for public access)
2. **Desktop App** — Tauri binary (for standalone distribution)
3. **CLI Tool** — `photonic-factory` for batch minting operations

This guide covers **web app deployment** on a VPS.

---

## Prerequisites

- **VPS**: Ubuntu 22.04+ (2 CPU, 4 GB RAM, 20 GB SSD minimum)
- **Docker** and **Docker Compose** installed
- **Domain name** pointed to your VPS IP (for HTTPS)
- **ElectrumX server** running and accessible (WebSocket endpoint)

---

## Quick Start (Docker)

```bash
# Clone and enter the repo
git clone https://github.com/AustinWilloughby/Photonic-Wallet.git
cd Photonic-Wallet

# Copy environment template
cp .env.example .env
# Edit .env with your settings

# Option A: Plain HTTP (port 3000, behind your own reverse proxy)
docker compose up -d photonic-wallet

# Option B: With Caddy auto-HTTPS (ports 80 + 443)
# First edit docker/Caddyfile — replace wallet.yourdomain.com with your domain
docker compose --profile with-caddy up -d
```

The wallet will be accessible at:
- **Option A**: `http://your-vps-ip:3000`
- **Option B**: `https://wallet.yourdomain.com`

---

## Manual Build (No Docker)

```bash
# Install pnpm
corepack enable && corepack prepare pnpm@latest --activate

# Install dependencies
pnpm install

# Build
pnpm build

# The built static files are in packages/app/dist/
# Serve with any static file server:
npx serve packages/app/dist -l 3000
```

---

## Architecture

```
┌─────────────────────────────────────────────┐
│                    VPS                       │
│                                             │
│  ┌─────────┐      ┌──────────────────┐      │
│  │  Caddy   │─────▶│  nginx (in Docker)│     │
│  │  :443    │      │  serves dist/    │      │
│  └─────────┘      └──────────────────┘      │
│                                             │
└─────────────────────────────────────────────┘
         │
         │ WebSocket (wss://)
         ▼
┌─────────────────────┐
│   ElectrumX Server  │
│   (external or      │
│    self-hosted)      │
└─────────────────────┘
```

The wallet is a **client-side SPA**. All blockchain operations happen in the browser via WebSocket connections to an ElectrumX server. The VPS only serves static files.

---

## ElectrumX Server Configuration

The wallet needs a WebSocket-enabled ElectrumX server. Options:

### Use a Public Server
The wallet ships with default server configurations. For testing, this is sufficient.

### Self-Host (Recommended for Production)
See the [RXinDexer](https://github.com/AustinWilloughby/RXinDexer) repository for a full ElectrumX setup with Glyph indexing support.

```bash
# Example: Run ElectrumX alongside the wallet
docker compose -f docker-compose.yml -f path/to/electrumx/docker-compose.yml up -d
```

---

## HTTPS Requirements

**HTTPS is required** for WebCrypto API functions (encryption, key derivation) when not on localhost. Options:

1. **Caddy** (included in docker-compose): Automatic Let's Encrypt certificates
2. **Cloudflare**: DNS proxy with automatic SSL
3. **Certbot**: Manual certificate management with nginx

---

## Security Checklist

- [ ] HTTPS enabled (required for crypto operations)
- [ ] Security headers configured (included in nginx.conf)
- [ ] ElectrumX connection uses WSS (not plain WS)
- [ ] Firewall allows only ports 80, 443
- [ ] Docker runs as non-root (configured in Dockerfile)
- [ ] Regular security updates on VPS OS

---

## Monitoring

```bash
# Check container health
docker compose ps

# View logs
docker compose logs -f photonic-wallet

# Check nginx access logs
docker compose exec photonic-wallet cat /var/log/nginx/access.log
```

---

## Updating

```bash
git pull
docker compose build --no-cache
docker compose up -d
```

---

## Hosted Swap RPC Proxy (Public Broadcast Offers)

"Public (Swap Index)" offers in the wallet require a Radiant Core node started
with `-swapindex=1` and a **CORS-enabled JSON-RPC endpoint** reachable from
the browser. Out of the box the wallet defaults to
`https://swap.radiantcore.org`; the recipe below is the reference setup.

### 1. Enable the swap index on `radiantd`

In the Radiant Core docker-compose service (e.g.
`docker/full-stack/docker-compose.yaml` → `radiantd.command`), add:

```
-swapindex=1
-rpcwhitelist=swapreader:getswapindexinfo,getopenorders,getopenordersbywant,getswaphistory,getswaphistorybywant,getswapcount,getswapcountbywant
```

The `rpcwhitelist` line restricts the `swapreader` user to read-only swap RPCs
so even if the proxy is abused it cannot touch wallets/mining/etc.

Generate the `swapreader` credentials with `share/rpcauth/rpcauth.py` (or reuse
the existing `rpcuser`/`rpcpassword`). Add the generated `rpcauth=` line next
to the other RPC args.

Restart the daemon and confirm:
```bash
docker exec radiantd radiant-cli -rpcuser=swapreader -rpcpassword=… getswapindexinfo
```

### 2. Add a Caddy site for the proxy

Point `swap.radiantcore.org` (or your own DNS name) at the VPS and add to
the `Caddyfile`:

```caddy
swap.radiantcore.org {
    encode gzip

    # CORS preflight
    @options method OPTIONS
    handle @options {
        header Access-Control-Allow-Origin "*"
        header Access-Control-Allow-Methods "POST, OPTIONS"
        header Access-Control-Allow-Headers "Content-Type, Authorization"
        header Access-Control-Max-Age "86400"
        respond 204
    }

    # JSON-RPC
    handle {
        header Access-Control-Allow-Origin "*"
        header Access-Control-Expose-Headers "Content-Type"

        # Inject Basic auth so browser clients never see the password
        request_header Authorization "Basic {$SWAP_RPC_BASIC_AUTH}"

        reverse_proxy radiantd:7332 {
            header_up Host {upstream_hostport}
        }
    }
}
```

Set `SWAP_RPC_BASIC_AUTH` in the Caddy container's environment to
`base64("swapreader:<password>")`, e.g.:

```bash
echo -n 'swapreader:YOUR_PASSWORD' | base64
```

### 3. Shared Docker network

Caddy and `radiantd` must share a Docker network so Caddy can resolve
`radiantd:7332`. Either:

- add Caddy to the `radiantd` compose network via `networks.external`, or
- add `radiantd` to Caddy's network, or
- put both in a named bridge network.

Example:
```yaml
# in photonic-wallet/docker-compose.yml
services:
  caddy:
    networks:
      - photonic
      - radiant
    environment:
      - SWAP_RPC_BASIC_AUTH=${SWAP_RPC_BASIC_AUTH}

networks:
  radiant:
    external: true
    name: rxindexer_default   # match the network the radiantd compose creates
```

### 4. Verify end-to-end

```bash
# From outside the VPS
curl -X POST https://swap.radiantcore.org \
  -H "Content-Type: application/json" \
  -d '{"jsonrpc":"2.0","id":1,"method":"getswapindexinfo","params":[]}'
# => {"result":{"enabled":true, ...}}

# CORS preflight
curl -i -X OPTIONS https://swap.radiantcore.org \
  -H "Origin: https://photonic-wallet.com" \
  -H "Access-Control-Request-Method: POST"
# => HTTP/2 204 with Access-Control-Allow-Origin: *
```

If both succeed, Photonic Wallet's "Public (Swap Index)" broadcast flow will
work against the default endpoint with no configuration from the user.

---

## V2 Hard Fork Support

Photonic Wallet fully supports the V2 hard fork (activation block 410,000):
- Per-algorithm dMint contract bytecodes (Blake3, K12, SHA256d)
- On-chain PoW validation via OP_BLAKE3/OP_K12
- Container tokens, authority tokens, WAVE naming
- Encrypted content with timelocked reveal

No additional configuration is needed for V2 features.

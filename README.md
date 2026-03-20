# Ignite

Ignite is a Docker-first local AI control panel built around `llama-swap`, `llama.cpp`, and `llmfit`.

It is designed for one clear path:
- detect hardware
- recommend models that fit
- download GGUFs
- generate runtime config
- test the model from one UI

## Stack

- `ignite`: React + FastAPI app on `:3000`
- `llama-runtime`: `llama-swap` + `llama-server`
- `llmfit`: hardware-aware model recommendations

## Requirements

- Docker
- Docker Compose
- NVIDIA GPU
- `nvidia-smi` working on the host
- NVIDIA Container Toolkit configured so `docker run --gpus all ...` works

## Quick Start

```bash
git clone <repo-url>
cd ignite
docker compose up -d --build
```

Open:

- `http://127.0.0.1:3000`

Stop:

```bash
docker compose down
```

## Default Folders

- `./models`
- `./config`

These are the default low-tech paths.

Advanced users can override them:

```bash
SWAPDECK_MODELS_DIR=/path/to/models SWAPDECK_CONFIG_DIR=/path/to/config docker compose up -d --build
```

## Pages

| Page | Purpose |
|------|---------|
| `Status` | Runtime health, logs, Docker GPU preflight |
| `Discover` | `llmfit` recommendations for the current machine |
| `Config` | Structured and raw YAML editing for `llama-swap` |
| `Models` | Download, inspect, delete, and add GGUFs to config |
| `Test` | Send prompts through the running runtime |
| `Settings` | Show runtime settings and Docker-managed paths |

## API

| Method | Endpoint | Purpose |
|--------|----------|---------|
| `GET` | `/api/status` | Runtime state, GPU stats, Docker preflight |
| `GET` | `/api/discover/recommendations` | `llmfit` recommendation proxy |
| `GET` | `/api/config` | Read runtime config |
| `PUT` | `/api/config` | Save runtime config |
| `GET` | `/api/config/raw` | Read raw YAML |
| `PUT` | `/api/config/raw` | Save raw YAML |
| `POST` | `/api/config/add-model` | Generate a model entry from a GGUF |
| `GET` | `/api/models` | List installed GGUF files |
| `POST` | `/api/models/download` | Start model download |
| `POST` | `/api/test` | Send a chat request through `llama-swap` |
| `GET` | `/health` | App health check |

## Security

- Ignite is for local or trusted-network use
- there is no built-in auth layer
- do not expose ports directly to the public internet
- use Tailscale or another private overlay if remote access is needed

## License

MIT

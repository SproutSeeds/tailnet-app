# @sproutseeds/tailnet-app

Reusable Tailscale Serve diagnostics and setup helpers for private local apps.

This package exists so SproutSeeds apps do not each reimplement the same
Tailscale detection, URL printing, health checks, Funnel checks, and named
service instructions.

## Install

```bash
npm install @sproutseeds/tailnet-app
```

For direct CLI use:

```bash
npm install -g @sproutseeds/tailnet-app
```

## Standard

- Apps bind to `127.0.0.1`.
- Apps expose `/healthz`.
- Tailscale Serve is tailnet-only by default.
- Tailscale Funnel is never enabled by default.
- Device URLs are the plug-and-play path.
- Named Tailscale Services are optional polish.

## CLI

```bash
tailnet-app doctor --app-name dumpy --port 7331 --service-name dumpy
tailnet-app serve-device --app-name dumpy --port 7331
tailnet-app service-instructions --app-name dumpy --port 7331 --service-name dumpy
```

The first-run user experience should not require a named service. If Tailscale
is installed and connected, the app can expose a private device URL such as:

```text
https://macbook-pro.example.ts.net:7331/
```

Named services provide clean URLs such as:

```text
https://dumpy.example.ts.net/
```

Those may require defining `svc:dumpy` in the Tailscale admin console.

## JSON Config

```json
{
  "appName": "trading-dashboard",
  "host": "127.0.0.1",
  "port": 8765,
  "healthPath": "/healthz",
  "serviceName": "trading-dashboard",
  "allowFunnel": false
}
```

Run:

```bash
tailnet-app doctor --config tailnet-app.config.json
```

## Library

```js
import { runTailnetDoctor, configureDeviceServe } from "@sproutseeds/tailnet-app";

const config = {
  appName: "dumpy",
  port: 7331,
  serviceName: "dumpy"
};

const doctor = await runTailnetDoctor(config);
if (!doctor.ok) {
  process.exitCode = 1;
}

await configureDeviceServe(config);
```

## Security Model

This package configures Tailscale Serve, not public Funnel. The doctor reports
public Funnel routes. By default, an unrelated Funnel route is a warning, while
a Funnel route pointing at the current app is a failure. Use `--strict-funnel`
to fail when any public Funnel route exists.

Named Services are host-side routing plus a Tailscale admin-console service
definition. The CLI prints the exact values needed:

- service name
- `svc:<name>` ID
- endpoint `tcp:443`
- expected URL
- host-side `tailscale serve --service=...` command

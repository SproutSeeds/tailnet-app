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
- Named Tailscale Services are the durable clean-URL path for multi-app hosts.

## CLI

```bash
tailnet-app doctor --app-name dumpy --port 7331 --service-name dumpy
tailnet-app ensure --app-name dumpy --port 7331 --auto-serve
tailnet-app supervise --config ops/tailnet-app/dumpy.json -- node server.mjs
tailnet-app serve-device --app-name dumpy --port 7331
tailnet-app service-instructions --app-name dumpy --port 7331 --service-name dumpy
```

For an app that already has a named Tailscale Service and should fail when that
service is not approved/routed:

```bash
tailnet-app ensure \
  --app-name trading-dashboard \
  --port 8765 \
  --service-name trading-dashboard \
  --service-socket ~/.clawdad/tailscale-live-host/tailscaled.sock \
  --official-url https://trading-dashboard.example.ts.net/ \
  --require-service \
  --auto-service
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
  "officialUrl": "https://trading-dashboard.example.ts.net/",
  "requireService": true,
  "requireDeviceServe": false,
  "autoService": true,
  "allowFunnel": false
}
```

Run:

```bash
tailnet-app doctor --config tailnet-app.config.json
```

## Library

```js
import { configureDeviceServe, runTailnetDoctor, runTailnetEnsure } from "@sproutseeds/tailnet-app";

const config = {
  appName: "dumpy",
  port: 7331,
  serviceName: "dumpy"
};

const doctor = await runTailnetDoctor(config);
if (!doctor.ok) {
  process.exitCode = 1;
}

const ensure = await runTailnetEnsure({
  ...config,
  autoServe: true,
  dependencies: [
    {
      name: "speech-backend",
      healthUrl: "http://100.64.0.10:8771/healthz",
      required: true,
      autoStart: true,
      startCommand: ["my-app", "speech-start"]
    }
  ]
});

await configureDeviceServe(config);
```

`ensure` is the startup orchestration layer. It checks the app, configures
private device Serve when `autoServe` is true, starts explicitly configured
dependencies, waits for their `/healthz`, and reports degraded readiness instead
of hiding backend failures behind a blank app.

`supervise` is the LaunchAgent/systemd entrypoint. It starts the service command,
waits for local health, runs `ensure`, writes optional readiness JSON, forwards
signals to the child, and exits when the child exits so the platform supervisor
can restart it.

Apps that use a durable Tailscale Service host satisfy the network gate through
the named service route. Set `autoService: true` to repair the host-side route
when approval already exists. Set `requireDeviceServe: true` only when the app
should also require a per-device Serve route.

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

import test from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  analyzeFunnel,
  deviceTailnetUrl,
  flattenServeRoutes,
  hasServiceHostApproval,
  normalizeConfig,
  parseJsonFromCommandOutput,
  runTailnetEnsure,
  runTailnetDoctor,
  runTailnetSupervise,
  serviceInstructions,
  serviceTailnetUrl
} from "../lib/index.mjs";

function jsonResponse(payload, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => "application/json" },
    json: async () => payload
  };
}

test("normalizes app config and defaults https port to app port", () => {
  const config = normalizeConfig({ appName: "dumpy", port: "7331" });

  assert.equal(config.appName, "dumpy");
  assert.equal(config.port, 7331);
  assert.equal(config.httpsPort, 7331);
  assert.equal(config.healthPath, "/healthz");
});

test("builds device and service URLs", () => {
  assert.equal(
    deviceTailnetUrl("codys-mac-studio-1.tail649edd.ts.net.", { port: 8765 }),
    "https://codys-mac-studio-1.tail649edd.ts.net:8765/"
  );
  assert.equal(
    serviceTailnetUrl("svc:trading-dashboard", "tail649edd.ts.net."),
    "https://trading-dashboard.tail649edd.ts.net/"
  );
});

test("parses JSON when tailscale emits warnings before JSON", () => {
  const payload = parseJsonFromCommandOutput('Warning: version drift\n{"BackendState":"Running"}\n');
  assert.deepEqual(payload, { BackendState: "Running" });
});

test("flattens node and service serve routes", () => {
  const routes = flattenServeRoutes({
    Web: {
      "device.tail.ts.net:8765": {
        Handlers: {
          "/": { Proxy: "http://127.0.0.1:8765" }
        }
      }
    },
    Services: {
      "svc:dumpy": {
        Web: {
          "dumpy.tail.ts.net:443": {
            Handlers: {
              "/": { Proxy: "http://127.0.0.1:7331" }
            }
          }
        }
      }
    }
  });

  assert.deepEqual(routes, [
    {
      serviceName: "",
      hostPort: "device.tail.ts.net:8765",
      path: "/",
      proxy: "http://127.0.0.1:8765"
    },
    {
      serviceName: "svc:dumpy",
      hostPort: "dumpy.tail.ts.net:443",
      path: "/",
      proxy: "http://127.0.0.1:7331"
    }
  ]);
});

test("funnel analysis warns on unrelated public routes by default", () => {
  const result = analyzeFunnel({
    serveStatus: {
      Web: {
        "device.tail.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:4322" }
          }
        }
      },
      AllowFunnel: {
        "device.tail.ts.net:443": true
      }
    },
    expectedProxy: "http://127.0.0.1:8765"
  });

  assert.equal(result.check.ok, true);
  assert.match(result.warnings[0], /unrelated public Funnel/);
});

test("funnel text default HTTPS route is normalized to port 443", () => {
  const result = analyzeFunnel({
    serveStatus: {
      Web: {
        "device.tail.ts.net:443": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:4322" }
          }
        }
      },
      AllowFunnel: {
        "device.tail.ts.net:443": true
      }
    },
    funnelText: "https://device.tail.ts.net (Funnel on)\n",
    expectedProxy: "http://127.0.0.1:8765"
  });

  assert.equal(result.warnings[0].match(/device\.tail\.ts\.net:443/gu).length, 1);
});

test("funnel analysis fails when this app is public", () => {
  const result = analyzeFunnel({
    serveStatus: {
      Web: {
        "device.tail.ts.net:8765": {
          Handlers: {
            "/": { Proxy: "http://127.0.0.1:8765" }
          }
        }
      },
      AllowFunnel: {
        "device.tail.ts.net:8765": true
      }
    },
    expectedProxy: "http://127.0.0.1:8765"
  });

  assert.equal(result.check.ok, false);
  assert.match(result.check.detail, /app route is public/);
});

test("service instructions include admin values and host command", () => {
  const instructions = serviceInstructions(
    {
      appName: "trading-dashboard",
      serviceName: "trading-dashboard",
      port: 8765,
      serviceSocket: "/tmp/tailscaled.sock"
    },
    { MagicDNSSuffix: "tail649edd.ts.net" }
  );

  assert.equal(instructions.serviceId, "svc:trading-dashboard");
  assert.equal(instructions.endpoint, "tcp:443");
  assert.equal(instructions.serviceUrl, "https://trading-dashboard.tail649edd.ts.net/");
  assert.match(instructions.hostCommand, /--socket=\/tmp\/tailscaled\.sock/);
  assert.match(instructions.hostCommand, /--service=svc:trading-dashboard/);
});

test("detects named service host approval from Tailscale capability map", () => {
  assert.equal(
    hasServiceHostApproval(
      {
        Self: {
          CapMap: {
            "service-host": [
              {
                "svc:trading-dashboard": ["100.64.0.1"]
              }
            ]
          }
        }
      },
      "svc:trading-dashboard"
    ),
    true
  );
});

test("doctor combines health, tailscale, serve, and funnel checks", async () => {
  const calls = [];
  const runner = async (command, args) => {
    calls.push([command, args]);
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");

    if (key === "status --json") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: {
            DNSName: "device.tail.test."
          },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve status --json") {
      return {
        stdout: JSON.stringify({
          Web: {
            "device.tail.test:8765": {
              Handlers: {
                "/": { Proxy: "http://127.0.0.1:8765" }
              }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "funnel status") {
      return { stdout: "https://device.tail.test:8765 (tailnet only)\n", stderr: "", code: 0 };
    }

    if (key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }

    throw new Error(`unexpected command: ${key}`);
  };

  const fetcher = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ ok: true, app: "trading-dashboard" })
  });

  const result = await runTailnetDoctor(
    { appName: "trading-dashboard", port: 8765, serviceName: "trading-dashboard" },
    { runner, fetch: fetcher }
  );

  assert.equal(result.ok, true);
  assert.equal(result.context.deviceUrl, "https://device.tail.test:8765/");
  assert.equal(result.context.serviceUrl, "https://trading-dashboard.tail.test/");
  assert.ok(calls.length >= 4);
});

test("ensure starts an unhealthy required dependency and waits for health", async () => {
  let dependencyStarted = false;
  const runner = async (_command, args) => {
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");

    if (key === "status --json") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: { DNSName: "device.tail.test." },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve status --json") {
      return {
        stdout: JSON.stringify({
          Web: {
            "device.tail.test:8765": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8765" } }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "funnel status" || key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }

    if (args[0] === "start-backend") {
      dependencyStarted = true;
      return { stdout: "started", stderr: "", code: 0 };
    }

    throw new Error(`unexpected command: ${key}`);
  };
  const fetcher = async (url) => {
    if (String(url).includes("backend.test")) {
      if (!dependencyStarted) {
        throw new Error("connection refused");
      }
      return jsonResponse({ ok: true, app: "backend" });
    }
    return jsonResponse({ ok: true, app: "trading-dashboard" });
  };

  const result = await runTailnetEnsure(
    {
      appName: "trading-dashboard",
      port: 8765,
      dependencies: [
        {
          name: "backend",
          healthUrl: "http://backend.test/healthz",
          startCommand: ["tailnet-helper", "start-backend"],
          timeoutMs: 50
        }
      ]
    },
    { runner, fetch: fetcher }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.degraded, false);
  assert.equal(result.dependencies[0].ok, true);
  assert.equal(result.dependencies[0].start.attempted, true);
});

test("ensure keeps the app ready but degraded for optional dependency failure", async () => {
  const runner = async (_command, args) => {
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");
    if (key === "status --json") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: { DNSName: "device.tail.test." },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }
    if (key === "serve status --json") {
      return {
        stdout: JSON.stringify({
          Web: {
            "device.tail.test:8765": {
              Handlers: { "/": { Proxy: "http://127.0.0.1:8765" } }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }
    if (key === "funnel status" || key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const fetcher = async (url) => {
    if (String(url).includes("optional.test")) {
      throw new Error("connection refused");
    }
    return jsonResponse({ ok: true });
  };

  const result = await runTailnetEnsure(
    {
      appName: "trading-dashboard",
      port: 8765,
      dependencies: [
        {
          name: "optional-backend",
          healthUrl: "http://optional.test/healthz",
          required: false
        }
      ]
    },
    { runner, fetch: fetcher }
  );

  assert.equal(result.ok, true);
  assert.equal(result.ready, true);
  assert.equal(result.degraded, true);
  assert.equal(result.failed[0].name, "optional-backend");
});

test("doctor can require named service approval and route", async () => {
  const runner = async (command, args) => {
    const socket = args.find((arg) => arg.startsWith("--socket=")) || "";
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");

    if (key === "status --json" && socket === "") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: {
            DNSName: "device.tail.test."
          },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "status --json" && socket) {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: {
            DNSName: "live-app-host.tail.test.",
            CapMap: {
              "service-host": [
                {
                  "svc:trading-dashboard": ["100.64.0.1"]
                }
              ]
            }
          },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve status --json" && socket === "") {
      return {
        stdout: JSON.stringify({
          Web: {
            "device.tail.test:8765": {
              Handlers: {
                "/": { Proxy: "http://127.0.0.1:8765" }
              }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve status --json" && socket) {
      return {
        stdout: JSON.stringify({
          Services: {
            "svc:trading-dashboard": {
              Web: {
                "trading-dashboard.tail.test:443": {
                  Handlers: {
                    "/": { Proxy: "http://127.0.0.1:8765" }
                  }
                }
              }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "funnel status") {
      return { stdout: "", stderr: "", code: 0 };
    }

    if (key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }

    throw new Error(`unexpected command: ${key}`);
  };

  const fetcher = async () => ({
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: async () => ({ ok: true })
  });

  const result = await runTailnetDoctor(
    {
      appName: "trading-dashboard",
      port: 8765,
      serviceName: "trading-dashboard",
      serviceSocket: "/tmp/tailscaled.sock",
      requireService: true
    },
    { runner, fetch: fetcher }
  );

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "named_service_approval").ok, true);
  assert.equal(result.checks.find((check) => check.name === "named_service_route").ok, true);
});

test("doctor accepts named service route without a device Serve route", async () => {
  const runner = async (_command, args) => {
    const socket = args.find((arg) => arg.startsWith("--socket=")) || "";
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");

    if (key === "status --json" && socket === "") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: { DNSName: "device.tail.test." },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "status --json" && socket) {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: {
            DNSName: "live-app-host.tail.test.",
            CapMap: {
              "service-host": [
                {
                  "svc:clawdad": ["100.64.0.1"]
                }
              ]
            }
          },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve status --json" && socket === "") {
      return { stdout: JSON.stringify({ Web: {} }), stderr: "", code: 0 };
    }

    if (key === "serve status --json" && socket) {
      return {
        stdout: JSON.stringify({
          Services: {
            "svc:clawdad": {
              Web: {
                "clawdad.tail.test:443": {
                  Handlers: {
                    "/": { Proxy: "http://127.0.0.1:4477" }
                  }
                }
              }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "funnel status" || key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }

    throw new Error(`unexpected command: ${key}`);
  };
  const fetcher = async () => jsonResponse({ ok: true });

  const result = await runTailnetDoctor(
    {
      appName: "clawdad",
      port: 4477,
      serviceName: "clawdad",
      serviceSocket: "/tmp/tailscaled.sock",
      requireService: true,
      officialUrl: "https://clawdad.tail.test/"
    },
    { runner, fetch: fetcher }
  );

  assert.equal(result.ok, true);
  assert.equal(result.checks.find((check) => check.name === "serve_device_route").ok, true);
  assert.match(result.checks.find((check) => check.name === "serve_device_route").detail, /optional device route/);
  assert.equal(result.checks.find((check) => check.name === "named_service_route").ok, true);
});

test("ensure configures a missing named service route when autoService is enabled", async () => {
  let serviceConfigured = false;
  const runner = async (_command, args) => {
    const socket = args.find((arg) => arg.startsWith("--socket=")) || "";
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");

    if (key === "status --json" && socket === "") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: { DNSName: "device.tail.test." },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "status --json" && socket) {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: {
            DNSName: "live-app-host.tail.test.",
            CapMap: {
              "service-host": [
                {
                  "svc:clawdad": ["100.64.0.1"]
                }
              ]
            }
          },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve status --json" && socket === "") {
      return { stdout: JSON.stringify({ Web: {} }), stderr: "", code: 0 };
    }

    if (key === "serve status --json" && socket) {
      return {
        stdout: JSON.stringify({
          Services: serviceConfigured
            ? {
                "svc:clawdad": {
                  Web: {
                    "clawdad.tail.test:443": {
                      Handlers: {
                        "/": { Proxy: "http://127.0.0.1:4477" }
                      }
                    }
                  }
                }
              }
            : {}
        }),
        stderr: "",
        code: 0
      };
    }

    if (key === "serve --yes --service=svc:clawdad --https=443 http://127.0.0.1:4477" && socket) {
      serviceConfigured = true;
      return { stdout: "configured", stderr: "", code: 0 };
    }

    if (key === "funnel status" || key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }

    throw new Error(`unexpected command: ${key}`);
  };
  const fetcher = async () => jsonResponse({ ok: true });

  const result = await runTailnetEnsure(
    {
      appName: "clawdad",
      port: 4477,
      serviceName: "clawdad",
      serviceSocket: "/tmp/tailscaled.sock",
      requireService: true,
      autoService: true,
      officialUrl: "https://clawdad.tail.test/"
    },
    { runner, fetch: fetcher }
  );

  assert.equal(result.ok, true);
  assert.equal(result.namedService.attempted, true);
  assert.equal(result.namedService.ok, true);
  assert.equal(result.checks.find((check) => check.name === "named_service_route").ok, true);
});

test("supervise writes readiness status and returns child exit code", async () => {
  const tempDir = await mkdtemp(join(tmpdir(), "tailnet-app-supervise-"));
  const statusFile = join(tempDir, "readiness.json");
  const child = new EventEmitter();
  child.killed = false;
  child.kill = () => {
    child.killed = true;
    child.emit("exit", 143, "SIGTERM");
    return true;
  };
  const spawner = (_command, _args) => {
    setTimeout(() => child.emit("exit", 0, null), 25);
    return child;
  };
  const runner = async (_command, args) => {
    const key = args.filter((arg) => !arg.startsWith("--socket=")).join(" ");
    if (key === "status --json") {
      return {
        stdout: JSON.stringify({
          BackendState: "Running",
          MagicDNSSuffix: "tail.test",
          Self: { DNSName: "device.tail.test." },
          User: {}
        }),
        stderr: "",
        code: 0
      };
    }
    if (key === "serve status --json") {
      return {
        stdout: JSON.stringify({
          Web: {
            "device.tail.test:8765": {
              Handlers: {
                "/": { Proxy: "http://127.0.0.1:8765" }
              }
            }
          }
        }),
        stderr: "",
        code: 0
      };
    }
    if (key === "funnel status" || key === "funnel status --json") {
      return { stdout: "{}", stderr: "", code: 0 };
    }
    throw new Error(`unexpected command: ${key}`);
  };
  const fetcher = async () => jsonResponse({ ok: true });

  try {
    const result = await runTailnetSupervise(
      {
        appName: "trading-dashboard",
        port: 8765,
        startupTimeoutMs: 250
      },
      {
        command: ["node", "server.js"],
        statusFile,
        runner,
        fetch: fetcher,
        spawn: spawner,
        stdio: "ignore"
      }
    );
    const status = JSON.parse(await readFile(statusFile, "utf8"));

    assert.equal(result.exitCode, 0);
    assert.equal(status.state, "stopped");
    assert.equal(status.ready, true);
    assert.equal(status.ok, true);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
});

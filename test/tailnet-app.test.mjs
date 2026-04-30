import test from "node:test";
import assert from "node:assert/strict";
import {
  analyzeFunnel,
  deviceTailnetUrl,
  flattenServeRoutes,
  hasServiceHostApproval,
  normalizeConfig,
  parseJsonFromCommandOutput,
  runTailnetDoctor,
  serviceInstructions,
  serviceTailnetUrl
} from "../lib/index.mjs";

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

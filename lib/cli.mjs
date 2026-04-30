import { readFile } from "node:fs/promises";
import {
  configureDeviceServe,
  configureNamedService,
  deviceTailnetUrl,
  getTailscaleStatus,
  localUrl,
  normalizeConfig,
  runTailnetDoctor,
  serviceInstructions,
  tailscaleDnsName,
  tailscaleLogin
} from "./index.mjs";

const HELP = `tailnet-app

Usage:
  tailnet-app status [options]
  tailnet-app doctor [options]
  tailnet-app serve-device [options]
  tailnet-app serve-service [options]
  tailnet-app service-instructions [options]

Options:
  --config <path>             Read JSON config
  --app-name <name>           App name for output
  --host <host>               Local app host (default: 127.0.0.1)
  --port <port>               Local app port
  --health-path <path>        Health path (default: /healthz)
  --https-port <port>         Tailscale device Serve HTTPS port (default: app port)
  --service-name <name>       Named Tailscale Service name
  --tailscale-bin <path>      Tailscale CLI path (default: tailscale)
  --socket <path>             Tailscale socket for device Serve/status
  --service-socket <path>     Tailscale socket for named service host
  --allow-funnel              Do not fail if this app is public through Funnel
  --strict-funnel             Fail if any public Funnel route exists on the node
  --json                      Emit JSON
  -h, --help                  Show help`;

export async function main(argv = []) {
  const command = argv[0] && !argv[0].startsWith("-") ? argv[0] : "doctor";
  const args = command === argv[0] ? argv.slice(1) : argv;

  if (command === "help" || args.includes("--help") || args.includes("-h")) {
    console.log(HELP);
    return;
  }

  const { config, json } = await parseConfig(args);

  switch (command) {
    case "status":
      await statusCommand(config, { json });
      return;
    case "doctor":
      await doctorCommand(config, { json });
      return;
    case "serve-device":
      await serveDeviceCommand(config, { json });
      return;
    case "serve-service":
      await serveServiceCommand(config, { json });
      return;
    case "service-instructions":
      await serviceInstructionsCommand(config, { json });
      return;
    default:
      throw new Error(`unknown command: ${command}\n\n${HELP}`);
  }
}

async function statusCommand(config, { json }) {
  const status = await getTailscaleStatus(config);
  const resolved = normalizeConfig(config);
  const payload = {
    appName: resolved.appName,
    localUrl: localUrl(resolved),
    login: tailscaleLogin(status),
    backendState: status?.BackendState || "",
    dnsName: tailscaleDnsName(status),
    tailnet: status?.MagicDNSSuffix || "",
    deviceUrl: deviceTailnetUrl(tailscaleDnsName(status), resolved)
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log(`${payload.appName} tailnet status`);
  console.log(`Local:     ${payload.localUrl}`);
  console.log(`Tailscale: ${payload.deviceUrl || "unavailable"}`);
  console.log(`State:     ${payload.backendState || "unknown"}`);
  console.log(`Login:     ${payload.login || "unknown"}`);
}

async function doctorCommand(config, { json }) {
  const result = await runTailnetDoctor(config);

  if (json) {
    console.log(JSON.stringify(result, null, 2));
  } else {
    printDoctor(result);
  }

  if (!result.ok) {
    process.exitCode = 1;
  }
}

async function serveDeviceCommand(config, { json }) {
  const resolved = normalizeConfig(config);
  const result = await configureDeviceServe(resolved);
  const status = await getTailscaleStatus(resolved);
  const payload = {
    ok: true,
    stdout: result.stdout,
    stderr: result.stderr,
    localUrl: localUrl(resolved),
    deviceUrl: deviceTailnetUrl(tailscaleDnsName(status), resolved)
  };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Tailnet device Serve configured.");
  console.log(`Local:     ${payload.localUrl}`);
  console.log(`Tailscale: ${payload.deviceUrl || "unavailable"}`);
}

async function serveServiceCommand(config, { json }) {
  const resolved = normalizeConfig(config);
  const result = await configureNamedService(resolved);
  let status = null;

  try {
    status = await getTailscaleStatus({ ...resolved, socket: resolved.serviceSocket || resolved.socket });
  } catch {
    status = null;
  }

  const instructions = serviceInstructions(resolved, status);
  const payload = { ok: true, stdout: result.stdout, stderr: result.stderr, instructions };

  if (json) {
    console.log(JSON.stringify(payload, null, 2));
    return;
  }

  console.log("Named service host route configured.");
  printServiceInstructions(instructions);
}

async function serviceInstructionsCommand(config, { json }) {
  const resolved = normalizeConfig(config);
  let status = null;

  try {
    status = await getTailscaleStatus(resolved);
  } catch {
    status = null;
  }

  const instructions = serviceInstructions(resolved, status);

  if (json) {
    console.log(JSON.stringify(instructions, null, 2));
    return;
  }

  printServiceInstructions(instructions);
}

async function parseConfig(args) {
  const cli = {};
  let configPath = "";
  let json = false;

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];

    switch (arg) {
      case "--config":
        configPath = requireValue(args, ++index, arg);
        break;
      case "--app-name":
        cli.appName = requireValue(args, ++index, arg);
        break;
      case "--host":
        cli.host = requireValue(args, ++index, arg);
        break;
      case "--port":
        cli.port = requireValue(args, ++index, arg);
        break;
      case "--health-path":
        cli.healthPath = requireValue(args, ++index, arg);
        break;
      case "--https-port":
        cli.httpsPort = requireValue(args, ++index, arg);
        break;
      case "--service-name":
        cli.serviceName = requireValue(args, ++index, arg);
        break;
      case "--tailscale-bin":
        cli.tailscaleBin = requireValue(args, ++index, arg);
        break;
      case "--socket":
        cli.socket = requireValue(args, ++index, arg);
        break;
      case "--service-socket":
        cli.serviceSocket = requireValue(args, ++index, arg);
        break;
      case "--allow-funnel":
        cli.allowFunnel = true;
        break;
      case "--strict-funnel":
        cli.strictFunnel = true;
        break;
      case "--json":
        json = true;
        break;
      default:
        throw new Error(`unknown option: ${arg}`);
    }
  }

  const fileConfig = configPath ? JSON.parse(await readFile(configPath, "utf8")) : {};
  return { config: normalizeConfig({ ...fileConfig, ...cli }), json };
}

function printDoctor(result) {
  console.log(`Tailnet app doctor: ${result.ok ? "OK" : "FAIL"}`);
  console.log(`Local:     ${result.context.localUrl}`);
  console.log(`Health:    ${result.context.localHealthUrl}`);
  if (result.context.deviceUrl) {
    console.log(`Tailscale: ${result.context.deviceUrl}`);
  }
  if (result.context.serviceUrl) {
    console.log(`Service:   ${result.context.serviceUrl}`);
  }

  for (const check of result.checks) {
    console.log(`- ${check.ok ? "PASS" : "FAIL"} ${check.name}: ${check.detail}`);
  }

  for (const warning of result.warnings) {
    console.log(`- WARN ${warning}`);
  }
}

function printServiceInstructions(instructions) {
  console.log(`Admin URL:    ${instructions.adminUrl}`);
  console.log(`Name:         ${instructions.serviceName}`);
  console.log(`Service ID:   ${instructions.serviceId}`);
  console.log(`Endpoint:     ${instructions.endpoint}`);
  console.log(`Expected URL: ${instructions.serviceUrl}`);
  console.log("");
  console.log("If the service is not already defined, open the admin URL, define the service,");
  console.log("then approve/allow the advertised host for tcp:443.");
  console.log("");
  console.log("Host command:");
  console.log(instructions.hostCommand);
}

function requireValue(args, index, flag) {
  const value = args[index];

  if (!value || value.startsWith("--")) {
    throw new Error(`${flag} requires a value`);
  }

  return value;
}

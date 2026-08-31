import type { LookupAddress } from "node:dns";
import { lookup as lookupDns } from "node:dns/promises";
import { request as requestHttps } from "node:https";
import { BlockList, isIP } from "node:net";

import {
  DirectApiBrokerError,
  OPENAI_RESPONSES_URL,
  type OpenAiTransport,
  type OpenAiTransportRequest,
  type OpenAiTransportResponse,
} from "./broker.js";

const blockedAddresses = new BlockList();
for (const [network, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv4");
}
for (const [network, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["fc00::", 7],
  ["fe80::", 10],
  ["ff00::", 8],
  ["2001:db8::", 32],
] as const) {
  blockedAddresses.addSubnet(network, prefix, "ipv6");
}

export function assertPublicProviderAddress(address: string): void {
  const family = isIP(address);
  if (
    family === 0 ||
    (family === 6 && address.toLowerCase().startsWith("::ffff:")) ||
    blockedAddresses.check(address, family === 4 ? "ipv4" : "ipv6")
  ) {
    throw new DirectApiBrokerError("destination_rejected", "Provider destination was rejected");
  }
}

function normalizeHeaders(
  headers: Readonly<Record<string, string | string[] | undefined>>,
): Record<string, string | undefined> {
  return Object.fromEntries(
    Object.entries(headers).map(([name, value]) => [
      name.toLowerCase(),
      Array.isArray(value) ? value[0] : value,
    ]),
  );
}

async function sendOpenAiRequest(
  request: OpenAiTransportRequest,
): Promise<OpenAiTransportResponse> {
  if (
    request.url !== OPENAI_RESPONSES_URL ||
    request.method !== "POST" ||
    request.redirectPolicy !== "reject" ||
    !request.tls.rejectUnauthorized ||
    request.tls.serverName !== "api.openai.com"
  ) {
    throw new DirectApiBrokerError("destination_rejected", "Provider destination was rejected");
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookupDns("api.openai.com", { all: true, verbatim: true });
    if (addresses.length === 0) throw new Error("No provider addresses");
    for (const { address } of addresses) assertPublicProviderAddress(address);
  } catch (error) {
    if (error instanceof DirectApiBrokerError) throw error;
    throw new DirectApiBrokerError("provider_unavailable", "Provider DNS resolution failed");
  }

  const selected = addresses[0];
  if (selected === undefined) {
    throw new DirectApiBrokerError("provider_unavailable", "Provider DNS resolution failed");
  }
  const body = JSON.stringify(request.body);

  return new Promise((resolve, reject) => {
    const outgoing = requestHttps(
      {
        agent: false,
        headers: {
          ...request.headers,
          "Content-Length": Buffer.byteLength(body, "utf8"),
          "Content-Type": "application/json",
        },
        hostname: "api.openai.com",
        lookup: (_hostname, _options, callback) => {
          callback(null, selected.address, selected.family);
        },
        method: "POST",
        minVersion: request.tls.minimumVersion,
        path: "/v1/responses",
        port: 443,
        protocol: "https:",
        rejectUnauthorized: true,
        servername: request.tls.serverName,
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        let length = 0;
        let responseRejected = false;
        incoming.on("data", (chunk: Buffer) => {
          length += chunk.length;
          if (length > 1_048_576) {
            responseRejected = true;
            reject(
              new DirectApiBrokerError(
                "provider_unavailable",
                "Provider response exceeded its bound",
              ),
            );
            incoming.destroy();
            return;
          }
          chunks.push(chunk);
        });
        incoming.on("error", () => {
          responseRejected = true;
          reject(new DirectApiBrokerError("provider_unavailable", "Provider profile test failed"));
        });
        incoming.on("end", () => {
          if (responseRejected) return;
          const statusCode = incoming.statusCode ?? 0;
          if (statusCode >= 300 && statusCode < 400) {
            reject(
              new DirectApiBrokerError("destination_rejected", "Provider redirect was rejected"),
            );
            return;
          }
          resolve({
            body: Buffer.concat(chunks).toString("utf8"),
            headers: normalizeHeaders(incoming.headers),
            statusCode,
          });
        });
      },
    );
    outgoing.setTimeout(request.timeoutMilliseconds, () => {
      outgoing.destroy(new Error("Provider profile test timed out"));
    });
    outgoing.on("error", () => {
      reject(new DirectApiBrokerError("provider_unavailable", "Provider profile test failed"));
    });
    outgoing.end(body);
  });
}

export function createOpenAiTransport(): OpenAiTransport {
  return { send: sendOpenAiRequest };
}

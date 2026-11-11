const endpoint = (process.env.CAMPAIGN_WORKER_URL ?? "").trim();
const secret = (process.env.CAMPAIGN_WORKER_SECRET ?? "").trim();

if (!endpoint || !secret || secret.length < 32) {
  console.error("Campaign worker URL or 32-character secret is missing.");
  process.exit(1);
}

let url;
try {
  url = new URL(endpoint);
} catch {
  console.error("Campaign worker URL is invalid.");
  process.exit(1);
}

if (url.protocol !== "https:" || url.hostname !== "bowchika-connect.onrender.com" || url.pathname !== "/api/campaign-worker") {
  console.error("Campaign worker URL is not the expected production HTTPS endpoint.");
  process.exit(1);
}

try {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${secret}`,
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(15 * 60 * 1000),
  });
  const bodyText = await response.text();
  let body;
  try {
    body = JSON.parse(bodyText);
  } catch {
    throw new Error(`Worker returned a non-JSON response (HTTP ${response.status}).`);
  }
  if (!response.ok || body?.ok !== true) {
    throw new Error(`Worker request failed (HTTP ${response.status}): ${String(body?.error ?? "unexpected response")}`);
  }
  console.log(JSON.stringify({
    ok: true,
    disabled: body.disabled === true,
    processed: Number(body.processed ?? 0),
    campaigns: Number(body.campaigns ?? 0),
  }));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Campaign worker request failed.");
  process.exit(1);
}

// api/ado.js — Vercel serverless proxy for Azure DevOps
// Runs server-side, so CORS is not an issue.

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-ado-auth");

  if (req.method === "OPTIONS") return res.status(200).end();

  const auth = req.headers["x-ado-auth"]; // base64 :PAT from client
  if (!auth) return res.status(400).json({ error: "Missing x-ado-auth header" });

  const targetPath = req.query.path;
  if (!targetPath) return res.status(400).json({ error: "Missing ?path= query param" });

  const targetUrl = `https://dev.azure.com${targetPath}`;

  try {
    const fetchRes = await fetch(targetUrl, {
      method: req.method === "GET" ? "GET" : "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": req.method === "POST" ? "application/json-patch+json" : "application/json",
        Accept: "application/json",
      },
      ...(req.method === "POST" ? { body: JSON.stringify(req.body) } : {}),
    });

    const data = await fetchRes.json();
    return res.status(fetchRes.status).json(data);
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}

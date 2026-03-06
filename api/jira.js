// api/jira.js — Vercel serverless proxy for Jira
// Runs server-side, so CORS is not an issue.

export default async function handler(req, res) {
  // Allow requests from your app
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-jira-base-url, x-jira-auth");

  if (req.method === "OPTIONS") return res.status(200).end();

  const baseUrl = req.headers["x-jira-base-url"];
  const auth    = req.headers["x-jira-auth"]; // already base64 from client

  if (!baseUrl || !auth) {
    return res.status(400).json({ error: "Missing x-jira-base-url or x-jira-auth headers" });
  }

  const clean = baseUrl.replace(/\/$/, "");

  // req.url is e.g. "/api/jira?path=/rest/api/3/issue/PROJ-1"
  const targetPath = req.query.path;
  if (!targetPath) return res.status(400).json({ error: "Missing ?path= query param" });

  const targetUrl = `${clean}${targetPath}`;

  try {
    const fetchRes = await fetch(targetUrl, {
      method: req.method === "GET" ? "GET" : "POST",
      headers: {
        Authorization: `Basic ${auth}`,
        "Content-Type": "application/json",
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

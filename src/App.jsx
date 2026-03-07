import { useState, useCallback } from "react";

const CLAUDE_MODEL = "claude-sonnet-4-20250514";

// ─── Azure DevOps (via /api/ado proxy) ───────────────────────────────────────
async function fetchADOWorkItem(org, project, pat, ticketId) {
  const auth = btoa(`:${pat}`);
  const path = `/${org}/${project}/_apis/wit/workitems/${ticketId}?$expand=all&api-version=7.1`;
  const res = await fetch(`/api/ado?path=${encodeURIComponent(path)}`, {
    headers: { "x-ado-auth": auth },
  });
  if (!res.ok) throw new Error(`Azure DevOps error: ${res.status} ${res.statusText}`);
  const item = await res.json();
  const f = item.fields;
  return {
    id: item.id, key: `#${item.id}`,
    title: f["System.Title"] || "",
    type: f["System.WorkItemType"] || "",
    description: f["System.Description"]?.replace(/<[^>]+>/g, "") || "",
    acceptanceCriteria: f["Microsoft.VSTS.Common.AcceptanceCriteria"]?.replace(/<[^>]+>/g, "") || "",
    priority: f["Microsoft.VSTS.Common.Priority"] ? `P${f["Microsoft.VSTS.Common.Priority"]}` : "",
    state: f["System.State"] || "",
  };
}

async function createADOTestCase(org, project, pat, title, steps) {
  const auth = btoa(`:${pat}`);
  const path = `/${org}/${project}/_apis/wit/workitems/$Test%20Case?api-version=7.1`;
  const stepsXml = `<steps id="0" last="${steps.length}">${steps.map((s, i) =>
    `<step id="${i + 1}" type="ValidateStep"><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${s.action}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><parameterizedString isformatted="true">&lt;DIV&gt;&lt;P&gt;${s.expected}&lt;/P&gt;&lt;/DIV&gt;</parameterizedString><description/></step>`
  ).join("")}</steps>`;
  const body = [
    { op: "add", path: "/fields/System.Title", value: title },
    { op: "add", path: "/fields/Microsoft.VSTS.TCM.Steps", value: stepsXml },
  ];
  const res = await fetch(`/api/ado?path=${encodeURIComponent(path)}`, {
    method: "POST",
    headers: { "x-ado-auth": auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`Failed to create ADO test case: ${res.status} ${res.statusText}`);
  return res.json();
}

// ─── Jira (via /api/jira proxy) ──────────────────────────────────────────────
async function fetchJiraIssue(baseUrl, email, token, issueKey) {
  const auth = btoa(`${email}:${token}`);
  const path = `/rest/api/3/issue/${issueKey}`;
  const res = await fetch(`/api/jira?path=${encodeURIComponent(path)}`, {
    headers: { "x-jira-base-url": baseUrl, "x-jira-auth": auth },
  });
  if (!res.ok) throw new Error(`Jira error: ${res.status} ${res.statusText}`);
  const item = await res.json();
  const f = item.fields;
  const adfToText = (node) => {
    if (!node) return "";
    if (node.type === "text") return node.text || "";
    if (node.content) return node.content.map(adfToText).join(" ");
    return "";
  };
  return {
    id: item.id, key: item.key,
    title: f.summary || "",
    type: f.issuetype?.name || "",
    description: adfToText(f.description),
    acceptanceCriteria: adfToText(f.customfield_10016) || "",
    priority: f.priority?.name || "",
    state: f.status?.name || "",
  };
}

async function createJiraTestCase(baseUrl, email, token, projectKey, title, steps) {
  const auth = btoa(`${email}:${token}`);
  const stepContent = steps.flatMap((s, i) => [
    { type: "paragraph", content: [{ type: "text", text: `Step ${i + 1}: `, marks: [{ type: "strong" }] }, { type: "text", text: s.action }] },
    { type: "paragraph", content: [{ type: "text", text: "Expected: ", marks: [{ type: "em" }] }, { type: "text", text: s.expected }] },
  ]);
  const body = {
    fields: {
      project: { key: projectKey },
      summary: title,
      issuetype: { name: "Test" },
      description: { type: "doc", version: 1, content: stepContent },
    },
  };
  let res = await fetch(`/api/jira?path=${encodeURIComponent("/rest/api/3/issue")}`, {
    method: "POST",
    headers: { "x-jira-base-url": baseUrl, "x-jira-auth": auth, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    body.fields.issuetype = { name: "Task" };
    body.fields.summary = `[Test Case] ${title}`;
    res = await fetch(`/api/jira?path=${encodeURIComponent("/rest/api/3/issue")}`, {
      method: "POST",
      headers: { "x-jira-base-url": baseUrl, "x-jira-auth": auth, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`Failed to create Jira issue: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

// ─── Claude AI ────────────────────────────────────────────────────────────────
async function generateTestCasesWithClaude(ticketInfo, extraContext, platformName) {
  const prompt = `You are a senior QA engineer. Generate comprehensive test cases for the following ${platformName} ticket.

TICKET:
Key: ${ticketInfo.key}
Title: ${ticketInfo.title}
Type: ${ticketInfo.type}
Description: ${ticketInfo.description || "No description provided"}
Acceptance Criteria: ${ticketInfo.acceptanceCriteria || "None specified"}
Priority: ${ticketInfo.priority || "Not set"}
Status: ${ticketInfo.state || "Unknown"}
${extraContext ? `\nADDITIONAL QA CONTEXT:\n${extraContext}` : ""}

Return a JSON array of test cases. Each must have:
- "title": string
- "type": "Positive" | "Negative" | "Edge Case" | "Regression"
- "preconditions": string
- "steps": [{"action": string, "expected": string}]
- "priority": "Critical" | "High" | "Medium" | "Low"

Return ONLY valid JSON. No markdown, no preamble.`;

const res = await fetch("/api/claude", {
  method: "POST",
  headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: CLAUDE_MODEL, max_tokens: 4000, messages: [{ role: "user", content: prompt }] }),
  });
  if (!res.ok) throw new Error(`Claude API error: ${res.status}`);
  const data = await res.json();
  const text = data.content.map((b) => b.text || "").join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ─── UI Components ────────────────────────────────────────────────────────────
const Badge = ({ label }) => {
  const colors = { Positive: "#22c55e", Negative: "#ef4444", "Edge Case": "#f59e0b", Regression: "#8b5cf6", Critical: "#ef4444", High: "#f97316", Medium: "#3b82f6", Low: "#6b7280" };
  return <span style={{ background: colors[label] || "#6b7280", color: "#fff", fontSize: "0.63rem", fontWeight: 700, padding: "2px 8px", borderRadius: 20, letterSpacing: "0.05em", textTransform: "uppercase" }}>{label}</span>;
};

const TestStep = ({ num, action, expected }) => (
  <div style={{ display: "flex", gap: 12, marginBottom: 8 }}>
    <div style={{ minWidth: 24, height: 24, borderRadius: "50%", background: "#1e3a5f", color: "#60a5fa", fontSize: "0.7rem", fontWeight: 700, display: "flex", alignItems: "center", justifyContent: "center", marginTop: 2 }}>{num}</div>
    <div style={{ flex: 1 }}>
      <div style={{ color: "#e2e8f0", fontSize: "0.81rem", marginBottom: 2 }}>{action}</div>
      <div style={{ color: "#60a5fa", fontSize: "0.77rem", background: "#0f2133", padding: "4px 8px", borderRadius: 4, borderLeft: "2px solid #3b82f6" }}>✓ {expected}</div>
    </div>
  </div>
);

const PlatformTab = ({ label, icon, active, onClick }) => (
  <button onClick={onClick} style={{
    flex: 1, padding: "11px 0", border: "none", cursor: "pointer", fontFamily: "inherit",
    fontSize: "0.83rem", fontWeight: 700, letterSpacing: "0.04em", borderRadius: 8,
    background: active ? "linear-gradient(135deg,#2563eb,#7c3aed)" : "#0a1628",
    color: active ? "#fff" : "#475569",
    outline: active ? "none" : "1px solid #1e3a5f",
  }}>{icon} {label}</button>
);

// ─── Main ─────────────────────────────────────────────────────────────────────
export default function App() {
  const [platform, setPlatform] = useState("ado");
  const [adoCfg, setAdoCfg] = useState({ org: "", project: "", pat: "" });
  const [jiraCfg, setJiraCfg] = useState({ baseUrl: "", email: "", token: "", projectKey: "" });
  const [ticketId, setTicketId] = useState("");
  const [ticketData, setTicketData] = useState(null);
  const [extraContext, setExtraContext] = useState("");
  const [fileText, setFileText] = useState("");
  const [testCases, setTestCases] = useState([]);
  const [loading, setLoading] = useState(false);
  const [pushingId, setPushingId] = useState(null);
  const [pushedIds, setPushedIds] = useState(new Set());
  const [error, setError] = useState("");
  const [appStep, setAppStep] = useState("config");
  const [fetching, setFetching] = useState(false);

  const reset = () => { setAppStep("config"); setTicketData(null); setTestCases([]); setError(""); setTicketId(""); setExtraContext(""); setFileText(""); setPushedIds(new Set()); };
  const handleFile = useCallback((e) => { const f = e.target.files[0]; if (!f) return; const r = new FileReader(); r.onload = (ev) => setFileText(ev.target.result); r.readAsText(f); }, []);

  const isConfigValid = platform === "ado"
    ? adoCfg.org && adoCfg.project && adoCfg.pat
    : jiraCfg.baseUrl && jiraCfg.email && jiraCfg.token && jiraCfg.projectKey;

  const handleFetch = async () => {
    setError(""); setFetching(true);
    try {
      const d = platform === "ado"
        ? await fetchADOWorkItem(adoCfg.org, adoCfg.project, adoCfg.pat, ticketId)
        : await fetchJiraIssue(jiraCfg.baseUrl, jiraCfg.email, jiraCfg.token, ticketId);
      setTicketData(d); setAppStep("generate");
    } catch (e) { setError(e.message); } finally { setFetching(false); }
  };

  const handleGenerate = async () => {
    setError(""); setLoading(true); setTestCases([]);
    try {
      const ctx = [extraContext, fileText].filter(Boolean).join("\n\n");
      const cases = await generateTestCasesWithClaude(ticketData, ctx, platform === "ado" ? "Azure DevOps" : "Jira");
      setTestCases(cases); setAppStep("results");
    } catch (e) { setError("Generation failed: " + e.message); } finally { setLoading(false); }
  };

  const handlePush = async (tc, idx) => {
    setPushingId(idx); setError("");
    try {
      if (platform === "ado") await createADOTestCase(adoCfg.org, adoCfg.project, adoCfg.pat, tc.title, tc.steps);
      else await createJiraTestCase(jiraCfg.baseUrl, jiraCfg.email, jiraCfg.token, jiraCfg.projectKey, tc.title, tc.steps);
      setPushedIds((p) => new Set([...p, idx]));
    } catch (e) { setError(e.message); } finally { setPushingId(null); }
  };

  const handlePushAll = async () => { for (let i = 0; i < testCases.length; i++) if (!pushedIds.has(i)) await handlePush(testCases[i], i); };

  const s = {
    app: { minHeight: "100vh", background: "#070f1a", fontFamily: "'IBM Plex Mono','Courier New',monospace", color: "#e2e8f0" },
    header: { background: "linear-gradient(135deg,#0a1628,#0f2133)", borderBottom: "1px solid #1e3a5f", padding: "18px 28px", display: "flex", alignItems: "center", gap: 14 },
    logo: { width: 38, height: 38, borderRadius: 9, background: "linear-gradient(135deg,#3b82f6,#8b5cf6)", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "1.1rem" },
    main: { maxWidth: 860, margin: "0 auto", padding: "26px 18px" },
    card: { background: "#0a1628", border: "1px solid #1e3a5f", borderRadius: 11, padding: 22, marginBottom: 18 },
    label: { fontSize: "0.69rem", color: "#60a5fa", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 5, display: "block" },
    input: { width: "100%", background: "#070f1a", border: "1px solid #1e3a5f", borderRadius: 7, padding: "9px 12px", color: "#e2e8f0", fontSize: "0.86rem", fontFamily: "inherit", outline: "none", boxSizing: "border-box" },
    textarea: { width: "100%", background: "#070f1a", border: "1px solid #1e3a5f", borderRadius: 7, padding: "9px 12px", color: "#e2e8f0", fontSize: "0.83rem", fontFamily: "inherit", outline: "none", resize: "vertical", boxSizing: "border-box" },
    btn: { background: "linear-gradient(135deg,#2563eb,#7c3aed)", color: "#fff", border: "none", borderRadius: 8, padding: "10px 20px", fontSize: "0.83rem", fontWeight: 700, cursor: "pointer", fontFamily: "inherit", letterSpacing: "0.04em" },
    btnSm: { background: "#1e3a5f", color: "#93c5fd", border: "1px solid #2563eb", borderRadius: 6, padding: "5px 12px", fontSize: "0.74rem", cursor: "pointer", fontFamily: "inherit" },
    btnDone: { background: "#14532d", color: "#86efac", border: "1px solid #22c55e", borderRadius: 6, padding: "5px 12px", fontSize: "0.74rem", fontFamily: "inherit" },
    error: { background: "#2d0a0a", border: "1px solid #7f1d1d", color: "#fca5a5", borderRadius: 8, padding: "11px 14px", fontSize: "0.81rem", marginBottom: 16 },
    sec: { fontSize: "0.73rem", color: "#60a5fa", letterSpacing: "0.12em", textTransform: "uppercase", marginBottom: 14, marginTop: 0 },
    grid2: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 },
    chip: { display: "inline-block", background: "#1e3a5f", color: "#93c5fd", fontSize: "0.69rem", padding: "3px 8px", borderRadius: 4, marginRight: 5, marginBottom: 3 },
    hint: { color: "#334155", fontSize: "0.69rem", marginTop: 5 },
  };

  const pName = platform === "ado" ? "Azure DevOps" : "Jira";

  return (
    <div style={s.app}>
      <link href="https://fonts.googleapis.com/css2?family=IBM+Plex+Mono:wght@400;700&display=swap" rel="stylesheet" />
      <div style={s.header}>
        <div style={s.logo}>🧪</div>
        <div>
          <p style={{ fontSize: "1rem", fontWeight: 700, color: "#f1f5f9", margin: 0 }}>QA Test Case Generator</p>
          <p style={{ fontSize: "0.66rem", color: "#60a5fa", margin: 0, letterSpacing: "0.1em", textTransform: "uppercase" }}>{pName} × Claude AI</p>
        </div>
        {appStep !== "config" && <button style={{ ...s.btnSm, marginLeft: "auto" }} onClick={reset}>← New Session</button>}
      </div>

      <div style={s.main}>
        {error && <div style={s.error}>⚠ {error}</div>}

        {appStep === "config" && (
          <div style={s.card}>
            <p style={{ ...s.hint, marginBottom: 10, marginTop: 0, fontSize: "0.68rem", letterSpacing: "0.1em", textTransform: "uppercase", color: "#475569" }}>Select Platform</p>
            <div style={{ display: "flex", gap: 10, marginBottom: 22 }}>
              <PlatformTab label="Azure DevOps" icon="⬡" active={platform === "ado"} onClick={() => setPlatform("ado")} />
              <PlatformTab label="Jira" icon="◈" active={platform === "jira"} onClick={() => setPlatform("jira")} />
            </div>

            {platform === "ado" && (
              <>
                <p style={s.sec}>Azure DevOps Connection</p>
                <div style={s.grid2}>
                  <div><label style={s.label}>Organization</label><input style={s.input} placeholder="e.g. mycompany" value={adoCfg.org} onChange={(e) => setAdoCfg({ ...adoCfg, org: e.target.value })} /></div>
                  <div><label style={s.label}>Project</label><input style={s.input} placeholder="e.g. MyProject" value={adoCfg.project} onChange={(e) => setAdoCfg({ ...adoCfg, project: e.target.value })} /></div>
                </div>
                <div style={{ marginTop: 13 }}>
                  <label style={s.label}>Personal Access Token</label>
                  <input style={s.input} type="password" placeholder="Your ADO PAT" value={adoCfg.pat} onChange={(e) => setAdoCfg({ ...adoCfg, pat: e.target.value })} />
                  <p style={s.hint}>Requires: Work Items (Read/Write) · Test Management (Read/Write)</p>
                </div>
              </>
            )}

            {platform === "jira" && (
              <>
                <p style={s.sec}>Jira Connection</p>
                <div style={s.grid2}>
                  <div><label style={s.label}>Jira Base URL</label><input style={s.input} placeholder="https://yourorg.atlassian.net" value={jiraCfg.baseUrl} onChange={(e) => setJiraCfg({ ...jiraCfg, baseUrl: e.target.value })} /></div>
                  <div><label style={s.label}>Project Key</label><input style={s.input} placeholder="e.g. PROJ" value={jiraCfg.projectKey} onChange={(e) => setJiraCfg({ ...jiraCfg, projectKey: e.target.value.toUpperCase() })} /></div>
                </div>
                <div style={{ ...s.grid2, marginTop: 12 }}>
                  <div><label style={s.label}>Email</label><input style={s.input} placeholder="you@company.com" value={jiraCfg.email} onChange={(e) => setJiraCfg({ ...jiraCfg, email: e.target.value })} /></div>
                  <div><label style={s.label}>API Token</label><input style={s.input} type="password" placeholder="Jira API token" value={jiraCfg.token} onChange={(e) => setJiraCfg({ ...jiraCfg, token: e.target.value })} /></div>
                </div>
                <p style={s.hint}>Generate token at: id.atlassian.com → Security → API tokens</p>
              </>
            )}

            <button style={{ ...s.btn, marginTop: 18 }} onClick={() => { setError(""); setAppStep("ticket"); }} disabled={!isConfigValid}>Connect →</button>
          </div>
        )}

        {appStep === "ticket" && (
          <div style={s.card}>
            <p style={s.sec}>{platform === "ado" ? "Load Work Item" : "Load Jira Issue"}</p>
            <div style={{ display: "flex", gap: 12, alignItems: "flex-end" }}>
              <div style={{ flex: 1 }}>
                <label style={s.label}>{platform === "ado" ? "Work Item ID" : "Issue Key"}</label>
                <input style={s.input} placeholder={platform === "ado" ? "e.g. 1234" : "e.g. PROJ-123"} value={ticketId} onChange={(e) => setTicketId(e.target.value)} onKeyDown={(e) => e.key === "Enter" && ticketId && handleFetch()} />
              </div>
              <button style={{ ...s.btn, whiteSpace: "nowrap" }} onClick={handleFetch} disabled={!ticketId || fetching}>{fetching ? "Fetching…" : "Fetch →"}</button>
            </div>
          </div>
        )}

        {appStep === "generate" && ticketData && (
          <>
            <div style={s.card}>
              <p style={s.sec}>Ticket Preview</p>
              <div style={{ marginBottom: 7 }}>
                <span style={s.chip}>{ticketData.key}</span>
                <span style={s.chip}>{ticketData.type}</span>
                <span style={s.chip}>{ticketData.state}</span>
                {ticketData.priority && <span style={s.chip}>{ticketData.priority}</span>}
              </div>
              <div style={{ fontWeight: 700, color: "#f1f5f9", fontSize: "0.93rem", marginBottom: 9 }}>{ticketData.title}</div>
              {ticketData.description && <div style={{ fontSize: "0.79rem", color: "#94a3b8", lineHeight: 1.6, marginBottom: 5 }}><span style={{ color: "#60a5fa" }}>Description: </span>{ticketData.description.slice(0, 300)}{ticketData.description.length > 300 ? "…" : ""}</div>}
              {ticketData.acceptanceCriteria && <div style={{ fontSize: "0.79rem", color: "#94a3b8", lineHeight: 1.6 }}><span style={{ color: "#60a5fa" }}>AC: </span>{ticketData.acceptanceCriteria.slice(0, 300)}{ticketData.acceptanceCriteria.length > 300 ? "…" : ""}</div>}
            </div>
            <div style={s.card}>
              <p style={s.sec}>Additional QA Context (Optional)</p>
              <div style={{ marginBottom: 13 }}>
                <label style={s.label}>Notes / Extra Requirements</label>
                <textarea style={{ ...s.textarea, minHeight: 82 }} placeholder="Add testing notes, edge cases, environment constraints…" value={extraContext} onChange={(e) => setExtraContext(e.target.value)} />
              </div>
              <div>
                <label style={s.label}>Upload Document (TXT, MD, CSV, JSON)</label>
                <input type="file" accept=".txt,.md,.csv,.json" onChange={handleFile} style={{ color: "#93c5fd", fontSize: "0.76rem" }} />
                {fileText && <p style={{ color: "#22c55e", fontSize: "0.71rem", marginTop: 5 }}>✓ Document loaded ({fileText.length} chars)</p>}
              </div>
              <button style={{ ...s.btn, marginTop: 16 }} onClick={handleGenerate} disabled={loading}>{loading ? "⚙ Generating with Claude…" : "✨ Generate Test Cases"}</button>
            </div>
          </>
        )}

        {appStep === "results" && testCases.length > 0 && (
          <>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16, flexWrap: "wrap", gap: 8 }}>
              <div>
                <p style={{ ...s.sec, marginBottom: 2 }}>Generated Test Cases</p>
                <p style={{ color: "#475569", fontSize: "0.71rem", margin: 0 }}>{testCases.length} cases · {ticketData?.key}: {ticketData?.title}</p>
              </div>
              <div style={{ display: "flex", gap: 9 }}>
                <button style={s.btnSm} onClick={() => setAppStep("generate")}>← Edit</button>
                <button style={s.btn} onClick={handlePushAll}>Push All to {pName} ↑</button>
              </div>
            </div>
            {testCases.map((tc, idx) => (
              <div key={idx} style={{ ...s.card, marginBottom: 12 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 9 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 6 }}><Badge label={tc.type} /><Badge label={tc.priority} /></div>
                    <div style={{ fontWeight: 700, color: "#f1f5f9", fontSize: "0.9rem" }}>{tc.title}</div>
                  </div>
                  <div style={{ marginLeft: 12 }}>
                    {pushedIds.has(idx) ? <span style={s.btnDone}>✓ Pushed</span> : <button style={s.btnSm} onClick={() => handlePush(tc, idx)} disabled={pushingId === idx}>{pushingId === idx ? "Pushing…" : `↑ Push to ${platform === "ado" ? "ADO" : "Jira"}`}</button>}
                  </div>
                </div>
                {tc.preconditions && <div style={{ fontSize: "0.75rem", color: "#64748b", marginBottom: 9, fontStyle: "italic" }}><span style={{ color: "#60a5fa" }}>Pre: </span>{tc.preconditions}</div>}
                {tc.steps.map((st, si) => <TestStep key={si} num={si + 1} action={st.action} expected={st.expected} />)}
              </div>
            ))}
          </>
        )}
      </div>
    </div>
  );
}

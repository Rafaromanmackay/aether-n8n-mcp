import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;

const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const N8N_WEBHOOK_BASE_URL = process.env.N8N_WEBHOOK_BASE_URL;

const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

const SERVER_NAME = "aether-n8n-mcp";
const SERVER_VERSION = "0.6.0";

const TOOL_NAMES = [
  "list_workflows",
  "get_workflow",
  "rename_workflow",
  "add_sticky_note",
  "update_workflow",
  "activate_workflow",
  "deactivate_workflow",
  "execute_workflow"
];

const WORKFLOW_REGISTRY = {
  sandbox_mcp_write_test: {
    key: "sandbox_mcp_write_test",
    id: "PUvD2zLvDp9kBNQt",
    name: "TEMP — MCP Write Test — Updated by Notion",
    environment: "sandbox",
    riskLevel: "low",
    executionMethod: "webhook",
    webhookPath: "/webhook/aether-mcp-sandbox-execute",
    allowedActions: ["read", "execute_workflow"],
    requiresApproval: false,
    notes:
      "Sandbox oficial para probar herramientas MCP antes de tocar workflows productivos."
  },
  workflow_001_lead_intelligence: {
    key: "workflow_001_lead_intelligence",
    id: null,
    name: "Workflow 001 — Lead Intelligence (RF Coaching)",
    environment: "production",
    riskLevel: "high",
    executionMethod: "blocked",
    webhookPath: null,
    allowedActions: ["read"],
    requiresApproval: true,
    notes:
      "Workflow productivo. Fuera de alcance para ejecución automática desde Notion AI."
  }
};

function requireEnv() {
  const missing = [];

  if (!N8N_API_URL) {
    missing.push("N8N_API_URL");
  }

  if (!N8N_API_KEY) {
    missing.push("N8N_API_KEY");
  }

  if (!MCP_AUTH_TOKEN) {
    missing.push("MCP_AUTH_TOKEN");
  }

  if (missing.length > 0) {
    throw new Error(`Missing required environment variables: ${missing.join(", ")}`);
  }
}

function requireWebhookEnv() {
  if (!N8N_WEBHOOK_BASE_URL) {
    throw new Error("Missing N8N_WEBHOOK_BASE_URL");
  }
}

function requireAuth(req, res, next) {
  if (!MCP_AUTH_TOKEN) {
    console.error("MCP_AUTH_TOKEN is not configured");

    return res.status(500).json({
      error: "MCP server auth is not configured"
    });
  }

  const authHeader = req.headers.authorization || "";
  const expectedHeader = `Bearer ${MCP_AUTH_TOKEN}`;

  if (authHeader !== expectedHeader) {
    return res.status(401).json({
      error: "Unauthorized"
    });
  }

  next();
}

function buildUrl(base, path) {
  const cleanBase = base.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;
  return `${cleanBase}${cleanPath}`;
}

function buildN8nUrl(path) {
  return buildUrl(N8N_API_URL, path);
}

function buildN8nWebhookUrl(path) {
  requireWebhookEnv();

  return buildUrl(N8N_WEBHOOK_BASE_URL, path);
}

async function parseResponseBody(response) {
  const text = await response.text();

  try {
    return text ? JSON.parse(text) : null;
  } catch {
    return { raw: text };
  }
}

async function n8nRequest(path, options = {}) {
  requireEnv();

  const url = buildN8nUrl(path);

  const response = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      "X-N8N-API-KEY": N8N_API_KEY,
      ...(options.headers || {})
    }
  });

  const data = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `n8n API error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

async function postJson(url, body, options = {}) {
  const response = await fetch(url, {
    method: "POST",
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    },
    body: JSON.stringify(body)
  });

  const data = await parseResponseBody(response);

  if (!response.ok) {
    throw new Error(
      `HTTP POST error ${response.status}: ${JSON.stringify(data)}`
    );
  }

  return data;
}

function nowIso() {
  return new Date().toISOString();
}

function createEventId(action) {
  return `exec_${Date.now()}_${action}`;
}

function formatResult(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

function resolveWorkflow({ workflowId, workflowKey }) {
  if (workflowKey) {
    return WORKFLOW_REGISTRY[workflowKey] || null;
  }

  if (workflowId) {
    return (
      Object.values(WORKFLOW_REGISTRY).find(
        (workflow) => workflow.id === workflowId
      ) || null
    );
  }

  return null;
}

function authorizeAction({ actor, action, workflow }) {
  if (!workflow) {
    return {
      decision: "denied",
      allowed: false,
      requiresApproval: false,
      riskLevel: "high",
      reason: "Workflow is not registered in WORKFLOW_REGISTRY."
    };
  }

  if (!workflow.allowedActions.includes(action)) {
    return {
      decision: "denied",
      allowed: false,
      requiresApproval: workflow.requiresApproval,
      riskLevel: workflow.riskLevel,
      reason: `Action ${action} is not allowed for workflow ${workflow.key}.`
    };
  }

  if (workflow.environment === "production") {
    return {
      decision: "requires_approval",
      allowed: false,
      requiresApproval: true,
      riskLevel: workflow.riskLevel,
      reason:
        "Production workflows require explicit manual approval before execution."
    };
  }

  if (workflow.environment !== "sandbox") {
    return {
      decision: "requires_approval",
      allowed: false,
      requiresApproval: true,
      riskLevel: workflow.riskLevel,
      reason: `Environment ${workflow.environment} requires approval.`
    };
  }

  if (actor !== "Notion AI") {
    return {
      decision: "requires_approval",
      allowed: false,
      requiresApproval: true,
      riskLevel: workflow.riskLevel,
      reason: `Actor ${actor} is not approved for automatic execution.`
    };
  }

  return {
    decision: "allowed",
    allowed: true,
    requiresApproval: false,
    riskLevel: workflow.riskLevel,
    reason: "Sandbox workflow execution is allowed for Notion AI."
  };
}

function createSimulationResult({
  eventId,
  actor,
  action,
  workflow,
  policy,
  input
}) {
  return {
    ok: false,
    mode: "simulation",
    executed: false,
    eventId,
    actor,
    action,
    requestedAt: nowIso(),
    policyDecision: policy.decision,
    reason: policy.reason,
    approvalRequired: policy.requiresApproval,
    riskLevel: policy.riskLevel,
    wouldExecute: {
      workflowKey: workflow?.key || input.workflowKey || null,
      workflowId: workflow?.id || input.workflowId || null,
      workflowName: workflow?.name || null,
      environment: workflow?.environment || "unknown",
      executionMethod: workflow?.executionMethod || "unknown",
      webhookPath: workflow?.webhookPath || null
    },
    notes:
      "Simulation Mode: no workflow was executed. This is a safe preview of the requested action."
  };
}

function createExecutionResult({
  eventId,
  actor,
  action,
  workflow,
  policy,
  startedAt,
  finishedAt,
  durationMs,
  status,
  result,
  error
}) {
  return {
    ok: status === "success",
    mode: "execution",
    executed: status === "success",
    eventId,
    actor,
    action,
    workflow: {
      key: workflow.key,
      id: workflow.id,
      name: workflow.name,
      environment: workflow.environment,
      riskLevel: workflow.riskLevel,
      executionMethod: workflow.executionMethod,
      webhookPath: workflow.webhookPath
    },
    policy: {
      decision: policy.decision,
      reason: policy.reason,
      approvalRequired: policy.requiresApproval,
      riskLevel: policy.riskLevel
    },
    timing: {
      startedAt,
      finishedAt,
      durationMs
    },
    status,
    result: result || null,
    error: error || null
  };
}

function publicStatus() {
  return {
    name: SERVER_NAME,
    status: "ok",
    version: SERVER_VERSION,
    mcpEndpoint: "/mcp",
    transport: "sse",
    auth: "bearer",
    tools: TOOL_NAMES,
    controlPlane: {
      policyEngine: true,
      workflowRegistry: true,
      simulationMode: true,
      executionResultStandard: true,
      automaticLedgerLogging: true,
      notionLedgerConfigured: LEDGER_CONFIGURED
    },
    workflowRegistry: Object.values(WORKFLOW_REGISTRY).map((workflow) => ({
      key: workflow.key,
      name: workflow.name,
      environment: workflow.environment,
      riskLevel: workflow.riskLevel,
      executionMethod: workflow.executionMethod,
      allowedActions: workflow.allowedActions,
      requiresApproval: workflow.requiresApproval
    })),
    sandbox: {
      workflowId: WORKFLOW_REGISTRY.sandbox_mcp_write_test.id,
      webhookPath: WORKFLOW_REGISTRY.sandbox_mcp_write_test.webhookPath,
      webhookBaseUrlConfigured: Boolean(N8N_WEBHOOK_BASE_URL)
    }
  };
}

// ─────────────────────────────────────────────────────────────
// AETHER MCP v0.6.0 — Notion Execution Ledger
// "La IA propone. AETHER autoriza. El sistema ejecuta. El ledger registra."
// ─────────────────────────────────────────────────────────────

const NOTION_API_KEY = process.env.NOTION_API_KEY || "";
const NOTION_VERSION = process.env.NOTION_VERSION || "2025-09-03";
const LEDGER_DATA_SOURCE_ID = process.env.NOTION_EXECUTION_LEDGER_DATA_SOURCE_ID || "";
const LEDGER_DATABASE_ID = process.env.NOTION_EXECUTION_LEDGER_DATABASE_ID || "";
const LEDGER_TIMEOUT_MS = Number(process.env.NOTION_TIMEOUT_MS || 8000);

const LEDGER_CONFIGURED = Boolean(
  NOTION_API_KEY && (LEDGER_DATA_SOURCE_ID || LEDGER_DATABASE_ID)
);

const MAX_TEXT = 1900; // Notion rich_text corta en 2000

function truncate(value) {
  if (value === undefined || value === null) return "";
  const str = typeof value === "string" ? value : JSON.stringify(value);
  return str.length > MAX_TEXT ? str.slice(0, MAX_TEXT - 3) + "..." : str;
}

function richText(value) {
  const content = truncate(value);
  if (!content) return { rich_text: [] };
  return { rich_text: [{ type: "text", text: { content } }] };
}

function selectValue(name) {
  return name ? { select: { name: String(name) } } : { select: null };
}

// notionRequest(): nunca lanza. Siempre devuelve { ok, status, data, error }.
async function notionRequest(method, path, body) {
  if (!NOTION_API_KEY) {
    return { ok: false, status: 0, error: "NOTION_API_KEY not configured" };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), LEDGER_TIMEOUT_MS);

  try {
    const res = await fetch("https://api.notion.com/v1" + path, {
      method,
      headers: {
        Authorization: `Bearer ${NOTION_API_KEY}`,
        "Notion-Version": NOTION_VERSION,
        "Content-Type": "application/json"
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal
    });

    const text = await res.text();
    let data = null;
    try { data = text ? JSON.parse(text) : null; } catch { data = { raw: text }; }

    if (!res.ok) {
      return {
        ok: false,
        status: res.status,
        error: (data && (data.message || data.code)) || `HTTP ${res.status}`,
        data
      };
    }
    return { ok: true, status: res.status, data };
  } catch (err) {
    const aborted = err && err.name === "AbortError";
    return {
      ok: false,
      status: 0,
      error: aborted ? `Notion timeout after ${LEDGER_TIMEOUT_MS}ms` : String(err && err.message || err)
    };
  } finally {
    clearTimeout(timer);
  }
}

// Mapea un evento AETHER al schema exacto del Execution Ledger.
function buildLedgerProperties(event) {
  const props = {
    "Event": { title: [{ type: "text", text: { content: truncate(event.title || "Untitled event") } }] },
    "Timestamp": { date: { start: event.timestamp || new Date().toISOString() } },
    "Actor": selectValue(event.actor || "AETHER MCP"),
    "Action": selectValue(event.action || "execute_workflow"),
    "Resource Name": richText(event.resourceName),
    "Resource ID": richText(event.resourceId),
    "Environment": selectValue(event.environment || "sandbox"),
    "Policy Decision": selectValue(event.policyDecision),
    "Approval": selectValue(event.approval || "not_required"),
    "Status": { status: { name: event.status || "requested" } },
    "Risk Level": selectValue(event.riskLevel || "low"),
    "Input Payload": richText(event.inputPayload),
    "Output Payload": richText(event.outputPayload),
    "Error": richText(event.error),
    "Notes": richText(event.notes)
  };

  if (typeof event.durationMs === "number" && !Number.isNaN(event.durationMs)) {
    props["Duration ms"] = { number: Math.round(event.durationMs) };
  }

  return props;
}

function ledgerParent() {
  // API 2025-09-03 usa data_source_id. Fallback a database_id para versiones antiguas.
  if (LEDGER_DATA_SOURCE_ID) {
    return { type: "data_source_id", data_source_id: LEDGER_DATA_SOURCE_ID };
  }
  return { type: "database_id", database_id: LEDGER_DATABASE_ID };
}

// createNotionLedgerPage(): crea la fila inicial del evento.
async function createNotionLedgerPage(event) {
  if (!LEDGER_CONFIGURED) {
    return { logged: false, error: "ledger not configured" };
  }

  const res = await notionRequest("POST", "/pages", {
    parent: ledgerParent(),
    properties: buildLedgerProperties(event)
  });

  if (!res.ok) {
    console.error("[aether:ledger] create failed:", res.status, res.error);
    return { logged: false, error: res.error };
  }

  return {
    logged: true,
    ledgerEventId: res.data.id,
    notionPageUrl: res.data.url
  };
}

// updateNotionLedgerPage(): cierra el evento con el resultado real.
async function updateNotionLedgerPage(pageId, event) {
  if (!LEDGER_CONFIGURED || !pageId) {
    return { logged: false, error: "ledger not configured or missing pageId" };
  }

  const res = await notionRequest("PATCH", `/pages/${pageId}`, {
    properties: buildLedgerProperties(event)
  });

  if (!res.ok) {
    console.error("[aether:ledger] update failed:", res.status, res.error);
    return { logged: false, error: res.error };
  }

  return { logged: true, ledgerEventId: res.data.id, notionPageUrl: res.data.url };
}

// logExecutionEvent(): API única para el resto del MCP.
// Crea si no hay ledgerEventId, actualiza si lo hay. Nunca lanza.
async function logExecutionEvent(event, existingPageId) {
  try {
    return existingPageId
      ? await updateNotionLedgerPage(existingPageId, event)
      : await createNotionLedgerPage(event);
  } catch (err) {
    console.error("[aether:ledger] unexpected:", err);
    return { logged: false, error: String(err && err.message || err) };
  }
}

function createServer() {
  const server = new McpServer({
    name: SERVER_NAME,
    version: SERVER_VERSION
  });

  server.tool(
    "list_workflows",
    "List n8n workflows from the connected n8n instance.",
    {
      limit: z
        .number()
        .int()
        .positive()
        .max(200)
        .optional()
        .describe("Maximum number of workflows to return.")
    },
    async ({ limit = 50 }) => {
      const result = await n8nRequest(`/workflows?limit=${limit}`);

      return formatResult(result);
    }
  );

  server.tool(
    "get_workflow",
    "Get a full n8n workflow by ID.",
    {
      workflowId: z.string().describe("The n8n workflow ID.")
    },
    async ({ workflowId }) => {
      const result = await n8nRequest(`/workflows/${workflowId}`);

      return formatResult(result);
    }
  );

  server.tool(
    "rename_workflow",
    "Rename an existing n8n workflow by ID. This safely fetches the existing workflow and only changes the name.",
    {
      workflowId: z.string().describe("The n8n workflow ID."),
      name: z.string().describe("The new workflow name.")
    },
    async ({ workflowId, name }) => {
      const existing = await n8nRequest(`/workflows/${workflowId}`);

      const payload = {
        name,
        nodes: existing.nodes || [],
        connections: existing.connections || {},
        settings: {}
      };

      const result = await n8nRequest(`/workflows/${workflowId}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      return formatResult(result);
    }
  );

  server.tool(
    "add_sticky_note",
    "Add a sticky note node to an existing n8n workflow without changing workflow logic.",
    {
      workflowId: z.string().describe("The n8n workflow ID."),
      content: z.string().describe("The sticky note content."),
      x: z.number().optional().describe("X position on the canvas."),
      y: z.number().optional().describe("Y position on the canvas.")
    },
    async ({ workflowId, content, x = 0, y = 0 }) => {
      const existing = await n8nRequest(`/workflows/${workflowId}`);

      const stickyNode = {
        parameters: {
          content
        },
        id: crypto.randomUUID(),
        name: `Sticky Note ${Date.now()}`,
        type: "n8n-nodes-base.stickyNote",
        typeVersion: 1,
        position: [x, y]
      };

      const payload = {
        name: existing.name,
        nodes: [...(existing.nodes || []), stickyNode],
        connections: existing.connections || {},
        settings: {}
      };

      const result = await n8nRequest(`/workflows/${workflowId}`, {
        method: "PUT",
        body: JSON.stringify(payload)
      });

      return formatResult(result);
    }
  );

  server.tool(
    "update_workflow",
    "Update an existing n8n workflow. Use carefully and only with a full workflow payload.",
    {
      workflowId: z.string().describe("The n8n workflow ID."),
      workflow: z.record(z.any()).describe("The full updated workflow payload.")
    },
    async ({ workflowId, workflow }) => {
      const result = await n8nRequest(`/workflows/${workflowId}`, {
        method: "PUT",
        body: JSON.stringify(workflow)
      });

      return formatResult(result);
    }
  );

  server.tool(
    "activate_workflow",
    "Activate an n8n workflow by ID.",
    {
      workflowId: z.string().describe("The n8n workflow ID.")
    },
    async ({ workflowId }) => {
      const result = await n8nRequest(`/workflows/${workflowId}/activate`, {
        method: "POST"
      });

      return formatResult(result);
    }
  );

  server.tool(
    "deactivate_workflow",
    "Deactivate an n8n workflow by ID.",
    {
      workflowId: z.string().describe("The n8n workflow ID.")
    },
    async ({ workflowId }) => {
      const result = await n8nRequest(`/workflows/${workflowId}/deactivate`, {
        method: "POST"
      });

      return formatResult(result);
    }
  );

  server.tool(
    "execute_workflow",
    "Execute a registered n8n workflow through AETHER Control Plane. Supports Simulation Mode for blocked or unapproved actions.",
    {
      workflowId: z
        .string()
        .optional()
        .describe("The n8n workflow ID. Prefer workflowKey when possible."),
      workflowKey: z
        .string()
        .optional()
        .describe("The registered workflow key, e.g. sandbox_mcp_write_test."),
      actor: z
        .string()
        .optional()
        .describe("The actor requesting execution. Defaults to Notion AI."),
      simulate: z
        .boolean()
        .optional()
        .describe("If true, returns Simulation Mode without executing.")
    },
    async ({
      workflowId,
      workflowKey = "sandbox_mcp_write_test",
      actor = "Notion AI",
      simulate = false
    }) => {
      const action = "execute_workflow";
      const eventId = createEventId(action);
      const requestedAt = nowIso();

      const workflow = resolveWorkflow({ workflowId, workflowKey });
      const policy = authorizeAction({ actor, action, workflow });

      // ── Simulación o bloqueo por policy (lógica v0.5 intacta) ──
      if (simulate || !policy.allowed) {
        const simResult = createSimulationResult({
          eventId,
          actor,
          action,
          workflow,
          policy,
          input: { workflowId, workflowKey }
        });

        const status = policy.decision === "allowed" ? "simulated" : "blocked";

        const log = await logExecutionEvent({
          title: `${eventId} — ${workflow?.key || workflowKey || workflowId || "unknown"} — ${status}`,
          timestamp: requestedAt,
          actor,
          action: simulate ? "simulate_action" : "execute_workflow",
          resourceName: workflow?.name || workflowKey || workflowId,
          resourceId: workflow?.id || workflowId || null,
          environment: workflow?.environment || "unknown",
          policyDecision: policy.decision,
          approval: policy.requiresApproval ? "manual_required" : "not_required",
          status,
          riskLevel: policy.riskLevel,
          inputPayload: { workflowId, workflowKey, simulate },
          outputPayload: simResult,
          notes: policy.reason
        });

        return formatResult({ ...simResult, ledger: log });
      }

      // ── Método de ejecución no soportado (lógica v0.5 intacta) ──
      if (workflow.executionMethod !== "webhook") {
        const blockedPolicy = {
          ...policy,
          decision: "denied",
          allowed: false,
          requiresApproval: true,
          reason: `Execution method ${workflow.executionMethod} is not executable by this tool.`
        };

        const simResult = createSimulationResult({
          eventId,
          actor,
          action,
          workflow,
          policy: blockedPolicy,
          input: { workflowId, workflowKey }
        });

        const log = await logExecutionEvent({
          title: `${eventId} — ${workflow.key} — blocked`,
          timestamp: requestedAt,
          actor,
          action: "execute_workflow",
          resourceName: workflow.name,
          resourceId: workflow.id,
          environment: workflow.environment,
          policyDecision: blockedPolicy.decision,
          approval: "manual_required",
          status: "blocked",
          riskLevel: blockedPolicy.riskLevel,
          inputPayload: { workflowId, workflowKey, simulate },
          outputPayload: simResult,
          notes: blockedPolicy.reason
        });

        return formatResult({ ...simResult, ledger: log });
      }

      // ── Ejecución real vía webhook (lógica v0.5 intacta) ──
      const startedAt = nowIso();
      const startTime = Date.now();

      const opened = await logExecutionEvent({
        title: `${eventId} — ${workflow.key} — running`,
        timestamp: requestedAt,
        actor,
        action: "execute_workflow",
        resourceName: workflow.name,
        resourceId: workflow.id,
        environment: workflow.environment,
        policyDecision: policy.decision,
        approval: policy.requiresApproval ? "manual_required" : "automatic",
        status: "running",
        riskLevel: policy.riskLevel,
        inputPayload: { workflowId, workflowKey, simulate },
        notes: "Execution in progress."
      });

      const ledgerEventId = opened.ledgerEventId || null;

      try {
        const webhookUrl = buildN8nWebhookUrl(workflow.webhookPath);

        const result = await postJson(webhookUrl, {
          source: "Notion AI via AETHER n8n MCP",
          workflowKey: workflow.key,
          workflowId: workflow.id,
          workflowName: workflow.name,
          environment: workflow.environment,
          milestone: "AETHER MCP v0.6 governed execution",
          eventId,
          requestedAt: startedAt
        });

        const finishedAt = nowIso();
        const durationMs = Date.now() - startTime;

        const execResult = createExecutionResult({
          eventId, actor, action, workflow, policy,
          startedAt, finishedAt, durationMs,
          status: "success", result, error: null
        });

        const closed = await logExecutionEvent({
          title: `${eventId} — ${workflow.key} — success`,
          timestamp: requestedAt,
          actor,
          action: "execute_workflow",
          resourceName: workflow.name,
          resourceId: workflow.id,
          environment: workflow.environment,
          policyDecision: policy.decision,
          approval: policy.requiresApproval ? "manual_required" : "automatic",
          status: "success",
          riskLevel: policy.riskLevel,
          durationMs,
          inputPayload: { workflowId, workflowKey, simulate },
          outputPayload: result,
          notes: "Logged automáticamente por AETHER MCP v0.6.0"
        }, ledgerEventId);

        return formatResult({
          ...execResult,
          ledger: {
            logged: opened.logged && closed.logged,
            ledgerEventId,
            notionPageUrl: opened.notionPageUrl || null,
            error: opened.error || closed.error || null
          }
        });
      } catch (error) {
        const finishedAt = nowIso();
        const durationMs = Date.now() - startTime;

        const execResult = createExecutionResult({
          eventId, actor, action, workflow, policy,
          startedAt, finishedAt, durationMs,
          status: "failed", result: null,
          error: { message: error.message }
        });

        const closed = await logExecutionEvent({
          title: `${eventId} — ${workflow.key} — failed`,
          timestamp: requestedAt,
          actor,
          action: "execute_workflow",
          resourceName: workflow.name,
          resourceId: workflow.id,
          environment: workflow.environment,
          policyDecision: policy.decision,
          approval: policy.requiresApproval ? "manual_required" : "automatic",
          status: "failed",
          riskLevel: policy.riskLevel,
          durationMs,
          inputPayload: { workflowId, workflowKey, simulate },
          error: error.message,
          notes: "Execution threw an error; see Error field."
        }, ledgerEventId);

        return formatResult({
          ...execResult,
          ledger: {
            logged: opened.logged && closed.logged,
            ledgerEventId,
            notionPageUrl: opened.notionPageUrl || null,
            error: opened.error || closed.error || null
          }
        });
      }
    }
  );

  return server;
}

const app = express();

const transports = {};

app.get("/", (req, res) => {
  res.json(publicStatus());
});

app.get("/health", (req, res) => {
  res.json(publicStatus());
});

app.get("/mcp", requireAuth, async (req, res) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;

  res.on("close", () => {
    delete transports[transport.sessionId];
  });

  const server = createServer();
  await server.connect(transport);
});

app.post(
  "/messages",
  requireAuth,
  express.json({ limit: "10mb" }),
  async (req, res) => {
    const sessionId = req.query.sessionId;
    const transport = transports[sessionId];

    if (!transport) {
      return res.status(400).send("No transport found for sessionId");
    }

    await transport.handlePostMessage(req, res, req.body);
  }
);

app.listen(PORT, () => {
  console.log(`${SERVER_NAME} SSE server running on port ${PORT}`);
});

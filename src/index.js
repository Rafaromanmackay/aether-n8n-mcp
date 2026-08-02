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
const SERVER_VERSION = "0.4.0";

const SANDBOX_WORKFLOW_ID = "PUvD2zLvDp9kBNQt";
const SANDBOX_WEBHOOK_PATH = "/webhook/aether-mcp-sandbox-execute";

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

function publicStatus() {
  return {
    name: SERVER_NAME,
    status: "ok",
    version: SERVER_VERSION,
    mcpEndpoint: "/mcp",
    transport: "sse",
    auth: "bearer",
    tools: TOOL_NAMES,
    sandbox: {
      workflowId: SANDBOX_WORKFLOW_ID,
      webhookPath: SANDBOX_WEBHOOK_PATH,
      webhookBaseUrlConfigured: Boolean(N8N_WEBHOOK_BASE_URL)
    }
  };
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
    "Execute an n8n workflow by ID. Currently restricted to the sandbox workflow via webhook.",
    {
      workflowId: z.string().describe("The n8n workflow ID.")
    },
    async ({ workflowId }) => {
      if (workflowId !== SANDBOX_WORKFLOW_ID) {
        throw new Error(
          `execute_workflow is currently restricted to sandbox workflow ${SANDBOX_WORKFLOW_ID}. Refusing to execute workflow ${workflowId}.`
        );
      }

      const webhookUrl = buildN8nWebhookUrl(SANDBOX_WEBHOOK_PATH);

      const result = await postJson(webhookUrl, {
        source: "Notion AI via AETHER n8n MCP",
        workflowId,
        milestone: "Hito 2B sandbox webhook execution",
        requestedAt: new Date().toISOString()
      });

      return formatResult({
        ok: true,
        workflowId,
        executionMode: "webhook",
        webhookUrl,
        result
      });
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

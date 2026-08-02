import express from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";

const PORT = process.env.PORT || 3000;
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;

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
  if (!N8N_API_URL) {
    throw new Error("Missing N8N_API_URL");
  }

  if (!N8N_API_KEY) {
    throw new Error("Missing N8N_API_KEY");
  }

  if (!MCP_AUTH_TOKEN) {
    throw new Error("Missing MCP_AUTH_TOKEN");
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

function buildN8nUrl(path) {
  const baseUrl = N8N_API_URL.replace(/\/+$/, "");
  const cleanPath = path.startsWith("/") ? path : `/${path}`;

  return `${baseUrl}${cleanPath}`;
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

  const text = await response.text();

  let data;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = { raw: text };
  }

  if (!response.ok) {
    throw new Error(
      `n8n API error ${response.status}: ${JSON.stringify(data)}`
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

function createServer() {
  const server = new McpServer({
    name: "aether-n8n-mcp",
    version: "0.3.0"
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
    "Execute an n8n workflow by ID. Use only on sandbox workflows unless explicitly approved.",
    {
      workflowId: z.string().describe("The n8n workflow ID.")
    },
    async ({ workflowId }) => {
      const result = await n8nRequest(`/workflows/${workflowId}/execute`, {
        method: "POST",
        body: JSON.stringify({})
      });

      return formatResult(result);
    }
  );

  return server;
}

const app = express();

const transports = {};

app.get("/", (req, res) => {
  res.json({
    name: "aether-n8n-mcp",
    status: "ok",
    version: "0.3.0",
    mcpEndpoint: "/mcp",
    transport: "sse",
    auth: "bearer",
    tools: TOOL_NAMES
  });
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
  console.log(`AETHER n8n MCP SSE server running on port ${PORT}`);
});

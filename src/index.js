import express from "express";

const app = express();
app.use(express.json({ limit: "10mb" }));

const PORT = process.env.PORT || 3000;
const N8N_API_URL = process.env.N8N_API_URL;
const N8N_API_KEY = process.env.N8N_API_KEY;

function requireEnv() {
  if (!N8N_API_URL) {
    throw new Error("Missing N8N_API_URL");
  }
  if (!N8N_API_KEY) {
    throw new Error("Missing N8N_API_KEY");
  }
}

async function n8nRequest(path, options = {}) {
  requireEnv();

  const url = `${N8N_API_URL}${path}`;

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

function toolResponse(data) {
  return {
    content: [
      {
        type: "text",
        text: JSON.stringify(data, null, 2)
      }
    ]
  };
}

const tools = [
  {
    name: "list_workflows",
    description: "List n8n workflows from the connected n8n instance.",
    inputSchema: {
      type: "object",
      properties: {
        limit: {
          type: "number",
          description: "Maximum number of workflows to return."
        }
      }
    }
  },
  {
    name: "get_workflow",
    description: "Get a full n8n workflow by ID.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The n8n workflow ID."
        }
      },
      required: ["workflowId"]
    }
  },
  {
    name: "update_workflow",
    description: "Update an existing n8n workflow. Use carefully.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The n8n workflow ID."
        },
        workflow: {
          type: "object",
          description: "The full updated workflow payload."
        }
      },
      required: ["workflowId", "workflow"]
    }
  },
  {
    name: "activate_workflow",
    description: "Activate an n8n workflow by ID.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The n8n workflow ID."
        }
      },
      required: ["workflowId"]
    }
  },
  {
    name: "deactivate_workflow",
    description: "Deactivate an n8n workflow by ID.",
    inputSchema: {
      type: "object",
      properties: {
        workflowId: {
          type: "string",
          description: "The n8n workflow ID."
        }
      },
      required: ["workflowId"]
    }
  }
];

app.get("/", (req, res) => {
  res.json({
    name: "aether-n8n-mcp",
    status: "ok",
    mcpEndpoint: "/mcp",
    tools: tools.map((tool) => tool.name)
  });
});

app.post("/mcp", async (req, res) => {
  try {
    const { jsonrpc, id, method, params } = req.body || {};

    if (method === "initialize") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion: "2024-11-05",
          capabilities: {
            tools: {}
          },
          serverInfo: {
            name: "aether-n8n-mcp",
            version: "0.1.0"
          }
        }
      });
    }

    if (method === "tools/list") {
      return res.json({
        jsonrpc: "2.0",
        id,
        result: {
          tools
        }
      });
    }

    if (method === "tools/call") {
      const toolName = params?.name;
      const args = params?.arguments || {};

      let result;

      if (toolName === "list_workflows") {
        const limit = args.limit || 50;
        result = await n8nRequest(`/workflows?limit=${limit}`);
      } else if (toolName === "get_workflow") {
        result = await n8nRequest(`/workflows/${args.workflowId}`);
      } else if (toolName === "update_workflow") {
        result = await n8nRequest(`/workflows/${args.workflowId}`, {
          method: "PUT",
          body: JSON.stringify(args.workflow)
        });
      } else if (toolName === "activate_workflow") {
        result = await n8nRequest(`/workflows/${args.workflowId}/activate`, {
          method: "POST"
        });
      } else if (toolName === "deactivate_workflow") {
        result = await n8nRequest(`/workflows/${args.workflowId}/deactivate`, {
          method: "POST"
        });
      } else {
        throw new Error(`Unknown tool: ${toolName}`);
      }

      return res.json({
        jsonrpc: "2.0",
        id,
        result: toolResponse(result)
      });
    }

    return res.json({
      jsonrpc: "2.0",
      id,
      error: {
        code: -32601,
        message: `Method not found: ${method}`
      }
    });
  } catch (error) {
    return res.json({
      jsonrpc: "2.0",
      id: req.body?.id,
      error: {
        code: -32000,
        message: error.message
      }
    });
  }
});

app.listen(PORT, () => {
  console.log(`AETHER n8n MCP server running on port ${PORT}`);
});

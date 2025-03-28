import express, { Request, Response, NextFunction } from "express";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import { z } from "zod";
// Define the base URL for the National Weather Service (NWS) API
// and the user agent string for API requests
const NWS_API_BASE = "https://api.weather.gov";
const USER_AGENT = "weather-app/1.0";

// Bearer Token 配置
const ACCESS_TOKEN = process.env.ACCESS_TOKEN || "your-default-token";

// 权限验证中间件
const authMiddleware = (req: Request, res: Response, next: NextFunction): void => {
  const authHeader = req.headers.authorization;
  
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Missing or invalid Bearer token' 
    });
    return;
  }
  
  const token = authHeader.split(' ')[1];
  
  if (token !== ACCESS_TOKEN) {
    res.status(401).json({ 
      error: 'Unauthorized',
      message: 'Invalid token'
    });
    return;
  }
  
  next();
};

// 创建 MCP 服务器实例
const server = new McpServer({
  name: "weather",
  version: "1.0.0",
  capabilities: {
    resources: {},
    tools: {},
  },
});

// 用于发送 NWS API 请求的辅助函数
async function makeNWSRequest<T>(url: string): Promise<T | null> {
  const headers = {
    "User-Agent": USER_AGENT,
    Accept: "application/geo+json",
  };

  try {
    const response = await fetch(url, { headers });
    if (!response.ok) {
      throw new Error(`HTTP error! status: ${response.status}`);
    }
    return (await response.json()) as T;
  } catch (error) {
    console.error("Error making NWS request:", error);
    return null;
  }
}

// 定义天气警报特征的接口
interface AlertFeature {
  properties: {
    event?: string; // 事件类型
    areaDesc?: string; // 区域描述
    severity?: string; // 严重程度
    status?: string; // 状态
    headline?: string; // 标题
  };
}

// 格式化警报数据
function formatAlert(feature: AlertFeature): string {
  const props = feature.properties;
  return [
    `Event: ${props.event || "Unknown"}`,
    `Area: ${props.areaDesc || "Unknown"}`,
    `Severity: ${props.severity || "Unknown"}`,
    `Status: ${props.status || "Unknown"}`,
    `Headline: ${props.headline || "No headline"}`,
    "---",
  ].join("\n");
}

// 定义天气预报周期的接口
interface ForecastPeriod {
  name?: string; // 时段名称
  temperature?: number; // 温度
  temperatureUnit?: string; // 温度单位
  windSpeed?: string; // 风速
  windDirection?: string; // 风向
  shortForecast?: string; // 简短预报
}

// 定义 API 响应的接口
interface AlertsResponse {
  features: AlertFeature[];
}

interface PointsResponse {
  properties: {
    forecast?: string;
  };
}

interface ForecastResponse {
  properties: {
    periods: ForecastPeriod[];
  };
}

// 注册获取天气警报的工具
server.tool(
  "get-alerts",
  "Get weather alerts for a state",
  {
    state: z.string().length(2).describe("Two-letter state code (e.g. CA, NY)"),
  },
  async ({ state }) => {
    const stateCode = state.toUpperCase();
    const alertsUrl = `${NWS_API_BASE}/alerts?area=${stateCode}`;
    const alertsData = await makeNWSRequest<AlertsResponse>(alertsUrl);

    // 如果获取数据失败，返回错误信息
    if (!alertsData) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve alerts data",
          },
        ],
      };
    }

    // 如果没有警报，返回相应信息
    const features = alertsData.features || [];
    if (features.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: `No active alerts for ${stateCode}`,
          },
        ],
      };
    }

    // 格式化并返回警报信息
    const formattedAlerts = features.map(formatAlert);
    const alertsText = `Active alerts for ${stateCode}:\n\n${formattedAlerts.join(
      "\n"
    )}`;

    return {
      content: [
        {
          type: "text",
          text: alertsText,
        },
      ],
    };
  }
);

// 注册获取天气预报的工具
server.tool(
  "get-forecast",
  "Get weather forecast for a location",
  {
    latitude: z.number().min(-90).max(90).describe("Latitude of the location"),
    longitude: z
      .number()
      .min(-180)
      .max(180)
      .describe("Longitude of the location"),
  },
  async ({ latitude, longitude }) => {
    // 获取网格点数据
    const pointsUrl = `${NWS_API_BASE}/points/${latitude.toFixed(
      4
    )},${longitude.toFixed(4)}`;
    const pointsData = await makeNWSRequest<PointsResponse>(pointsUrl);

    // 如果获取网格点数据失败，返回错误信息
    if (!pointsData) {
      return {
        content: [
          {
            type: "text",
            text: `Failed to retrieve grid point data for coordinates: ${latitude}, ${longitude}. This location may not be supported by the NWS API (only US locations are supported).`,
          },
        ],
      };
    }

    // 获取预报 URL
    const forecastUrl = pointsData.properties?.forecast;
    if (!forecastUrl) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to get forecast URL from grid point data",
          },
        ],
      };
    }

    // 获取预报数据
    const forecastData = await makeNWSRequest<ForecastResponse>(forecastUrl);
    if (!forecastData) {
      return {
        content: [
          {
            type: "text",
            text: "Failed to retrieve forecast data",
          },
        ],
      };
    }

    // 检查是否有预报时段数据
    const periods = forecastData.properties?.periods || [];
    if (periods.length === 0) {
      return {
        content: [
          {
            type: "text",
            text: "No forecast periods available",
          },
        ],
      };
    }

    // 格式化预报时段数据
    const formattedForecast = periods.map((period: ForecastPeriod) =>
      [
        `${period.name || "Unknown"}:`,
        `Temperature: ${period.temperature || "Unknown"}°${
          period.temperatureUnit || "F"
        }`,
        `Wind: ${period.windSpeed || "Unknown"} ${period.windDirection || ""}`,
        `${period.shortForecast || "No forecast available"}`,
        "---",
      ].join("\n")
    );

    // 返回格式化后的预报信息
    const forecastText = `Forecast for ${latitude}, ${longitude}:\n\n${formattedForecast.join(
      "\n"
    )}`;

    return {
      content: [
        {
          type: "text",
          text: forecastText,
        },
      ],
    };
  }
);

// 主函数：启动服务器
async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error("Weather MCP Server running on stdio");
}

// 错误处理：如果主函数发生错误，打印错误信息并退出
main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});

const app = express();

// to support multiple simultaneous connections we have a lookup object from
// sessionId to transport
const transports: { [sessionId: string]: SSEServerTransport } = {};

// 添加权限中间件到 SSE 路由
app.get("/sse", async (_: Request, res: Response) => {
  const transport = new SSEServerTransport("/messages", res);
  transports[transport.sessionId] = transport;
  res.on("close", () => {
    delete transports[transport.sessionId];
  });
  await server.connect(transport);
});

// 添加权限中间件到消息路由
app.post("/messages", async (req: Request, res: Response) => {
  const sessionId = req.query.sessionId as string;
  const transport = transports[sessionId];
  if (transport) {
    await transport.handlePostMessage(req, res);
  } else {
    res.status(400).send("No transport found for sessionId");
  }
});

// 启动服务器时输出提示信息
app.listen(3001, () => {
  console.log(`Server is running on port 3001`);
  console.log(`Bearer Token authentication is enabled`);
});

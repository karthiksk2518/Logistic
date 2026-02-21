import express, { type Request, Response, NextFunction } from "express";
import { registerRoutes } from "./routes";
import { serveStatic } from "./static";
import { createServer } from "http";
import { setupMarketplaceWebSocket } from "./websocket-marketplace";
import { registerObjectStorageRoutes } from "./replit_integrations/object_storage";
import { storage } from "./storage";
import path from "path";
import fs from "fs";

const app = express();

// Serve AI-generated assets from attached_assets folder (for both dev and prod)
const assetsPath = path.resolve(process.cwd(), "attached_assets");
if (fs.existsSync(assetsPath)) {
  app.use("/assets", express.static(assetsPath, {
    maxAge: '1d',
    etag: true,
    lastModified: true,
  }));
}

const httpServer = createServer(app);

setupMarketplaceWebSocket(httpServer);

declare module "http" {
  interface IncomingMessage {
    rawBody: unknown;
  }
}

app.use(
  express.json({
    limit: '50mb',
    verify: (req, _res, buf) => {
      req.rawBody = buf;
    },
  }),
);

app.use(express.urlencoded({ extended: false, limit: '50mb' }));

export function log(message: string, source = "express") {
  const formattedTime = new Date().toLocaleTimeString("en-US", {
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  });

  console.log(`${formattedTime} [${source}] ${message}`);
}

app.use((req, res, next) => {
  const start = Date.now();
  const path = req.path;
  let capturedJsonResponse: Record<string, any> | undefined = undefined;

  const originalResJson = res.json;
  res.json = function (bodyJson, ...args) {
    capturedJsonResponse = bodyJson;
    return originalResJson.apply(res, [bodyJson, ...args]);
  };

  res.on("finish", () => {
    const duration = Date.now() - start;
    if (path.startsWith("/api")) {
      let logLine = `${req.method} ${path} ${res.statusCode} in ${duration}ms`;
      if (capturedJsonResponse) {
        logLine += ` :: ${JSON.stringify(capturedJsonResponse)}`;
      }

      log(logLine);
    }
  });

  next();
});

(async () => {
  // Run data migration to fix any missing load numbers or pickup IDs
  await storage.runDataMigration();
  
  // Note: Object storage routes are registered after main routes
  // to ensure session middleware is available
  await registerRoutes(httpServer, app);
  
  // Register object storage routes (after session middleware)
  registerObjectStorageRoutes(app);

  app.use((err: any, _req: Request, res: Response, _next: NextFunction) => {
    const status = err.status || err.statusCode || 500;
    const message = err.message || "Internal Server Error";

    res.status(status).json({ message });
    throw err;
  });

  // importantly only setup vite in development and after
  // setting up all the other routes so the catch-all route
  // doesn't interfere with the other routes
  if (process.env.NODE_ENV === "production") {
    serveStatic(app);
  } else {
    // In separated architecture, we don't run Vite middleware in backend
    // const { setupVite } = await import("./vite");
    // await setupVite(httpServer, app);
    log("Running in development mode (API Only)");
  }

  // ALWAYS serve the app on the port specified in the environment variable PORT
  // Other ports are firewalled. Default to 5000 if not specified.
  // this serves both the API and the client.
  // It is the only port that is not firewalled.
  const port = parseInt(process.env.PORT || "5000", 10);
  
  const getListenOptions = () => {
    const options: { port: number; host: string; reusePort?: boolean } = {
      port,
      host: "0.0.0.0",
    };
    if (process.platform !== "win32") {
      options.reusePort = true;
    }
    return options;
  };

  const startServer = () => {
    httpServer.listen(getListenOptions(), () => {
      log(`serving on port ${port}`);
    });
  };

  httpServer.on('error', (err: NodeJS.ErrnoException) => {
    if (err.code === 'EADDRINUSE') {
      log(`Port ${port} is in use, waiting for it to become available...`);
      setTimeout(() => {
        httpServer.close();
        startServer();
      }, 1000);
    } else {
      console.error('Server error:', err);
      process.exit(1);
    }
  });

  // Graceful shutdown handler
  const shutdown = () => {
    log('Shutting down gracefully...');
    httpServer.close(() => {
      log('Server closed');
      process.exit(0);
    });
    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
      log('Forcing shutdown');
      process.exit(1);
    }, 5000);
  };

  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);

  startServer();
})();

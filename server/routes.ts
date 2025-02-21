import type { Express } from "express";
import { createServer, type Server } from "http";
import path from "path";
import express from "express";

export async function registerRoutes(app: Express): Promise<Server> {
  // Serve static files from the _site directory (Jekyll's output)
  app.use(express.static(path.join(process.cwd(), '_site')));

  // Fallback route for all other requests
  app.get('*', (req, res) => {
    res.sendFile(path.join(process.cwd(), '_site', 'index.html'));
  });

  const httpServer = createServer(app);
  return httpServer;
}
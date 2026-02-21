import type { Express, Request, Response, NextFunction } from "express";
import { z } from "zod";
import { verifyPan } from "./surepass-service";

const requireAuth = (req: Request, res: Response, next: NextFunction) => {
  if (!req.session?.userId) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
};

const panSchema = z.object({
  pan_number: z.string().min(5),
  request_ref: z.string().optional(),
});

export function registerSurepassRoutes(app: Express) {
  app.post("/api/kyc/pan", requireAuth, async (req, res) => {
    try {
      const payload = panSchema.parse(req.body);
      const response = await verifyPan({
        panNumber: payload.pan_number,
        userId: req.session?.userId,
        requestRef: payload.request_ref,
      });
      res.json(response);
    } catch (error: any) {
      res.status(500).json({ error: "Surepass PAN verification failed" });
    }
  });
}
